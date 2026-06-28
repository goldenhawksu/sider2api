"""sider2api 测试框架 - 可复用的 HTTP 客户端与解析工具.

把 API_Test.py / test/local_test.py 中已验证的请求与 SSE 解析逻辑收敛到这里,
测试文件只表达"期望行为", 不重复底层 HTTP 细节。
"""
import json
import time
from dataclasses import dataclass, asdict
from typing import Iterator, Optional

import requests

import config


class ApiClient:
    """对 sider2api 实例的轻量封装. 支持远端部署或本地 localhost。

    auth 参数约定 (chat/image/get):
      True / None -> 使用默认 token
      False       -> 不带 Authorization 头 (测缺失鉴权)
      str         -> 使用指定的 token 字符串 (测错误 token)
    """

    def __init__(self, base_url: str, token: str, read_timeout: float = config.READ_TIMEOUT):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.read_timeout = read_timeout
        self.session = requests.Session()

    # ---- 内部工具 ----
    def _url(self, path: str) -> str:
        return self.base_url + path

    def _timeout(self):
        return (config.CONNECT_TIMEOUT, self.read_timeout)

    def _headers(self, auth=True, session_id: Optional[str] = None, extra: Optional[dict] = None) -> dict:
        h = {"Content-Type": "application/json"}
        if auth is not False:
            tok = auth if isinstance(auth, str) else self.token
            if tok:
                h["Authorization"] = f"Bearer {tok}"
        if session_id:
            h["X-Session-ID"] = session_id
        if extra:
            h.update(extra)
        return h

    # ---- 端点 ----
    def get(self, path: str, auth=True):
        return self.session.get(self._url(path), headers=self._headers(auth=auth), timeout=self._timeout())

    def options(self, path: str):
        return self.session.options(self._url(path), headers=self._headers(auth=False), timeout=self._timeout())

    def chat(self, model, messages, stream=False, session_id=None, auth=True, **extra_body):
        body = {"model": model, "messages": messages, "stream": stream}
        body.update(extra_body)
        return self.session.post(
            self._url("/v1/chat/completions"),
            headers=self._headers(auth=auth, session_id=session_id),
            json=body, stream=stream, timeout=self._timeout(),
        )

    def image(self, prompt, auth=True, **extra_body):
        return self.image_raw({"prompt": prompt, **extra_body}, auth=auth)

    def image_raw(self, body: dict, auth=True):
        return self.session.post(
            self._url("/v1/images/generations"),
            headers=self._headers(auth=auth), json=body, timeout=self._timeout(),
        )

    # ---- 便捷 ----
    def list_model_ids(self):
        r = self.get("/v1/models", auth=False)
        r.raise_for_status()
        return [m["id"] for m in r.json().get("data", [])]


# ---------------- 响应解析 ----------------

def extract_content(resp_json: dict) -> str:
    """从 OpenAI 非流式响应里取助手文本。"""
    try:
        return resp_json["choices"][0]["message"]["content"] or ""
    except (KeyError, IndexError, TypeError):
        return ""


def iter_sse(resp) -> Iterator[dict]:
    """逐块解析 SSE 'data: {json}' 行, 跳过 [DONE] 与无法解析的行。"""
    resp.encoding = "utf-8"  # SSE 为 UTF-8, 避免 CJK 乱码
    for raw in resp.iter_lines(decode_unicode=True):
        if not raw:
            continue
        line = raw.strip()
        if not line.startswith("data:"):
            continue
        payload = line[len("data:"):].strip()
        if payload == "[DONE]":
            break
        try:
            yield json.loads(payload)
        except json.JSONDecodeError:
            continue


def _delta_piece(obj: dict):
    try:
        return obj["choices"][0].get("delta", {}).get("content")
    except (KeyError, IndexError, TypeError):
        return None


def _finish_reason(obj: dict):
    try:
        return obj["choices"][0].get("finish_reason")
    except (KeyError, IndexError, TypeError):
        return None


def parse_stream(resp) -> dict:
    """消费一个流式响应, 返回累计内容/块数/finish_reason/done (不含 TTFT 计时)。

    done 表示是否收到 [DONE] 终止信号。
    注: 当前 deno_pro 不发送 finish_reason='stop' 终止块, 仅以 [DONE] 结束。
    """
    resp.encoding = "utf-8"
    pieces, chunks, finish, done = [], 0, None, False
    for raw in resp.iter_lines(decode_unicode=True):
        if not raw:
            continue
        line = raw.strip()
        if not line.startswith("data:"):
            continue
        payload = line[len("data:"):].strip()
        if payload == "[DONE]":
            done = True
            break
        try:
            obj = json.loads(payload)
        except json.JSONDecodeError:
            continue
        fr = _finish_reason(obj)
        if fr:
            finish = fr
        piece = _delta_piece(obj)
        if piece:
            pieces.append(piece)
            chunks += 1
    return {"content": "".join(pieces), "chunks": chunks, "finish_reason": finish, "done": done}


def retry(call, ok, attempts: int = 3, delay: float = 4.0):
    """重试 call() 直到 ok(result) 为真或次数用尽; 返回最后一次 result。

    用于上游图像生成等偶发失败的场景 (背靠背连发易触发上游瞬时抖动)。
    """
    result = None
    for i in range(attempts):
        result = call()
        try:
            if ok(result):
                return result
        except Exception:  # noqa: BLE001
            pass
        if i < attempts - 1:
            time.sleep(delay)
    return result


# ---------------- 性能度量 ----------------

@dataclass
class PerfMetric:
    label: str
    model: str
    mode: str            # non-stream | stream
    total_s: float
    chars: int
    ttft_s: Optional[float] = None
    chunks: int = 0
    chars_per_s: Optional[float] = None  # 流式吞吐 (字符/秒, 作为 token/秒的近似代理)

    def as_dict(self):
        return asdict(self)


def measure_chat(client: ApiClient, model, messages, stream: bool, label: str) -> PerfMetric:
    """带计时地发起一次对话, 返回 PerfMetric。TTFT 从请求发出到首个内容块。"""
    t0 = time.perf_counter()
    resp = client.chat(model, messages, stream=stream)
    if resp.status_code != 200:
        raise AssertionError(f"{model} {label} -> HTTP {resp.status_code}: {resp.text[:200]}")
    if not stream:
        total = time.perf_counter() - t0
        content = extract_content(resp.json())
        return PerfMetric(label, model, "non-stream", round(total, 3), len(content))

    ttft = None
    pieces, chunks = [], 0
    for obj in iter_sse(resp):
        piece = _delta_piece(obj)
        if piece:
            if ttft is None:
                ttft = time.perf_counter() - t0
            pieces.append(piece)
            chunks += 1
    total = time.perf_counter() - t0
    content = "".join(pieces)
    cps = None
    if ttft is not None and total > ttft:
        cps = round(len(content) / (total - ttft), 1)
    return PerfMetric(
        label, model, "stream", round(total, 3), len(content),
        ttft_s=round(ttft, 3) if ttft is not None else None, chunks=chunks, chars_per_s=cps,
    )
