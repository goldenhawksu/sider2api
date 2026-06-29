"""直连上游 sider.ai 的探针客户端 (probe infrastructure)。

这是「上游能力探针」的基础设施: 绕过 deno_pro.ts, 用与其一致的协议直接调用
sider.ai, 用于发现/跟踪上游真实能力。请求模板与 headers 对齐 deno_pro.ts
(模拟 sider 浏览器插件), 协议细节见 deno_pro.ts 的 handleChatCompletion。

凭证: 从 .env 或环境变量读取 SIDER_AUTH_TOKEN (绝不打印 token 值)。
"""
import copy
import json
import os
import time
from dataclasses import dataclass, field
from typing import Optional

import requests

UPSTREAM_ENDPOINT = "https://sider.ai/api/chat/v1/completions"

# 与 deno_pro.ts DEFAULT_REQUEST_TEMPLATE 对齐 (模拟插件抓包数据)
DEFAULT_TEMPLATE = {
    "stream": True,
    "cid": "",
    "model": "sider",
    "filter_search_history": False,
    "from": "chat",
    "chat_models": [],
    "think_mode": {"enable": False},
    "quote": None,
    "prompt_templates": [{"key": "artifacts", "attributes": {"lang": "original"}}],
    "extra_info": {
        "origin_url": "chrome-extension://dhoenijjpgpeimemopealfcbiecgceod/standalone.html?from=sidebar",
        "origin_title": "Sider",
    },
    "customize_instructions": {"enable": True},
}

# 与 deno_pro.ts 对齐的插件伪装 headers
_PLUGIN_HEADERS = {
    "Content-Type": "application/json",
    "Accept": "*/*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Origin": "chrome-extension://dhoenijjpgpeimemopealfcbiecgceod",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "X-App-Name": "ChitChat_Edge_Ext",
    "X-App-Version": "5.21.2",
}


def load_token() -> Optional[str]:
    """从环境变量或 .env 读取 SIDER_AUTH_TOKEN。"""
    tok = os.environ.get("SIDER_AUTH_TOKEN")
    if tok:
        return tok.strip()
    # 向上查找 .env (支持从仓库根或 test/ 运行)
    here = os.path.dirname(os.path.abspath(__file__))
    for d in (os.getcwd(), here, os.path.dirname(here)):
        path = os.path.join(d, ".env")
        if os.path.exists(path):
            for line in open(path, encoding="utf-8"):
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    if k.strip() == "SIDER_AUTH_TOKEN":
                        return v.strip().strip('"').strip("'")
    return None


@dataclass
class ProbeResult:
    """一次上游调用的结构化解析结果。"""
    http_status: int = 0
    error_code: Optional[int] = None      # 顶层非 0 的 code
    error_msg: str = ""
    event_types: dict = field(default_factory=dict)   # type -> count
    text: str = ""
    reasoning: str = ""                    # think 模式的 reasoning_content 累积
    files: list = field(default_factory=list)         # file 事件: {type,url,mimetype,width,height,...}
    tool_calls: list = field(default_factory=list)    # tool_call 状态序列
    tool_names: set = field(default_factory=set)      # tool_call.name 去重集 (内置工具名挖掘)
    tool_details: list = field(default_factory=list)  # tool_call 明细: {name,status,arguments}
    model_echo: set = field(default_factory=set)      # data.model 回显
    credits: list = field(default_factory=list)       # credit_info 列表
    ttft_s: Optional[float] = None
    total_s: float = 0.0
    raw_first: list = field(default_factory=list)      # 前几行原始 payload (调试)
    transport_error: str = ""                          # 网络/超时等异常

    @property
    def ok(self) -> bool:
        return self.http_status == 200 and self.error_code in (None, 0) and not self.transport_error


class UpstreamClient:
    """直连 sider.ai 的探针客户端。"""

    def __init__(self, token: str, timeout: float = 60.0, min_interval: float = 5.0):
        self.token = token
        self.timeout = timeout
        self.min_interval = min_interval   # 两次上游请求之间的最小间隔(秒), 防 IP 级限流
        self.session = requests.Session()
        self._last_start = None

    def _throttle(self):
        """确保相邻两次上游请求至少间隔 min_interval 秒。"""
        if self.min_interval > 0 and self._last_start is not None:
            wait = self.min_interval - (time.perf_counter() - self._last_start)
            if wait > 0:
                time.sleep(wait)
        self._last_start = time.perf_counter()

    def _headers(self) -> dict:
        return {**_PLUGIN_HEADERS, "Authorization": f"Bearer {self.token}"}

    def build_body(self, prompt=None, model="sider", stream=True, think=False,
                   tools=None, multi_content=None, overrides=None) -> dict:
        body = copy.deepcopy(DEFAULT_TEMPLATE)
        body["model"] = model
        body["stream"] = stream
        body["think_mode"] = {"enable": think}
        if multi_content is not None:
            body["multi_content"] = multi_content
        elif prompt is not None:
            body["multi_content"] = [{"type": "text", "text": prompt, "user_input_text": prompt}]
        if tools is not None:
            body["tools"] = tools
        if overrides:
            body.update(overrides)
        return body

    def send(self, prompt=None, model="sider", stream=True, think=False,
             tools=None, multi_content=None, overrides=None, max_seconds=None) -> ProbeResult:
        """发送一次上游请求并解析 SSE 流, 返回 ProbeResult。

        max_seconds: 流读取的软上限 (图像/think 较慢, 默认用 self.timeout)。
        """
        body = self.build_body(prompt, model, stream, think, tools, multi_content, overrides)
        cap = max_seconds or self.timeout
        res = ProbeResult()
        self._throttle()   # 限频: 防止高频直连触发 sider.ai IP 级封禁
        t0 = time.perf_counter()
        try:
            r = self.session.post(UPSTREAM_ENDPOINT, headers=self._headers(),
                                  json=body, stream=True, timeout=(15, self.timeout))
        except Exception as e:  # noqa: BLE001
            res.transport_error = f"{type(e).__name__}: {e}"
            res.total_s = round(time.perf_counter() - t0, 3)
            return res

        res.http_status = r.status_code
        r.encoding = "utf-8"
        if r.status_code != 200:
            # 上游错误也可能走 HTTP 4xx + body {code,msg} (如超词 400+code:603),
            # 而非 SSE 流内 code; 两条通道都要解析。
            body_text = r.text
            res.error_msg = body_text[:300]
            try:
                obj = json.loads(body_text)
                if isinstance(obj, dict) and obj.get("code") not in (None, 0):
                    res.error_code = obj.get("code")
                    res.error_msg = obj.get("msg", body_text[:300])
            except json.JSONDecodeError:
                pass
            res.total_s = round(time.perf_counter() - t0, 3)
            return res

        for line in r.iter_lines(decode_unicode=True):
            if time.perf_counter() - t0 > cap:
                break
            if not line:
                continue
            s = line.strip()
            payload = s[5:].strip() if s.startswith("data:") else s
            if payload == "[DONE]":
                break
            if not payload:
                continue
            if len(res.raw_first) < 8:
                res.raw_first.append(payload[:200])
            try:
                obj = json.loads(payload)
            except json.JSONDecodeError:
                continue
            code = obj.get("code")
            if code not in (None, 0):
                res.error_code = code
                res.error_msg = obj.get("msg", "")
                continue
            d = obj.get("data")
            if not isinstance(d, dict):
                continue
            t = d.get("type")
            res.event_types[t] = res.event_types.get(t, 0) + 1
            if d.get("model"):
                res.model_echo.add(d["model"])
            if t == "text" and d.get("text"):
                if res.ttft_s is None:
                    res.ttft_s = round(time.perf_counter() - t0, 3)
                res.text += d["text"]
            elif t == "reasoning_content":
                rc = d.get("reasoning_content", {})
                if isinstance(rc, dict) and rc.get("text"):
                    res.reasoning += rc["text"]
            elif t == "file":
                f = d.get("file", {})
                img = f.get("image", {}) if isinstance(f.get("image"), dict) else {}
                res.files.append({"type": f.get("type"), "url": f.get("url", ""),
                                  "mimetype": f.get("mimetype"), "file_size": f.get("file_size"),
                                  "file_name": f.get("file_name"),
                                  "width": img.get("width"), "height": img.get("height")})
            elif t == "tool_call":
                tc = d.get("tool_call", {})
                res.tool_calls.append(tc.get("status") or tc)
                if isinstance(tc, dict):
                    if tc.get("name"):
                        res.tool_names.add(tc["name"])
                    res.tool_details.append({
                        "name": tc.get("name"), "status": tc.get("status"),
                        "arguments": (tc.get("arguments") or "")[:200],
                    })
            elif t == "credit_info":
                res.credits.append(d.get("credit_info"))
        res.total_s = round(time.perf_counter() - t0, 3)
        return res
