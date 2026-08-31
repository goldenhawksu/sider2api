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
    if "MOCK_1135" in prompt:
        return [_frame({"code": 1135, "msg": "quota exhausted", "data": None}), _done()], delay
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


@pytest.fixture(scope="session")
def mock_stack():
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
