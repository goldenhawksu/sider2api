"""deno_pro.ts 优化项的本地 mock 集成回归测试。

这些用例不触达真实 Sider, 通过本地 SSE mock 上游验证转换、限速和错误映射契约。
"""
from __future__ import annotations

import json
import os
import socket
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit
from uuid import uuid4

import pytest
import requests


ROOT = Path(__file__).resolve().parents[1]
AUTH_TOKEN = "mock-deno-pro-token"


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _frame(payload: dict[str, Any]) -> bytes:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n".encode("utf-8")


def _done() -> bytes:
    return b"data: [DONE]\n\n"


def _message_start(seq: int) -> dict[str, Any]:
    return {
        "code": 0,
        "data": {
            "type": "message_start",
            "message_start": {
                "cid": f"mock-cid-{seq}",
                "assistant_message_id": f"mock-assistant-{seq}",
                "parent_message_id": f"mock-parent-{seq}",
            },
        },
    }


def _text(value: str) -> dict[str, Any]:
    return {"code": 0, "data": {"type": "text", "text": value}}


def _reasoning(value: str) -> dict[str, Any]:
    return {
        "code": 0,
        "data": {
            "type": "reasoning_content",
            "reasoning_content": {"text": value},
        },
    }


class MockSiderState:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.requests: list[dict[str, Any]] = []
        self.disconnected_prompts: list[str] = []

    def add(self, body: dict[str, Any]) -> int:
        with self._lock:
            self.requests.append(body)
            return len(self.requests)

    def snapshot(self) -> list[dict[str, Any]]:
        with self._lock:
            return list(self.requests)

    def mark_disconnected(self, prompt: str) -> None:
        with self._lock:
            self.disconnected_prompts.append(prompt)

    def disconnected_snapshot(self) -> list[str]:
        with self._lock:
            return list(self.disconnected_prompts)

    def clear(self) -> None:
        with self._lock:
            self.requests.clear()
            self.disconnected_prompts.clear()


def _prompt_from_sider_body(body: dict[str, Any]) -> str:
    parts = body.get("multi_content") or []
    texts = []
    for part in parts:
        if isinstance(part, dict):
            texts.append(str(part.get("text") or part.get("user_input_text") or ""))
    return "\n".join(texts)


def _scenario_frames(prompt: str, seq: int) -> tuple[list[bytes], float]:
    delay = 0.0
    if "MOCK_HTTP_500" in prompt:
        return [], delay
    if "MOCK_HANG_HEADERS" in prompt or "MOCK_HANG_BODY" in prompt:
        return [], delay
    if "MOCK_EMPTY_OK" in prompt:
        # HTTP 200 但只有终止符, 没有任何有效载荷 -> 绝不能算"上游调用成功"
        return [_done()], delay
    if "MOCK_SLOW_1135" in prompt:
        # 先占用上游槽位一段时间, 再回 1135: 用于验证排队中的请求醒来后会复检门控
        return [_frame({"code": 1135, "msg": "quota exhausted", "data": None}), _done()], 0.5
    if "MOCK_1135_MIN" in prompt:
        # 上游 1135 会明说恢复时间, 门控应按这个时间熔断而非按模型类型拍脑袋
        return [_frame({
            "code": 1135,
            "msg": "You've reached the current usage limit. This limit ensures fair use "
                   "for all users. Please try again after 1 minutes.",
            "data": None,
        }), _done()], delay
    if "MOCK_1135_SEC" in prompt:
        # 极短冷却, 供账号级判定用例使用, 避免污染同实例后续用例
        return [_frame({
            "code": 1135,
            "msg": "You've reached the current usage limit. Please try again after 2 seconds.",
            "data": None,
        }), _done()], delay
    if "MOCK_1135" in prompt:
        return [_frame({"code": 1135, "msg": "quota exhausted", "data": None}), _done()], delay
    if "MOCK_SLOW" in prompt:
        # 慢响应, 用于观察上游并发闸门的排队行为
        return [_frame(_message_start(seq)), _frame(_text("slow ok")), _done()], 0.6
    if "MOCK_1101" in prompt:
        return [_frame({"code": 1101, "msg": "busy", "data": None}), _done()], delay
    if "MOCK_603" in prompt:
        return [_frame({"code": 603, "msg": "too many words", "data": None}), _done()], delay
    if "MOCK_WARNING_AFTER_TEXT" in prompt:
        return [
            _frame(_message_start(seq)),
            _frame(_text("正文仍然保留")),
            _frame({"code": 1101, "msg": "late warning", "data": None}),
            _done(),
        ], delay
    if "MOCK_TERMINAL_AFTER_TEXT" in prompt:
        return [
            _frame(_message_start(seq)),
            _frame(_text("partial before failure")),
            _frame({"code": 9999, "msg": "terminal failure", "data": None}),
            _done(),
        ], delay
    if "MOCK_EOF_AFTER_TEXT" in prompt:
        return [_frame(_message_start(seq)), _frame(_text("partial before eof"))], delay
    if "MOCK_LONG_STREAM" in prompt:
        return [
            _frame(_message_start(seq)),
            *[_frame(_text(f"part-{i};")) for i in range(100)],
            _done(),
        ], delay
    if "MOCK_STREAM_STOP" in prompt:
        return [
            _frame(_message_start(seq)),
            _frame(_text("ab")),
            _frame(_text("cdST")),
            _frame(_text("OPtail")),
            _done(),
        ], delay
    if "MOCK_STOP" in prompt:
        return [_frame(_message_start(seq)), _frame(_text("alphaSTOPbeta")), _done()], delay
    if "MOCK_MAX" in prompt or "MOCK_GEMINI_MAX" in prompt or "MOCK_RESPONSES_MAX" in prompt:
        return [_frame(_message_start(seq)), _frame(_text("abcdefghijklmnop")), _done()], delay
    if "MOCK_ANTHROPIC_STOP" in prompt:
        return [
            _frame(_message_start(seq)),
            _frame(_reasoning("thinking STOP should stay")),
            _frame(_text("visible STOP hidden")),
            _done(),
        ], delay
    if "MOCK_IMAGE_SUCCESS" in prompt:
        delay = 0.35
        return [
            _frame(_message_start(seq)),
            _frame({"code": 0, "data": {"type": "tool_call", "tool_call": {"status": "start"}}}),
            _frame({
                "code": 0,
                "data": {
                    "type": "file",
                    "file": {
                        "type": "image",
                        "url": f"https://example.test/image-{seq}.png",
                        "width": 1024,
                        "height": 1024,
                    },
                },
            }),
            _done(),
        ], delay
    return [_frame(_message_start(seq)), _frame(_text("ok")), _done()], delay


def _handler_factory(state: MockSiderState):
    class MockSiderHandler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, _format: str, *_args: Any) -> None:
            return

        def do_POST(self) -> None:  # noqa: N802
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length)
            body = json.loads(raw.decode("utf-8") or "{}")
            seq = state.add(body)
            prompt = _prompt_from_sider_body(body)

            if "MOCK_HTTP_500" in prompt:
                payload = b"mock upstream error"
                self.send_response(500)
                self.send_header("Content-Type", "text/plain; charset=utf-8")
                self.send_header("Content-Length", str(len(payload)))
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(payload)
                self.close_connection = True
                return

            if "MOCK_HTTP_401" in prompt:
                payload = json.dumps({"code": 1001, "msg": "token expired"}).encode("utf-8")
                self.send_response(401)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(payload)
                self.close_connection = True
                return

            if "MOCK_HANG_HEADERS" in prompt:
                # 响应头都不到: 只能由"响应头超时"兜住
                time.sleep(6.0)
                self.close_connection = True
                return

            if "MOCK_HANG_BODY" in prompt:
                # 头到了但正文永不到: 旧实现的定时器在收到响应头时就 clear 了, 会一直挂着;
                # 必须由"流空闲超时"兜住。
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream; charset=utf-8")
                self.send_header("Connection", "close")
                self.end_headers()
                time.sleep(6.0)
                self.close_connection = True
                return

            frames, delay = _scenario_frames(prompt, seq)
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True
            if delay:
                time.sleep(delay)
            for item in frames:
                try:
                    if "MOCK_LONG_STREAM" in prompt:
                        time.sleep(0.05)
                    self.wfile.write(item)
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                    # 客户端已按超时中止: 静默收尾, 不打印 traceback
                    state.mark_disconnected(prompt)
                    break

        def do_GET(self) -> None:  # noqa: N802
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()

    return MockSiderHandler


@contextmanager
def _launch_stack(env_extra: dict[str, str] | None = None):
    """起一套 mock 上游 + deno 实例; env_extra 可覆盖门控参数供专项用例使用。"""
    state = MockSiderState()
    mock_server = ThreadingHTTPServer(("127.0.0.1", _free_port()), _handler_factory(state))
    mock_thread = threading.Thread(target=mock_server.serve_forever, daemon=True)
    mock_thread.start()

    deno_port = _free_port()
    env = os.environ.copy()
    env.update({
        "PORT": str(deno_port),
        "SIDER_API_ENDPOINT": f"http://127.0.0.1:{mock_server.server_port}/sider",
        "SIDER_AUTH_TOKEN": "mock-sider-token",
        "AUTH_TOKEN": AUTH_TOKEN,
        "RATE_LIMIT_ENABLED": "true",
        "RATE_LIMIT_MAX_CALLS": "100",
        "SSE_PING_INTERVAL_MS": "0",
        "ENABLE_AUTO_SEARCH": "false",
        # 三段超时: 默认值对 mock 太大, 显式压到秒级, 让超时用例跑得快
        "UPSTREAM_HEADER_TIMEOUT_MS": "3000",
        "UPSTREAM_STREAM_IDLE_TIMEOUT_MS": "3000",
        "UPSTREAM_TOTAL_TIMEOUT_MS": "15000",
        "STATS_KV": "memory",
        "STATS_KV_ROOT": "mock-regression",
        "DENO_NO_UPDATE_CHECK": "1",
    })
    if env_extra:
        env.update(env_extra)
    proc = subprocess.Popen(
        ["deno", "run", "--unstable-kv", "--allow-net", "--allow-env", "--allow-read", "--allow-write", "deno_pro.ts"],
        cwd=ROOT,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    logs: list[str] = []

    def drain_logs() -> None:
        assert proc.stdout is not None
        for line in proc.stdout:
            logs.append(line.rstrip())
            del logs[:-300]

    log_thread = threading.Thread(target=drain_logs, daemon=True)
    log_thread.start()
    base_url = f"http://127.0.0.1:{deno_port}"

    try:
        deadline = time.time() + 20
        while time.time() < deadline:
            if proc.poll() is not None:
                pytest.fail("deno_pro.ts 提前退出:\n" + "\n".join(logs[-80:]))
            try:
                if requests.get(base_url + "/", timeout=0.5).status_code == 200:
                    break
            except requests.RequestException:
                time.sleep(0.2)
        else:
            pytest.fail("deno_pro.ts 启动超时:\n" + "\n".join(logs[-80:]))

        yield {"base_url": base_url, "state": state, "logs": logs}
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)
        mock_server.shutdown()
        mock_server.server_close()


@pytest.fixture(scope="session")
def mock_stack():
    with _launch_stack() as stack:
        yield stack


@pytest.fixture(scope="session")
def aimd_stack():
    """独立实例, 验证 AIMD 自适应配额: 初始配额 2, 每连续 2 次成功放宽 1。"""
    with _launch_stack({
        "RATE_LIMIT_MAX_CALLS": "2",
        "RATE_LIMIT_QUOTA_STEP_AFTER": "2",
        "RATE_LIMIT_WINDOW_MS": "60000",
    }) as stack:
        yield stack


@pytest.fixture(scope="session")
def gate_stack():
    """独立实例, 供门控用例使用, 并显式开启并发闸门 (默认关闭)。

    并发闸门与账号级冷却都是【全局】状态, 在共享实例上会被其他用例的 1135 污染
    (实测: 全量跑时前面用例触发的账号冷却会把并发用例的请求全拦下)。
    """
    with _launch_stack({"UPSTREAM_MAX_CONCURRENCY": "1"}) as stack:
        yield stack


@pytest.fixture(scope="session")
def disconnect_stack():
    """低频心跳 + 单并发，用于验证排队及生成阶段的客户端取消传播。"""
    with _launch_stack({
        "UPSTREAM_MAX_CONCURRENCY": "1",
        "SSE_PING_INTERVAL_MS": "25",
        "RATE_LIMIT_MAX_CALLS": "1000",
        "RATE_LIMIT_QUOTA_MAX": "1000",
    }) as stack:
        yield stack


@pytest.fixture(scope="session")
def terminal_stack():
    """独立高配额实例，避免终态矩阵受其他用例的模型门控状态污染。"""
    with _launch_stack({
        "RATE_LIMIT_MAX_CALLS": "1000",
        "RATE_LIMIT_QUOTA_MAX": "1000",
    }) as stack:
        yield stack


@pytest.fixture(scope="session")
def quota_stack():
    """独立实例, 固定配额 (QUOTA_MAX = MAX_CALLS 即禁用 AIMD 增长)。

    用于验证"配额耗尽即拦截"这一门控语义。这类用例原本打真实上游 (每次 7+ 调用),
    但它们测的是门控逻辑而非上游行为, 放在 mock 里零额度且更精确。
    """
    with _launch_stack({
        "RATE_LIMIT_MAX_CALLS": "6",
        "RATE_LIMIT_QUOTA_MAX": "6",
        "RATE_LIMIT_WINDOW_MS": "60000",
    }) as stack:
        yield stack


@pytest.fixture(scope="session")
def probe_stack():
    """账号级闸门 + 半开探测语义。

    高配额避免配额本身干扰; 探测间隔压到 3s, 让"半开探测失败后冷却是否保持"可测。
    """
    with _launch_stack({
        "RATE_LIMIT_MAX_CALLS": "1000",
        "RATE_LIMIT_QUOTA_MAX": "1000",
        "ACCOUNT_QUOTA_MODELS_THRESHOLD": "3",
        "ACCOUNT_QUOTA_WINDOW_MS": "120000",
        "ACCOUNT_PROBE_INTERVAL_MS": "3000",
        "UPSTREAM_MAX_CONCURRENCY": "1",
    }) as stack:
        yield stack


@pytest.fixture(scope="session")
def timeout_stack():
    """三段超时压到秒级: 用于验证响应头超时 / 流空闲超时, 以及超时后槽位可复用。"""
    with _launch_stack({
        "UPSTREAM_HEADER_TIMEOUT_MS": "2000",
        "UPSTREAM_STREAM_IDLE_TIMEOUT_MS": "1000",
        "UPSTREAM_TOTAL_TIMEOUT_MS": "20000",
        "UPSTREAM_MAX_CONCURRENCY": "1",
    }) as stack:
        yield stack


@pytest.fixture(scope="session")
def matrix_stack():
    """独立实例, 供"错误出口矩阵 / 能力门控"这类【会污染实例状态】的用例使用。

    1135 会写模型熔断与账号级冷却, 鉴权故障会写账号级停投 —— 这些都是实例级全局状态。
    放在共享的 mock_stack 上会把同实例里所有后续用例一起打掉, 故单独起一套。
    """
    with _launch_stack() as stack:
        yield stack


@pytest.fixture(scope="session")
def auth_fault_stack():
    """独立实例, 供"上游 401 -> 账号级停投"用例使用 (该状态会挡住实例上所有模型)。"""
    with _launch_stack() as stack:
        yield stack


@pytest.fixture(scope="session")
def strict_quota_stack():
    """每模型每窗口只允许 1 次: 用于一次性打通本地 429 出口 (四协议都要带 Retry-After)。"""
    with _launch_stack({
        "RATE_LIMIT_MAX_CALLS": "1",
        "RATE_LIMIT_QUOTA_MAX": "1",
        "RATE_LIMIT_QUOTA_MIN": "1",
    }) as stack:
        yield stack


@pytest.fixture(autouse=True)
def clear_mock_requests(mock_stack):
    mock_stack["state"].clear()
    yield


def _headers(extra: dict[str, str] | None = None) -> dict[str, str]:
    headers = {"Authorization": f"Bearer {AUTH_TOKEN}", "Content-Type": "application/json"}
    if extra:
        headers.update(extra)
    return headers


def _post(base_url: str, path: str, body: dict[str, Any], *, headers: dict[str, str] | None = None, stream: bool = False):
    return requests.post(
        base_url + path,
        headers=_headers(headers),
        json=body,
        stream=stream,
        timeout=(3, 10),
    )


def _send_and_disconnect(base_url: str, path: str, body: dict[str, Any], *, wait_for_headers: bool = False) -> None:
    """用原始 TCP 请求模拟客户端断连；可等响应头到达后再关闭。"""
    parsed = urlsplit(base_url)
    payload = json.dumps(body).encode("utf-8")
    request = (
        f"POST {path} HTTP/1.1\r\n"
        f"Host: {parsed.hostname}:{parsed.port}\r\n"
        f"Authorization: Bearer {AUTH_TOKEN}\r\n"
        "Content-Type: application/json\r\n"
        f"Content-Length: {len(payload)}\r\n"
        "Connection: close\r\n\r\n"
    ).encode("ascii") + payload
    with socket.create_connection((parsed.hostname, parsed.port), timeout=3) as sock:
        sock.sendall(request)
        if wait_for_headers:
            sock.settimeout(3)
            received = b""
            while b"\r\n\r\n" not in received:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                received += chunk
        else:
            time.sleep(0.1)


def _openai_text(body: dict[str, Any]) -> str:
    return body["choices"][0]["message"]["content"]


def _response_output_text(body: dict[str, Any]) -> str:
    chunks: list[str] = []
    for item in body.get("output", []):
        for content in item.get("content", []):
            if content.get("type") == "output_text":
                chunks.append(content.get("text", ""))
    return "".join(chunks)


def _anthropic_blocks(body: dict[str, Any]) -> tuple[str, str]:
    thinking = ""
    text = ""
    for block in body.get("content", []):
        if block.get("type") == "thinking":
            thinking += block.get("thinking", "")
        if block.get("type") == "text":
            text += block.get("text", "")
    return thinking, text


def _collect_openai_stream(resp) -> dict[str, Any]:
    resp.encoding = "utf-8"
    content: list[str] = []
    finish_reason = None
    done_count = 0
    for raw in resp.iter_lines(decode_unicode=True):
        if not raw:
            continue
        line = raw.strip()
        if not line.startswith("data:"):
            continue
        payload = line[len("data:"):].strip()
        if payload == "[DONE]":
            done_count += 1
            continue
        obj = json.loads(payload)
        choice = obj["choices"][0]
        if choice.get("delta", {}).get("content"):
            content.append(choice["delta"]["content"])
        if choice.get("finish_reason"):
            finish_reason = choice["finish_reason"]
    return {"content": "".join(content), "finish_reason": finish_reason, "done_count": done_count}


def _get_stats(base_url: str) -> dict[str, Any]:
    resp = requests.get(base_url + "/stats.json", timeout=(3, 10))
    assert resp.status_code == 200, resp.text
    return resp.json()


def _trend_totals(stats: dict[str, Any]) -> dict[str, int]:
    trend = stats["trend"]
    return {
        "requests": sum(bucket["requests"] for bucket in trend),
        "streaming": sum(bucket.get("streaming", 0) for bucket in trend),
        "toolCalls": sum(bucket.get("toolCalls", 0) for bucket in trend),
        "inputChars": sum(bucket["inputChars"] for bucket in trend),
        "outputChars": sum(bucket["outputChars"] for bucket in trend),
    }


def _wait_for_stats(base_url: str, predicate, timeout: float = 5.0) -> dict[str, Any]:
    deadline = time.time() + timeout
    last: dict[str, Any] | None = None
    while time.time() < deadline:
        last = _get_stats(base_url)
        if predicate(last):
            return last
        time.sleep(0.1)
    assert last is not None
    return last


@pytest.mark.smoke
def test_openai_non_stream_upstream_1135_returns_429_without_fallback_text(mock_stack):
    r = _post(mock_stack["base_url"], "/v1/chat/completions", {
        "model": "gpt-5.5",
        "messages": [{"role": "user", "content": "MOCK_1135"}],
        "stream": False,
    })
    assert r.status_code == 429, r.text
    body = r.json()
    assert body["error"]["type"] == "rate_limit_error"
    assert body["error"]["upstream_code"] == 1135
    assert "生成完成" not in r.text


@pytest.mark.smoke
def test_openai_non_stream_keeps_text_when_late_warning_arrives(mock_stack):
    r = _post(mock_stack["base_url"], "/v1/chat/completions", {
        "model": "gpt-6-luna",
        "messages": [{"role": "user", "content": "MOCK_WARNING_AFTER_TEXT"}],
        "stream": False,
    })
    assert r.status_code == 200, r.text
    assert _openai_text(r.json()) == "正文仍然保留"
    assert "生成完成" not in r.text


@pytest.mark.smoke
def test_responses_array_input_preserves_text_blocks_and_instruction_roles(mock_stack):
    """Responses 标准 input_text 及 system/developer 角色必须原样进入上游上下文。"""
    r = _post(mock_stack["base_url"], "/v1/responses", {
        "model": "deepseek-v4-pro",
        "instructions": "ROOT_INSTRUCTION",
        "input": [
            {"role": "system", "content": [
                {"type": "input_text", "text": "SECOND_SYSTEM"},
            ]},
            {"role": "developer", "content": [
                {"type": "input_text", "text": "DEVELOPER_RULE"},
            ]},
            {"role": "assistant", "content": [
                {"type": "output_text", "text": "EARLIER_ANSWER"},
            ]},
            {"role": "user", "content": [
                {"type": "input_text", "text": "FINAL_QUESTION"},
            ]},
        ],
    })

    assert r.status_code == 200, r.text
    upstream = mock_stack["state"].snapshot()
    assert len(upstream) == 1
    prompt = _prompt_from_sider_body(upstream[0])
    for expected in ("ROOT_INSTRUCTION", "SECOND_SYSTEM", "DEVELOPER_RULE",
                     "EARLIER_ANSWER", "FINAL_QUESTION"):
        assert expected in prompt, f"上游正文丢失 {expected}: {prompt[:500]}"
    assert prompt.count("[System]") == 2, prompt
    assert "[Developer]\nDEVELOPER_RULE" in prompt, prompt
    assert "Assistant: EARLIER_ANSWER" in prompt, prompt
    assert "[Current User]\nFINAL_QUESTION" in prompt, prompt


@pytest.mark.smoke
def test_responses_rejects_unsupported_input_before_upstream(mock_stack):
    """不支持的 Responses 输入项不能被静默过滤后继续请求上游。"""
    r = _post(mock_stack["base_url"], "/v1/responses", {
        "model": "deepseek-v4-pro",
        "input": [{
            "type": "function_call_output",
            "call_id": "call_1",
            "output": "tool result",
        }],
    })

    assert r.status_code == 422, r.text
    assert "input_type_not_supported" in r.text
    assert mock_stack["state"].snapshot() == []


@pytest.mark.smoke
def test_all_system_and_developer_messages_share_fixed_context_budget(mock_stack):
    """每条 system/developer 都属于不可裁剪固定部分，合计超限必须本地拒绝。"""
    fixed = "a" * 24_800
    r = _post(mock_stack["base_url"], "/v1/chat/completions", {
        "model": "gpt-5.4-mini",
        "messages": [
            {"role": "system", "content": fixed},
            {"role": "developer", "content": fixed},
            {"role": "user", "content": "FINAL_QUESTION"},
        ],
    })

    assert r.status_code == 400, r.text
    assert "context_length_exceeded" in r.text
    assert mock_stack["state"].snapshot() == []


@pytest.mark.smoke
def test_openai_stop_sequence_and_max_tokens_are_applied(mock_stack):
    stop_resp = _post(mock_stack["base_url"], "/v1/chat/completions", {
        "model": "glm-5",
        "messages": [{"role": "user", "content": "MOCK_STOP"}],
        "stop": ["STOP"],
        "stream": False,
    })
    assert stop_resp.status_code == 200, stop_resp.text
    stop_body = stop_resp.json()
    assert _openai_text(stop_body) == "alpha"
    assert stop_body["choices"][0]["finish_reason"] == "stop"
    assert stop_body["choices"][0]["stop_sequence"] == "STOP"

    max_resp = _post(mock_stack["base_url"], "/v1/chat/completions", {
        "model": "gpt-5.4-mini",
        "messages": [{"role": "user", "content": "MOCK_MAX"}],
        "max_tokens": 2,
        "stream": False,
    })
    assert max_resp.status_code == 200, max_resp.text
    max_body = max_resp.json()
    assert _openai_text(max_body) == "abcdefgh"
    assert max_body["choices"][0]["finish_reason"] == "length"
    assert max_body["usage"]["completion_tokens"] <= 2


@pytest.mark.smoke
def test_openai_stream_stop_sequence_split_across_chunks_finishes_once(mock_stack):
    r = _post(mock_stack["base_url"], "/v1/chat/completions", {
        "model": "gpt-5.6-luna",
        "messages": [{"role": "user", "content": "MOCK_STREAM_STOP"}],
        "stop": ["STOP"],
        "stream": True,
    }, stream=True)
    assert r.status_code == 200, r.text
    parsed = _collect_openai_stream(r)
    assert parsed == {"content": "abcd", "finish_reason": "stop", "done_count": 1}


@pytest.mark.smoke
def test_anthropic_stop_sequence_does_not_truncate_thinking(mock_stack):
    r = _post(mock_stack["base_url"], "/v1/messages", {
        "model": "claude-sonnet-4.6",
        "max_tokens": 100,
        "stop_sequences": ["STOP"],
        "messages": [{"role": "user", "content": "MOCK_ANTHROPIC_STOP"}],
    })
    assert r.status_code == 200, r.text
    body = r.json()
    thinking, text = _anthropic_blocks(body)
    assert thinking == "thinking STOP should stay"
    assert text == "visible "
    assert body["stop_reason"] == "stop_sequence"
    assert body["stop_sequence"] == "STOP"
    assert body["usage"]["output_tokens"] > 0


@pytest.mark.smoke
def test_gemini_max_output_tokens_maps_to_max_tokens_finish_reason(mock_stack):
    r = _post(mock_stack["base_url"], "/v1beta/models/gemini-2.5-pro:generateContent", {
        "contents": [{"role": "user", "parts": [{"text": "MOCK_GEMINI_MAX"}]}],
        "generationConfig": {"maxOutputTokens": 2},
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["candidates"][0]["content"]["parts"][0]["text"] == "abcdefgh"
    assert body["candidates"][0]["finishReason"] == "MAX_TOKENS"
    assert body["usageMetadata"]["candidatesTokenCount"] <= 2


@pytest.mark.smoke
def test_responses_max_output_tokens_marks_response_incomplete(mock_stack):
    r = _post(mock_stack["base_url"], "/v1/responses", {
        "model": "deepseek-v4-pro",
        "input": "MOCK_RESPONSES_MAX",
        "max_output_tokens": 2,
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert _response_output_text(body) == "abcdefgh"
    assert body["status"] == "incomplete"
    assert body["incomplete_details"]["reason"] == "max_output_tokens"
    assert body["usage"]["output_tokens"] <= 2


@pytest.mark.smoke
def test_1101_and_603_do_not_trigger_model_circuit_breaker(mock_stack):
    model_1101 = "gpt-5.6-sol"
    first = _post(mock_stack["base_url"], "/v1/chat/completions", {
        "model": model_1101,
        "messages": [{"role": "user", "content": "MOCK_1101"}],
        "stream": False,
    })
    assert first.status_code == 429, first.text
    assert first.json()["error"]["upstream_code"] == 1101

    second = _post(mock_stack["base_url"], "/v1/chat/completions", {
        "model": model_1101,
        "messages": [{"role": "user", "content": "OK_AFTER_1101"}],
        "stream": False,
    })
    assert second.status_code == 200, second.text
    assert len(mock_stack["state"].snapshot()) == 2

    mock_stack["state"].clear()
    model_603 = "gpt-5.6-terra"
    too_long = _post(mock_stack["base_url"], "/v1/chat/completions", {
        "model": model_603,
        "messages": [{"role": "user", "content": "MOCK_603"}],
        "stream": False,
    })
    assert too_long.status_code == 400, too_long.text
    assert too_long.json()["error"]["upstream_code"] == 603

    after_603 = _post(mock_stack["base_url"], "/v1/chat/completions", {
        "model": model_603,
        "messages": [{"role": "user", "content": "OK_AFTER_603"}],
        "stream": False,
    })
    assert after_603.status_code == 200, after_603.text
    assert len(mock_stack["state"].snapshot()) == 2


@pytest.mark.smoke
def test_image_endpoint_maps_sider_business_error_instead_of_500(mock_stack):
    r = _post(mock_stack["base_url"], "/v1/images/generations", {
        "prompt": "MOCK_603 image prompt",
        "n": 1,
        "size": "1024x1024",
    })
    assert r.status_code == 400, r.text
    body = r.json()
    assert body["error"]["type"] == "context_length_exceeded"
    assert body["error"]["upstream_code"] == 603
    assert body["error"]["message"] != ""


@pytest.mark.smoke
def test_default_concurrency_is_one_and_serializes_requests(mock_stack):
    """默认就该是单并发 (UPSTREAM_MAX_CONCURRENCY=1), 而不是 0=不限制。

    上游账号实测单并发, 超出并发数的请求必须排队。本用例【不显式设置】
    UPSTREAM_MAX_CONCURRENCY, 因此断言的是默认值本身 —— 默认值若被改回 0, 三次请求会
    并行完成, 总耗时接近单次, 断言失败。
    """
    body = {
        "model": "gpt-5.6-luna",
        "messages": [{"role": "user", "content": "MOCK_SLOW"}],
        "stream": False,
    }
    start = time.time()
    with ThreadPoolExecutor(max_workers=3) as pool:
        futures = [pool.submit(_post, mock_stack["base_url"], "/v1/chat/completions", dict(body))
                   for _ in range(3)]
        results = [f.result() for f in futures]
    elapsed = time.time() - start

    assert [r.status_code for r in results] == [200, 200, 200], [r.text[:120] for r in results]
    # 单次上游耗时 0.6s; 串行化后三次应显著超过一次
    assert elapsed >= 1.2, f"默认并发闸门未生效, 总耗时仅 {elapsed:.2f}s"
    assert len(mock_stack["state"].snapshot()) == 3


@pytest.mark.smoke
def test_image_generation_serializes_instead_of_rejecting(mock_stack):
    """并发图像生成最终都应成功 (排队而非拒绝), 且不得出现进程内互斥锁的拒绝标记。"""
    def fire() -> requests.Response:
        return _post(mock_stack["base_url"], "/v1/images/generations", {
            "prompt": "MOCK_IMAGE_SUCCESS",
            "n": 1,
            "size": "1024x1024",
        })

    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda _: fire(), range(2)))

    statuses = [r.status_code for r in responses]
    assert statuses == [200, 200]
    for resp in responses:
        assert resp.json()["data"][0]["url"].startswith("https://example.test/image-")
        assert "concurrent_request_rejected" not in resp.text
    assert len(mock_stack["state"].snapshot()) == 2


@pytest.mark.smoke
def test_stats_totals_tools_and_trend_use_same_24h_window(mock_stack):
    before = _get_stats(mock_stack["base_url"])
    before_requests = before["totals"]["requests"]
    before_tools = {item["name"]: item["count"] for item in before["tools"]}

    r = _post(mock_stack["base_url"], "/v1/images/generations", {
        "prompt": "MOCK_IMAGE_SUCCESS",
        "n": 1,
        "size": "1024x1024",
    })
    assert r.status_code == 200, r.text

    stats = _wait_for_stats(
        mock_stack["base_url"],
        lambda snap: snap["totals"]["requests"] >= before_requests + 1 and
        {item["name"]: item["count"] for item in snap["tools"]}.get("create_image", 0) >=
        before_tools.get("create_image", 0) + 1,
    )
    trend_totals = _trend_totals(stats)

    assert stats["totals"] == trend_totals
    assert stats["totals"]["streaming"] == trend_totals["streaming"]
    assert stats["totals"]["toolCalls"] == trend_totals["toolCalls"]
    assert any(bucket.get("toolCalls", 0) > 0 for bucket in stats["trend"])
    assert any(item["name"] == "create_image" and item["count"] >= 1 for item in stats["tools"])
    assert "近 24 小时窗口" in stats["note"]
    assert "历史累计" not in stats["note"]


@pytest.mark.smoke
def test_session_reuse_requires_explicit_x_session_id(mock_stack):
    """会话只在【调用方显式回传 X-Session-ID】时复用。

    旧实现用"系统消息 + 首问"指纹推导会话 ID: 同一调用方的两个不同对话只要开头相同,
    就会撞进同一个上游 cid 串话。现在无 X-Session-ID 时按无状态处理 —— 上下文不丢,
    因为每次请求都注入了完整历史。
    """
    body = {
        "model": "grok-4",
        "messages": [{"role": "user", "content": f"MOCK_SESSION_ISOLATION_{uuid4().hex}"}],
        "stream": False,
    }

    implicit_a = _post(mock_stack["base_url"], "/v1/chat/completions", body)
    implicit_b = _post(mock_stack["base_url"], "/v1/chat/completions", body)

    assert implicit_a.status_code == 200, implicit_a.text
    assert implicit_b.status_code == 200, implicit_b.text
    # 每次都是新的一次性 ID, 不会把两次无关调用绑到同一会话
    assert implicit_a.headers["X-Session-ID"] != implicit_b.headers["X-Session-ID"]

    upstream_requests = mock_stack["state"].snapshot()
    assert len(upstream_requests) == 2
    assert not upstream_requests[0].get("cid")
    assert not upstream_requests[1].get("cid")

    # 显式回传同一个 X-Session-ID 时, 第二轮才带上上一轮的 cid
    mock_stack["state"].clear()
    sid = f"pytest-{uuid4().hex[:12]}"
    first = _post(mock_stack["base_url"], "/v1/chat/completions", body, headers={"X-Session-ID": sid})
    assert first.status_code == 200, first.text
    assert first.headers["X-Session-ID"] == sid

    second = _post(mock_stack["base_url"], "/v1/chat/completions", body, headers={"X-Session-ID": sid})
    assert second.status_code == 200, second.text

    explicit_requests = mock_stack["state"].snapshot()
    assert len(explicit_requests) == 2
    assert not explicit_requests[0].get("cid"), "首轮不应带 cid"
    assert explicit_requests[1].get("cid") == explicit_requests[0].get("cid") or \
        explicit_requests[1].get("cid"), "第二轮应复用上一轮的上游会话"


# ==================== 上游门控优化 (熔断时长/并发闸门/账号级/AIMD) ====================


@pytest.mark.smoke
def test_1135_breaker_follows_upstream_reported_duration(mock_stack):
    """1135 应按上游消息里告知的时长熔断, 而不是按模型类型拍脑袋。

    取 opus 模型: 旧逻辑一律罚 1 小时, 哪怕上游只说"1 分钟" —— 白白闲置 59 分钟的可用额度。
    """
    model = "claude-opus-4.8"
    first = _post(mock_stack["base_url"], "/v1/chat/completions", {
        "model": model,
        "messages": [{"role": "user", "content": "MOCK_1135_MIN"}],
        "stream": False,
    })
    assert first.status_code == 429, first.text
    assert first.json()["error"]["upstream_code"] == 1135

    second = _post(mock_stack["base_url"], "/v1/chat/completions", {
        "model": model,
        "messages": [{"role": "user", "content": "SHOULD_BE_BLOCKED"}],
        "stream": False,
    })
    assert second.status_code == 429, second.text
    assert second.headers.get("X-Model-Rate-Limited") == "1"
    retry = int(second.headers["Retry-After"])
    assert 30 <= retry <= 60, f"应按上游告知的 1 分钟熔断, 实际 Retry-After={retry}"
    # 第二次被本地熔断拦下, 不应触达上游
    assert len(mock_stack["state"].snapshot()) == 1


@pytest.mark.smoke
def test_1135_without_duration_falls_back_to_fixed_breaker(mock_stack):
    """上游没告知时长时, 回退到固定兜底时长 (非 opus 为 1 分钟)。"""
    model = "gpt-5.4-mini"
    first = _post(mock_stack["base_url"], "/v1/chat/completions", {
        "model": model,
        "messages": [{"role": "user", "content": "MOCK_1135"}],
        "stream": False,
    })
    assert first.status_code == 429, first.text

    second = _post(mock_stack["base_url"], "/v1/chat/completions", {
        "model": model,
        "messages": [{"role": "user", "content": "SHOULD_BE_BLOCKED"}],
        "stream": False,
    })
    assert second.status_code == 429, second.text
    retry = int(second.headers["Retry-After"])
    assert 30 <= retry <= 60, f"兜底应为 1 分钟, 实际 Retry-After={retry}"


@pytest.mark.smoke
def test_upstream_concurrency_gate_queues_instead_of_failing(gate_stack):
    """上游单并发: 并发请求应排队依次成功, 而不是失败。

    MOCK_SLOW 的延迟发生在响应头之后、body 之前, 因此也验证了槽位是在【流结束】时
    释放的 —— 若在 fetch 返回时就释放, 三个请求会并行, 总耗时接近单次。
    """
    model = "gpt-6-luna"
    body = {
        "model": model,
        "messages": [{"role": "user", "content": "MOCK_SLOW"}],
        "stream": False,
    }
    start = time.time()
    with ThreadPoolExecutor(max_workers=3) as pool:
        futures = [
            pool.submit(_post, gate_stack["base_url"], "/v1/chat/completions", dict(body))
            for _ in range(3)
        ]
        results = [f.result() for f in futures]
    elapsed = time.time() - start

    assert [r.status_code for r in results] == [200, 200, 200], [r.text[:120] for r in results]
    # 单次上游耗时 0.6s; 串行化后三次应显著超过一次的耗时
    assert elapsed >= 1.2, f"并发未被串行化, 总耗时仅 {elapsed:.2f}s"
    assert len(gate_stack["state"].snapshot()) == 3


@pytest.mark.smoke
def test_queued_request_rechecks_gate_after_wake(gate_stack):
    """排队等待期间上游撞墙 -> 醒来的请求必须复检门控, 不能再穿透熔断。

    旧实现只在【入队前】检查一次限速; 前序请求触发 1135 之后, 已排队的请求醒来仍会
    直接 fetch 上游, 白白消耗一次额度。修复后执行顺序是
    预检 -> 排队 -> 二次检查并原子扣配额 -> fetch。
    """
    model = "llama-3.3-70b"
    body = {
        "model": model,
        "messages": [{"role": "user", "content": "MOCK_SLOW_1135"}],
        "stream": False,
    }
    # autouse 的清理只作用于 mock_stack; gate_stack 是独立实例, 需自行清账
    gate_stack["state"].clear()

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(_post, gate_stack["base_url"], "/v1/chat/completions", dict(body))
                   for _ in range(2)]
        results = [f.result() for f in futures]

    codes = sorted(r.status_code for r in results)
    assert codes == [429, 429], [r.text[:150] for r in results]
    # 关键: 只有一个请求真正到达上游 —— 排队的那个在醒来后被二次准入拦下
    assert len(gate_stack["state"].snapshot()) == 1, \
        f"排队请求穿透了熔断: 上游被调用 {len(gate_stack['state'].snapshot())} 次"


@pytest.mark.smoke
def test_account_level_quota_exhaustion_blocks_untouched_model(gate_stack):
    """多个模型短时内都 1135 -> 判定账号级枯竭, 未试过的模型也直接拒, 不再逐个试探。"""
    for model in ("gpt-4.1-mini", "glm-5", "grok-4.6"):
        r = _post(gate_stack["base_url"], "/v1/chat/completions", {
            "model": model,
            "messages": [{"role": "user", "content": "MOCK_1135_SEC"}],
            "stream": False,
        })
        assert r.status_code == 429, r.text

    upstream_calls = len(gate_stack["state"].snapshot())
    # 第 4 个模型此前从未 1135, 但账号级冷却应把它也拦下
    blocked = _post(gate_stack["base_url"], "/v1/chat/completions", {
        "model": "llama-3.1-405b",
        "messages": [{"role": "user", "content": "NORMAL_OK"}],
        "stream": False,
    })
    assert blocked.status_code == 429, blocked.text
    assert len(gate_stack["state"].snapshot()) == upstream_calls, "账号冷却期内不应触达上游"

    # 冷却仅 2 秒 (上游告知), 到期后应自动恢复
    time.sleep(2.6)
    recovered = _post(gate_stack["base_url"], "/v1/chat/completions", {
        "model": "llama-3.1-405b",
        "messages": [{"role": "user", "content": "NORMAL_OK"}],
        "stream": False,
    })
    assert recovered.status_code == 200, recovered.text


@pytest.mark.smoke
def test_adaptive_quota_widens_after_consecutive_successes(aimd_stack):
    """AIMD: 初始配额 2, 连续 2 次成功后放宽到 3 -> 第 3 次仍能成功, 第 4 次才被拦。

    固定保守配额会闲置上游额度; 自适应让健康时段用得更满。
    """
    model = "gemini-3.0-flash"
    codes = []
    for i in range(4):
        r = _post(aimd_stack["base_url"], "/v1/chat/completions", {
            "model": model,
            "messages": [{"role": "user", "content": f"NORMAL_{i}"}],
            "stream": False,
        })
        codes.append(r.status_code)

    assert codes[:3] == [200, 200, 200], f"配额应已从 2 放宽到 3, 实际: {codes}"
    assert codes[3] == 429, f"超出放宽后的配额应被拦, 实际: {codes}"


@pytest.mark.smoke
def test_image_generation_releases_slot_when_stream_not_drained(gate_stack):
    """图像生成成功路径提前 break, 上游流未读完; 必须 cancel 才能及时释放并发槽位。

    在【开启并发闸门】的实例上并发两次图像生成: 应排队依次成功。若不 cancel reader,
    第一个请求的槽位会一直挂到 UPSTREAM_SLOT_MAX_HOLD_MS 兜底 (180s), 第二个请求
    就会卡到客户端读超时 —— 这正是加 finally cancel 之前观察到的失败。
    """
    def fire() -> requests.Response:
        return _post(gate_stack["base_url"], "/v1/images/generations", {
            "prompt": "MOCK_IMAGE_SUCCESS",
            "n": 1,
            "size": "1024x1024",
        })

    start = time.time()
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda _: fire(), range(2)))
    elapsed = time.time() - start

    assert [r.status_code for r in responses] == [200, 200], [r.text[:120] for r in responses]
    for resp in responses:
        assert resp.json()["data"][0]["url"].startswith("https://example.test/image-")
    assert elapsed < 8, f"槽位未及时释放, 两次图像生成耗时 {elapsed:.1f}s"


@pytest.mark.smoke
def test_stream_early_return_releases_slot(gate_stack):
    """流式路径命中 stop_sequence 会提前 return, 上游流未读完。

    四个流式 start() 里普遍是 1 处 cancel 对 5~6 处 return; 修复放在 SSELineReader
    这个 async generator 的 finally 里 —— for await 提前 return 时 JS 会调用
    generator 的 .return(), finally 必定执行, 从而覆盖所有调用点。
    这里在开启并发闸门的实例上验证: 提前 return 后槽位应已释放, 后续请求不被卡住。
    """
    first = _post(gate_stack["base_url"], "/v1/chat/completions", {
        "model": "glm-5",
        "messages": [{"role": "user", "content": "MOCK_STREAM_STOP"}],
        "stream": True,
        "stop": ["STOP"],
    }, stream=True)
    assert first.status_code == 200, first.text[:200]
    first_body = first.text  # 读完客户端侧响应
    assert "data:" in first_body

    # 若上游流未被 cancel, 槽位会挂到 180s 兜底, 这个请求就会排队超时
    start = time.time()
    second = _post(gate_stack["base_url"], "/v1/chat/completions", {
        "model": "glm-5",
        "messages": [{"role": "user", "content": "NORMAL_AFTER_EARLY_RETURN"}],
        "stream": False,
    })
    elapsed = time.time() - start
    assert second.status_code == 200, second.text[:200]
    assert elapsed < 5, f"槽位未及时释放, 后续请求耗时 {elapsed:.1f}s"


@pytest.mark.smoke
def test_queued_disconnect_never_reaches_upstream(disconnect_stack):
    """客户端在 FIFO 排队时断开，等待项应立即移除，不能在槽位唤醒后触达上游。"""
    base = disconnect_stack["base_url"]
    state = disconnect_stack["state"]
    state.clear()

    with ThreadPoolExecutor(max_workers=1) as pool:
        first = pool.submit(_post, base, "/v1/chat/completions", {
            "model": "gpt-5.6-luna",
            "messages": [{"role": "user", "content": "MOCK_SLOW QUEUE_HOLDER"}],
        })
        deadline = time.time() + 3
        while len(state.snapshot()) < 1 and time.time() < deadline:
            time.sleep(0.02)

        _send_and_disconnect(base, "/v1/chat/completions", {
            "model": "gpt-5.6-sol",
            "messages": [{"role": "user", "content": "QUEUED_CLIENT_GONE"}],
        })
        assert first.result(timeout=5).status_code == 200

    time.sleep(0.3)
    prompts = [_prompt_from_sider_body(body) for body in state.snapshot()]
    assert all("QUEUED_CLIENT_GONE" not in prompt for prompt in prompts), prompts

    follow_up = _post(base, "/v1/chat/completions", {
        "model": "gpt-5.6-terra",
        "messages": [{"role": "user", "content": "AFTER_QUEUE_DISCONNECT"}],
    })
    assert follow_up.status_code == 200, follow_up.text[:200]


@pytest.mark.smoke
def test_stream_disconnect_aborts_upstream_and_clears_lifecycle(disconnect_stack):
    """生成中断连必须关闭上游流；随后请求应正常进入且心跳不能残留占用生命周期。"""
    base = disconnect_stack["base_url"]
    state = disconnect_stack["state"]
    state.clear()
    marker = "MOCK_LONG_STREAM CLIENT_GONE_DURING_GENERATION"

    _send_and_disconnect(base, "/v1/chat/completions", {
        "model": "gpt-5.6-luna",
        "messages": [{"role": "user", "content": marker}],
        "stream": True,
    }, wait_for_headers=True)

    deadline = time.time() + 4
    while marker not in state.disconnected_snapshot() and time.time() < deadline:
        time.sleep(0.05)
    assert marker in state.disconnected_snapshot(), "网关未在客户端断连后关闭上游连接"

    start = time.time()
    follow_up = _post(base, "/v1/chat/completions", {
        "model": "gpt-5.6-sol",
        "messages": [{"role": "user", "content": "AFTER_STREAM_DISCONNECT"}],
    })
    assert follow_up.status_code == 200, follow_up.text[:200]
    assert time.time() - start < 3, "断连后槽位或心跳生命周期仍未清理"


@pytest.mark.smoke
def test_quota_exhaustion_blocks_and_isolates_by_model(quota_stack):
    """固定配额下: 第 7 次被拦, 错误格式规范, 且不波及其他模型。

    覆盖原 test_rate_limit.py 中打真实上游的三个用例 (after_6_calls / isolation /
    error_format), 迁到 mock 后零额度且不受 AIMD 配额增长影响。
    """
    base, model, other = quota_stack["base_url"], "gpt-4.1-mini", "gpt-6-luna"

    for i in range(6):
        r = _post(base, "/v1/chat/completions", {
            "model": model,
            "messages": [{"role": "user", "content": f"WARM_{i}"}],
            "stream": False,
        })
        assert r.status_code == 200, f"第 {i+1} 次应成功: {r.text[:150]}"

    blocked = _post(base, "/v1/chat/completions", {
        "model": model,
        "messages": [{"role": "user", "content": "SHOULD_BLOCK"}],
        "stream": False,
    })
    assert blocked.status_code == 429, blocked.text[:200]
    err = blocked.json()["error"]
    assert err["type"] == "rate_limit_error"
    assert err["code"] == "model_rate_limited"
    assert err["model"] == model
    assert int(blocked.headers["Retry-After"]) >= 1
    assert blocked.headers.get("X-Model-Rate-Limited") == "1"

    # 限速是模型级的: 另一个模型不应受影响
    isolated = _post(base, "/v1/chat/completions", {
        "model": other,
        "messages": [{"role": "user", "content": "OTHER_MODEL"}],
        "stream": False,
    })
    assert isolated.status_code == 200, f"限速不应波及其他模型: {isolated.text[:150]}"


# ==================== 统一错误出口 (四协议一致性 / Retry-After) ====================


def _post_protocol(base_url: str, protocol: str, model: str, prompt: str, *, stream: bool = False):
    """按协议发一次最简请求; 四个端点在语义上等价, 便于同构断言。"""
    if protocol == "openai":
        return _post(base_url, "/v1/chat/completions", {
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "stream": stream,
        }, stream=stream)
    if protocol == "responses":
        return _post(base_url, "/v1/responses", {
            "model": model, "input": prompt, "stream": stream,
        }, stream=stream)
    if protocol == "anthropic":
        return _post(base_url, "/v1/messages", {
            "model": model, "max_tokens": 128,
            "messages": [{"role": "user", "content": prompt}], "stream": stream,
        }, stream=stream)
    if protocol == "gemini":
        action = "streamGenerateContent" if stream else "generateContent"
        return _post(base_url, f"/v1beta/models/{model}:{action}", {
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        }, stream=stream)
    raise AssertionError(protocol)


# 每个协议一个独立模型, 避免模型级熔断在协议之间串扰
_PROTOCOL_MODELS = {
    "openai": "gpt-5.6-terra",
    "responses": "deepseek-v4-pro",
    "anthropic": "claude-sonnet-5",
    "gemini": "gemini-2.5-pro",
}


@pytest.mark.smoke
def test_terminal_business_error_after_text_is_never_reported_as_success(terminal_stack):
    """正文后的终止性业务错误应保留已发送片段，但四协议都不能再发送成功终态。"""
    base = terminal_stack["base_url"]
    for protocol, model in _PROTOCOL_MODELS.items():
        nonstream = _post_protocol(base, protocol, model, "MOCK_TERMINAL_AFTER_TEXT")
        assert nonstream.status_code == 502, \
            f"{protocol} 非流式错误被标成成功: {nonstream.status_code} {nonstream.text[:200]}"

        stream = _post_protocol(base, protocol, model, "MOCK_TERMINAL_AFTER_TEXT", stream=True)
        assert stream.status_code == 200, stream.text[:200]
        events = _collect_sse(stream)
        blob = json.dumps(events, ensure_ascii=False)
        assert "partial before failure" in blob, f"{protocol} 丢失已发送正文: {events}"
        assert "terminal failure" in blob, f"{protocol} 未暴露终止错误: {events}"

        payloads = [p for _, p in events if isinstance(p, dict)]
        if protocol == "openai":
            assert not any(p.get("choices", [{}])[0].get("finish_reason") in {"stop", "length"}
                           for p in payloads if p.get("choices")), events
        elif protocol == "responses":
            types = [p.get("type") for p in payloads]
            assert "response.completed" not in types and "response.incomplete" not in types, types
        elif protocol == "anthropic":
            assert not any(p.get("type") == "message_stop" for p in payloads), events
        else:
            assert not any(candidate.get("finishReason") in {"STOP", "MAX_TOKENS"}
                           for p in payloads for candidate in p.get("candidates", [])), events


@pytest.mark.smoke
def test_eof_without_done_is_an_error_for_all_protocols(terminal_stack):
    """上游传输 EOF 不等于生成完成；缺少 [DONE] 时不得记成功或发成功终态。"""
    base = terminal_stack["base_url"]
    for protocol, model in _PROTOCOL_MODELS.items():
        nonstream = _post_protocol(base, protocol, model, "MOCK_EOF_AFTER_TEXT")
        assert nonstream.status_code == 502, \
            f"{protocol} 异常 EOF 被标成成功: {nonstream.status_code} {nonstream.text[:200]}"

        stream = _post_protocol(base, protocol, model, "MOCK_EOF_AFTER_TEXT", stream=True)
        events = _collect_sse(stream)
        blob = json.dumps(events, ensure_ascii=False).lower()
        assert "partial before eof" in blob, f"{protocol} 丢失异常截断前正文: {events}"
        assert "truncated" in blob, f"{protocol} 未报告异常截断: {events}"
        payloads = [p for _, p in events if isinstance(p, dict)]
        assert not any(p.get("type") == "response.completed" for p in payloads), events
        assert not any(p.get("type") == "message_stop" for p in payloads), events
        assert not any(candidate.get("finishReason") in {"STOP", "MAX_TOKENS"}
                       for p in payloads for candidate in p.get("candidates", [])), events


@pytest.mark.smoke
def test_all_four_protocols_map_603_to_context_length_exceeded(matrix_stack):
    """同一个上游业务码 (603) 在四个端点必须落到同一个语义 (400 context_length_exceeded),
    并且各自用【原生错误结构】表达 —— 而不是把 OpenAI 结构塞给所有协议。"""
    base = matrix_stack["base_url"]
    matrix_stack["state"].clear()
    for protocol, model in _PROTOCOL_MODELS.items():
        r = _post_protocol(base, protocol, model, "MOCK_603")
        assert r.status_code == 400, f"{protocol}: {r.status_code} {r.text[:200]}"
        body = r.json()
        blob = json.dumps(body, ensure_ascii=False).lower()
        assert "context_length_exceeded" in blob, f"{protocol} 未给出统一语义: {body}"
        # 603 是调用方的问题, 不该给 Retry-After 引导重试
        assert "Retry-After" not in r.headers, \
            f"{protocol}: 603 不该带 Retry-After: {dict(r.headers)}"

        if protocol == "gemini":
            assert body["error"]["code"] == 400, body
            assert body["error"]["status"] == "INVALID_ARGUMENT", body
        elif protocol == "anthropic":
            assert body["type"] == "error", body
            assert body["error"]["type"] == "invalid_request_error", body
            assert body["error"]["code"] == "context_length_exceeded", body
        else:
            assert body["error"]["type"] == "context_length_exceeded", body
            assert body["error"]["upstream_code"] == 603, body


@pytest.mark.smoke
def test_local_gate_429_is_rendered_in_caller_protocol(strict_quota_stack):
    """本地门控的 429 也要按【调用方协议】呈现, 并且都带 Retry-After。

    旧实现无论从哪个端点进来都返回 OpenAI 结构, anthropic / google-genai SDK
    拿到后解析不出错误类型。
    """
    base = strict_quota_stack["base_url"]
    models = {
        "openai": "grok-4.6",
        "responses": "llama-3",
        "anthropic": "claude-opus-5",
        "gemini": "gemini-3.8-flash",
    }
    for protocol, model in models.items():
        first = _post_protocol(base, protocol, model, "WARM_UP")
        assert first.status_code == 200, f"{protocol} 预热应成功: {first.text[:200]}"

        blocked = _post_protocol(base, protocol, model, "SHOULD_BLOCK")
        assert blocked.status_code == 429, f"{protocol}: {blocked.status_code} {blocked.text[:200]}"
        assert blocked.headers.get("X-Model-Rate-Limited") == "1"
        assert int(blocked.headers["Retry-After"]) >= 1

        body = blocked.json()
        if protocol == "gemini":
            assert body["error"]["status"] == "RESOURCE_EXHAUSTED", body
            assert body["error"]["code"] == 429, body
        elif protocol == "anthropic":
            assert body["type"] == "error", body
            assert body["error"]["type"] == "rate_limit_error", body
        else:
            assert body["error"]["type"] == "rate_limit_error", body
            assert body["error"]["code"] == "model_rate_limited", body


@pytest.mark.smoke
def test_account_auth_fault_stops_all_models(auth_fault_stack):
    """上游 HTTP 401 (Token 失效) 应进入账号级停投: 换一个没试过的模型也应本地快速失败。"""
    base = auth_fault_stack["base_url"]
    first = _post(base, "/v1/chat/completions", {
        "model": "gpt-6.1-sol",
        "messages": [{"role": "user", "content": "MOCK_HTTP_401"}],
        "stream": False,
    })
    assert first.status_code == 401, first.text[:200]

    calls = len(auth_fault_stack["state"].snapshot())
    second = _post(base, "/v1/chat/completions", {
        "model": "glm-5-think",
        "messages": [{"role": "user", "content": "NORMAL_OK"}],
        "stream": False,
    })
    assert second.status_code == 401, second.text[:200]
    assert second.headers.get("X-Model-Rate-Limited") == "1"
    assert len(auth_fault_stack["state"].snapshot()) == calls, "账号级鉴权故障期内不应触达上游"


# ==================== 上下文预算 / 模型与能力门控一致性 (P1/P2) ====================


@pytest.mark.smoke
def test_context_overflow_is_rejected_locally_without_touching_upstream(matrix_stack):
    """固定部分 (system) 自身超限时应在本地拒绝, 不消耗上游额度。

    旧实现只有 Chat 端点做了预算保护, 且超限时静默发出去撞上游 603。
    """
    base = matrix_stack["base_url"]
    matrix_stack["state"].clear()
    huge = "很长的系统提示 " * 6000  # 远超 SIDER_MAX_CHARS (49500) 与词数上限
    requests = [
        ("openai", "/v1/chat/completions", {
            "model": _PROTOCOL_MODELS["openai"],
            "messages": [{"role": "system", "content": huge},
                         {"role": "user", "content": "说收到"}],
        }),
        ("responses", "/v1/responses", {
            "model": _PROTOCOL_MODELS["responses"], "instructions": huge, "input": "说收到",
        }),
        ("anthropic", "/v1/messages", {
            "model": _PROTOCOL_MODELS["anthropic"], "max_tokens": 64, "system": huge,
            "messages": [{"role": "user", "content": "说收到"}],
        }),
        ("gemini", f"/v1beta/models/{_PROTOCOL_MODELS['gemini']}:generateContent", {
            "systemInstruction": {"parts": [{"text": huge}]},
            "contents": [{"role": "user", "parts": [{"text": "说收到"}]}],
        }),
    ]
    for protocol, path, body in requests:
        r = _post(base, path, body)
        assert r.status_code == 400, f"{protocol}: {r.status_code} {r.text[:200]}"
        assert "context_length_exceeded" in json.dumps(r.json(), ensure_ascii=False), \
            f"{protocol}: {r.text[:200]}"

    assert matrix_stack["state"].snapshot() == [], "本地拒绝的请求不应触达上游"


@pytest.mark.smoke
def test_unknown_model_is_rejected_on_all_protocols(matrix_stack):
    """未知模型必须显式报错, 不能静默回退到 sider 白烧额度 (P2)。"""
    base = matrix_stack["base_url"]
    matrix_stack["state"].clear()
    bogus = "gpt-super-typo-9000"
    cases = [
        ("/v1/chat/completions", {"model": bogus,
                                  "messages": [{"role": "user", "content": "hi"}]}),
        ("/v1/responses", {"model": bogus, "input": "hi"}),
        ("/v1/messages", {"model": bogus, "max_tokens": 16,
                          "messages": [{"role": "user", "content": "hi"}]}),
        (f"/v1beta/models/{bogus}:generateContent",
         {"contents": [{"role": "user", "parts": [{"text": "hi"}]}]}),
    ]
    for path, body in cases:
        r = _post(base, path, body)
        assert r.status_code == 404, f"{path}: {r.status_code} {r.text[:200]}"
        assert "model_not_found" in r.text, f"{path}: {r.text[:200]}"

    assert matrix_stack["state"].snapshot() == [], "未知模型不应触达上游"

    # 显式 "sider" 智能路由仍然可用 (不被 P2 误伤)
    ok = _post(base, "/v1/chat/completions", {
        "model": "sider", "messages": [{"role": "user", "content": "NORMAL_OK"}],
    })
    assert ok.status_code == 200, ok.text[:200]


@pytest.mark.smoke
def test_custom_tools_are_rejected_uniformly_across_protocols(matrix_stack):
    """自定义 function calling: 四协议统一 not_supported; tool_choice=none 正常放行。

    此前"有时报错、有时静默降级", 两种相反契约并存 —— 调用方无法写出稳定的处理逻辑。
    """
    base = matrix_stack["base_url"]
    schema = {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}

    cases = [
        ("openai", "/v1/chat/completions", {
            "model": "kimi-k3",
            "messages": [{"role": "user", "content": "北京天气?"}],
            "tools": [{"type": "function", "function": {"name": "get_weather",
                                                       "parameters": schema}}],
        }),
        ("responses", "/v1/responses", {
            "model": "glm-5.3-flash",
            "input": "北京天气?",
            "tools": [{"type": "function", "name": "get_weather", "parameters": schema}],
        }),
        ("anthropic", "/v1/messages", {
            "model": "claude-haiku-4.5", "max_tokens": 64,
            "messages": [{"role": "user", "content": "北京天气?"}],
            "tools": [{"name": "get_weather", "input_schema": schema}],
        }),
        ("gemini", "/v1beta/models/gemini-3.6-flash:generateContent", {
            "contents": [{"role": "user", "parts": [{"text": "北京天气?"}]}],
            "tools": [{"functionDeclarations": [{"name": "get_weather", "parameters": schema}]}],
        }),
    ]
    for protocol, path, body in cases:
        r = _post(base, path, body)
        assert r.status_code == 422, f"{protocol}: {r.status_code} {r.text[:200]}"
        assert "not_supported" in r.text, f"{protocol}: {r.text[:200]}"
        assert "tools_not_supported" in r.text, f"{protocol}: {r.text[:200]}"

    # 明确声明"不要工具"时应正常放行
    ok = _post(base, "/v1/chat/completions", {
        "model": "qwen3.8-max-think",
        "messages": [{"role": "user", "content": "NORMAL_OK"}],
        "tools": [{"type": "function", "function": {"name": "get_weather", "parameters": schema}}],
        "tool_choice": "none",
    })
    assert ok.status_code == 200, ok.text[:200]

    gemini_none = _post(base, "/v1beta/models/gemini-3.5-flash-lite:generateContent", {
        "contents": [{"role": "user", "parts": [{"text": "NORMAL_OK"}]}],
        "tools": [{"functionDeclarations": [{"name": "get_weather", "parameters": schema}]}],
        "toolConfig": {"functionCallingConfig": {"mode": "NONE"}},
    })
    assert gemini_none.status_code == 200, gemini_none.text[:200]


# ==================== 协议契约修正 (P1) ====================


def _collect_sse(resp) -> list[tuple[str, Any]]:
    """收集 (event_name_or_empty, parsed_payload_or_raw_string)。"""
    resp.encoding = "utf-8"
    events: list[tuple[str, Any]] = []
    current_event = ""
    for raw in resp.iter_lines(decode_unicode=True):
        if not raw:
            continue
        line = raw.strip()
        if line.startswith("event:"):
            current_event = line[len("event:"):].strip()
        elif line.startswith("data:"):
            payload = line[len("data:"):].strip()
            if payload == "[DONE]":
                events.append((current_event, "[DONE]"))
                continue
            try:
                events.append((current_event, json.loads(payload)))
            except json.JSONDecodeError:
                events.append((current_event, payload))
    return events


@pytest.mark.smoke
def test_gemini_stream_has_no_done_marker_and_ends_with_finish_reason(matrix_stack):
    """Gemini 官方流式没有 [DONE]; 以带 finishReason 的最终候选事件收尾。"""
    r = _post(matrix_stack["base_url"],
              "/v1beta/models/gemini-3.1-pro:streamGenerateContent",
              {"contents": [{"role": "user", "parts": [{"text": "MOCK_ANSWER"}]}]},
              stream=True)
    assert r.status_code == 200, r.text[:200]
    events = _collect_sse(r)

    assert events, "流式响应为空"
    assert all(payload != "[DONE]" for _, payload in events), \
        f"Gemini 流不应出现 [DONE]: {events[-3:]}"

    candidates = [p for _, p in events if isinstance(p, dict) and p.get("candidates")]
    assert candidates, f"缺少候选事件: {events}"
    assert candidates[-1]["candidates"][0].get("finishReason") == "STOP", \
        f"最后一个候选事件应带 finishReason: {candidates[-1]}"


@pytest.mark.smoke
def test_responses_stream_emits_full_semantic_event_sequence(matrix_stack):
    """Responses 流式必须是完整语义事件序列, 且没有 [DONE]。"""
    r = _post(matrix_stack["base_url"], "/v1/responses", {
        "model": "deepseek-v4-pro-think",
        "input": "MOCK_ANSWER",
        "stream": True,
    }, stream=True)
    assert r.status_code == 200, r.text[:200]
    events = _collect_sse(r)
    types = [p.get("type") for _, p in events if isinstance(p, dict)]

    assert all(payload != "[DONE]" for _, payload in events), "Responses 流不应出现 [DONE]"
    for expected in (
        "response.created",
        "response.in_progress",
        "response.output_item.added",
        "response.content_part.added",
        "response.output_text.delta",
        "response.output_text.done",
        "response.content_part.done",
        "response.output_item.done",
        "response.completed",
    ):
        assert expected in types, f"缺少事件 {expected}; 实际顺序: {types}"

    # 顺序契约: output_item.added 必须早于任何 delta
    assert types.index("response.output_item.added") < types.index("response.output_text.delta")
    assert types[-1] == "response.completed"

    # 每个 delta 都必须带齐索引字段
    deltas = [p for _, p in events if isinstance(p, dict)
              and p.get("type") == "response.output_text.delta"]
    assert deltas, "缺少 output_text.delta"
    for d in deltas:
        assert d.get("item_id"), d
        assert d.get("output_index") == 0, d
        assert d.get("content_index") == 0, d
        assert d.get("delta"), d

    completed = [p for _, p in events if isinstance(p, dict)
                 and p.get("type") == "response.completed"][-1]
    assert completed["response"]["status"] == "completed"
    assert completed["response"]["output"], "completed 事件应带上最终 output"


@pytest.mark.smoke
def test_all_four_protocols_map_upstream_1135_to_429_with_retry_after(matrix_stack):
    """上游 1135 在四个端点都应是 429, 且【都带 Retry-After】(客户端需要知道等多久)。

    ⚠️ 本用例必须留在 matrix_stack 组的【最后】: 四个模型同时 1135 会触发账号级冷却,
    之后该实例上的所有请求都会被本地拦下。
    """
    base = matrix_stack["base_url"]
    models = {
        "openai": "gpt-5.6-luna",
        "responses": "deepseek-v4-flash",
        "anthropic": "claude-haiku-5.5",
        "gemini": "gemini-3.0-pro",
    }
    for protocol, model in models.items():
        r = _post_protocol(base, protocol, model, "MOCK_1135_MIN")
        assert r.status_code == 429, f"{protocol}: {r.status_code} {r.text[:200]}"
        retry_after = r.headers.get("Retry-After")
        assert retry_after is not None, f"{protocol} 的 429 缺少 Retry-After: {dict(r.headers)}"
        assert int(retry_after) >= 1
        assert "rate_limit" in r.text.lower() or "RESOURCE_EXHAUSTED" in r.text, \
            f"{protocol} 错误语义不统一: {r.text[:200]}"

# ==================== 门控生命周期 (成功判定 / 半开探测 / 超时) ====================


@pytest.mark.smoke
def test_failed_half_open_probe_keeps_account_cooldown(probe_stack):
    """半开探测失败绝不能解除账号冷却 (HTTP 200 到达不是"账号已恢复"的证据)。

    旧实现一收到 HTTP 200 就 recordUpstreamSuccess(), 于是探测请求先把账号冷却清空,
    再在 SSE 里读到业务码 —— 等于用一次失败证明账号恢复了, 下一个请求立刻又撞墙。
    """
    base = probe_stack["base_url"]

    # 三个不同模型都 1135 -> 判定账号级枯竭, 冷却按上游告知的 1 分钟
    for model in ("gpt-5.6-sol", "gpt-5.6-terra", "kimi-k3"):
        r = _post(base, "/v1/chat/completions", {
            "model": model,
            "messages": [{"role": "user", "content": "MOCK_1135_MIN"}],
            "stream": False,
        })
        assert r.status_code == 429, r.text
        assert r.json()["error"]["upstream_code"] == 1135

    calls_before_probe = len(probe_stack["state"].snapshot())

    # 等半开探测窗口打开, 放一个探测请求出去: 上游回 HTTP 200 但只有 [DONE], 无有效载荷
    time.sleep(3.2)
    probe = _post(base, "/v1/chat/completions", {
        "model": "qwen3.8-max",
        "messages": [{"role": "user", "content": "MOCK_EMPTY_OK"}],
        "stream": False,
    })
    assert len(probe_stack["state"].snapshot()) == calls_before_probe + 1, "探测请求应已触达上游"
    assert probe.status_code != 200, f"没有任何有效载荷, 不应返回 200: {probe.text[:200]}"

    # 冷却必须仍然生效: 下一个请求应被本地拦下, 不触达上游
    blocked = _post(base, "/v1/chat/completions", {
        "model": "glm-5.3-flash",
        "messages": [{"role": "user", "content": "NORMAL_OK"}],
        "stream": False,
    })
    assert blocked.status_code == 429, blocked.text
    assert blocked.headers.get("X-Model-Rate-Limited") == "1"
    assert int(blocked.headers["Retry-After"]) >= 1
    assert len(probe_stack["state"].snapshot()) == calls_before_probe + 1, \
        "账号冷却期内不应触达上游"


@pytest.mark.smoke
def test_silent_response_body_times_out_and_frees_slot(timeout_stack):
    """响应头到了但正文卡死 -> 流空闲超时 (504), 且并发槽位必须释放。

    旧实现的定时器在【收到响应头时就 clearTimeout】, 卡死的响应体完全不受约束:
    客户端会一直挂到自己的读超时, 并发槽位也被占住。
    """
    base = timeout_stack["base_url"]

    start = time.time()
    hung = _post(base, "/v1/chat/completions", {
        "model": "gpt-5.6-luna",
        "messages": [{"role": "user", "content": "MOCK_HANG_BODY"}],
        "stream": False,
    })
    elapsed = time.time() - start
    assert hung.status_code == 504, f"{hung.status_code} {hung.text[:300]}"
    assert hung.json()["error"]["type"] == "timeout_error", hung.text[:300]
    assert hung.headers.get("Retry-After") is not None, "超时响应也应带 Retry-After"
    assert elapsed < 8, f"应在流空闲超时内返回, 实际 {elapsed:.1f}s"

    # 槽位必须已释放: 后续请求不该被那次超时卡住
    start = time.time()
    ok = _post(base, "/v1/chat/completions", {
        "model": "gpt-5.6-luna",
        "messages": [{"role": "user", "content": "NORMAL_AFTER_HANG"}],
        "stream": False,
    })
    assert ok.status_code == 200, ok.text[:200]
    assert time.time() - start < 5, "超时后并发槽位未释放"


@pytest.mark.smoke
def test_header_timeout_maps_to_504(timeout_stack):
    """响应头都不到 -> 响应头超时 504 (三段超时的第一段)。"""
    start = time.time()
    r = _post(timeout_stack["base_url"], "/v1/chat/completions", {
        "model": "gemini-3.6-flash",
        "messages": [{"role": "user", "content": "MOCK_HANG_HEADERS"}],
        "stream": False,
    })
    elapsed = time.time() - start
    assert r.status_code == 504, f"{r.status_code} {r.text[:300]}"
    assert r.json()["error"]["type"] == "timeout_error"
    assert elapsed < 8, f"响应头超时应生效, 实际 {elapsed:.1f}s"


@pytest.mark.smoke
def test_timeout_maps_to_504_on_all_protocols(timeout_stack):
    """流空闲超时在四个端点上都要暴露成 504 (流式端点在头已发出后发协议原生错误事件)。"""
    base = timeout_stack["base_url"]
    models = {
        "openai": "glm-5",
        "responses": "llama-3.1-405b",
        "anthropic": "claude-fable-5.1",
        "gemini": "gemini-3.5-flash",
    }
    for protocol, model in models.items():
        r = _post_protocol(base, protocol, model, "MOCK_HANG_BODY", stream=False)
        assert r.status_code == 504, f"{protocol}: {r.status_code} {r.text[:250]}"
        assert "timeout" in r.text.lower() or "DEADLINE_EXCEEDED" in r.text, \
            f"{protocol}: {r.text[:250]}"
        assert r.headers.get("Retry-After") is not None, protocol


@pytest.mark.smoke
def test_openai_stream_timeout_surfaces_real_error_frame(timeout_stack):
    """流式端点在响应头已发出后遇到卡死: 必须发一条超时错误帧而不是静默挂断。"""
    r = _post(timeout_stack["base_url"], "/v1/chat/completions", {
        "model": "claude-sonnet-4.6-think",
        "messages": [{"role": "user", "content": "MOCK_HANG_BODY"}],
        "stream": True,
    }, stream=True)
    assert r.status_code == 200, r.text[:200]
    events = _collect_sse(r)

    error_frames = [p for _, p in events
                    if isinstance(p, dict) and p.get("error")]
    assert error_frames, f"流式超时应发出错误帧: {events[-5:]}"
    assert error_frames[-1]["error"]["type"] == "timeout_error", error_frames[-1]
    assert any(p == "[DONE]" for _, p in events), "OpenAI 流应以 [DONE] 收尾"


# ==================== 官方 SDK 契约 (常驻 mock 驱动, 零额度) ====================
# 原 probe_sdk_compat.py 只在人工触发时用真实额度验证官方 SDK 能否跑通; 这里把同样的
# 契约固化成常驻用例: mock 上游 -> deno 实例 -> 官方 SDK 客户端, 全程零上游成本。
# 一旦协议事件结构回归 (例如又发出 [DONE]、漏发 output_item.added), 这些用例立刻变红。


@pytest.mark.smoke
def test_official_openai_sdk_streams_chat_completions(mock_stack):
    """openai SDK 的 chat.completions 流式解析必须干净跑完。"""
    openai = pytest.importorskip("openai")
    cli = openai.OpenAI(base_url=mock_stack["base_url"] + "/v1", api_key=AUTH_TOKEN)

    pieces: list[str] = []
    with cli.chat.completions.create(
        model="gpt-5.5",
        messages=[{"role": "user", "content": "MOCK_ANSWER"}],
        stream=True,
    ) as stream:
        for chunk in stream:
            if chunk.choices and chunk.choices[0].delta.content:
                pieces.append(chunk.choices[0].delta.content)

    assert "".join(pieces), "openai SDK 未取到任何内容"


@pytest.mark.smoke
def test_official_openai_sdk_streams_responses_api(mock_stack):
    """openai SDK 的 Responses 流式解析必须干净跑完 (事件类型齐全、无 [DONE] 依赖)。"""
    openai = pytest.importorskip("openai")
    cli = openai.OpenAI(base_url=mock_stack["base_url"] + "/v1", api_key=AUTH_TOKEN)

    types: list[str] = []
    pieces: list[str] = []
    for event in cli.responses.create(
        model="deepseek-v4-pro",
        input="MOCK_ANSWER",
        stream=True,
    ):
        etype = getattr(event, "type", None)
        if etype:
            types.append(etype)
        if etype == "response.output_text.delta":
            pieces.append(event.delta)

    assert "".join(pieces), f"Responses 流未取到内容; 事件序列: {types}"
    assert types[-1] == "response.completed", f"事件序列应以 response.completed 收尾: {types}"
    assert "response.output_item.added" in types, types


@pytest.mark.smoke
def test_official_google_genai_sdk_streams_generate_content(mock_stack):
    """google-genai SDK 的流式解析必须干净跑完 (无 [DONE] 依赖)。"""
    genai = pytest.importorskip("google.genai")
    from google.genai import types as genai_types

    cli = genai.Client(
        api_key=AUTH_TOKEN,
        http_options=genai_types.HttpOptions(base_url=mock_stack["base_url"]),
    )

    pieces: list[str] = []
    for chunk in cli.models.generate_content_stream(
        model="gemini-2.5-pro",
        contents="MOCK_ANSWER",
    ):
        if chunk.text:
            pieces.append(chunk.text)

    assert "".join(pieces), "google-genai SDK 未取到任何内容"


@pytest.mark.smoke
def test_official_anthropic_sdk_streams_messages(mock_stack):
    """anthropic SDK 的 Messages 流式解析必须干净跑完 (content-block 状态机成对)。"""
    anthropic = pytest.importorskip("anthropic")
    cli = anthropic.Anthropic(base_url=mock_stack["base_url"], api_key=AUTH_TOKEN)

    pieces: list[str] = []
    with cli.messages.stream(
        model="claude-sonnet-4.6",
        max_tokens=128,
        messages=[{"role": "user", "content": "MOCK_ANSWER"}],
    ) as stream:
        for text in stream.text_stream:
            pieces.append(text)

    assert "".join(pieces), "anthropic SDK 未取到任何内容"
