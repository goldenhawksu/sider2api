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

    def add(self, body: dict[str, Any]) -> int:
        with self._lock:
            self.requests.append(body)
            return len(self.requests)

    def snapshot(self) -> list[dict[str, Any]]:
        with self._lock:
            return list(self.requests)

    def clear(self) -> None:
        with self._lock:
            self.requests.clear()


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
                self.wfile.write(item)
                self.wfile.flush()

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
        "UPSTREAM_TIMEOUT_MS": "5000",
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
        "model": "gpt-5.1",
        "messages": [{"role": "user", "content": "MOCK_WARNING_AFTER_TEXT"}],
        "stream": False,
    })
    assert r.status_code == 200, r.text
    assert _openai_text(r.json()) == "正文仍然保留"
    assert "生成完成" not in r.text


@pytest.mark.smoke
def test_openai_stop_sequence_and_max_tokens_are_applied(mock_stack):
    stop_resp = _post(mock_stack["base_url"], "/v1/chat/completions", {
        "model": "gpt-5.4",
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
def test_image_generation_has_no_process_global_concurrency_lock(mock_stack):
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
def test_derived_session_id_is_scoped_by_caller_fingerprint(mock_stack):
    prompt = f"MOCK_SESSION_ISOLATION_{uuid4().hex}"
    body = {
        "model": "grok-4",
        "messages": [{"role": "user", "content": prompt}],
        "stream": False,
    }

    alice = _post(mock_stack["base_url"], "/v1/chat/completions", body, headers={"X-User-ID": "alice"})
    bob = _post(mock_stack["base_url"], "/v1/chat/completions", body, headers={"X-User-ID": "bob"})

    assert alice.status_code == 200, alice.text
    assert bob.status_code == 200, bob.text
    assert alice.headers["X-Session-ID"] != bob.headers["X-Session-ID"]

    upstream_requests = mock_stack["state"].snapshot()
    assert len(upstream_requests) == 2
    assert not upstream_requests[0].get("cid")
    assert not upstream_requests[1].get("cid")


# ==================== 上游门控优化 (熔断时长/并发闸门/账号级/AIMD) ====================


@pytest.mark.smoke
def test_1135_breaker_follows_upstream_reported_duration(mock_stack):
    """1135 应按上游消息里告知的时长熔断, 而不是按模型类型拍脑袋。

    取 opus 模型: 旧逻辑一律罚 1 小时, 哪怕上游只说"1 分钟" —— 白白闲置 59 分钟的可用额度。
    """
    model = "claude-opus-4.6"
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
    model = "gpt-5.1"
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
def test_account_level_quota_exhaustion_blocks_untouched_model(gate_stack):
    """多个模型短时内都 1135 -> 判定账号级枯竭, 未试过的模型也直接拒, 不再逐个试探。"""
    for model in ("gpt-5-mini", "gpt-5.4", "grok-4.6"):
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
        "model": "gpt-5.4",
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
        "model": "gpt-5.4",
        "messages": [{"role": "user", "content": "NORMAL_AFTER_EARLY_RETURN"}],
        "stream": False,
    })
    elapsed = time.time() - start
    assert second.status_code == 200, second.text[:200]
    assert elapsed < 5, f"槽位未及时释放, 后续请求耗时 {elapsed:.1f}s"


@pytest.mark.smoke
def test_quota_exhaustion_blocks_and_isolates_by_model(quota_stack):
    """固定配额下: 第 7 次被拦, 错误格式规范, 且不波及其他模型。

    覆盖原 test_rate_limit.py 中打真实上游的三个用例 (after_6_calls / isolation /
    error_format), 迁到 mock 后零额度且不受 AIMD 配额增长影响。
    """
    base, model, other = quota_stack["base_url"], "gpt-5-mini", "gpt-5.1"

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
