"""可靠性缺口的四协议集成回归，全部使用本地上游。"""
import json
import re
import socket
import time
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import pytest
import requests

from test_deno_pro_mock_regression import _headers, _launch_stack, _post, _prompt_from_sider_body


@pytest.fixture(scope="module")
def reliability_stack():
    with _launch_stack({"RATE_LIMIT_ENABLED": "false", "UPSTREAM_MAX_CONCURRENCY": "2"}) as stack:
        yield stack


def _request(protocol, messages=None, model="gpt-5.5", stream=False):
    messages = messages if messages is not None else [{"role": "user", "content": "ok"}]
    if protocol == "gemini":
        action = "streamGenerateContent" if stream else "generateContent"
        return f"/v1beta/models/{model}:{action}", {"contents": [
            {"role": "model" if m["role"] == "assistant" else m["role"],
             "parts": [{"text": m["content"]}]} for m in messages
        ]}
    body = {"model": model, "stream": stream}
    if protocol == "responses":
        body["input"] = messages
        return "/v1/responses", body
    body["messages"] = messages
    if protocol == "anthropic":
        body["max_tokens"] = 128
        return "/v1/messages", body
    return "/v1/chat/completions", body


PROTOCOLS = ["openai", "responses", "anthropic", "gemini"]


@pytest.mark.smoke
@pytest.mark.parametrize("protocol", PROTOCOLS)
@pytest.mark.parametrize("invalid", ["json", "null", "array", "empty", "container", "item", "role", "role_null", "content", "empty_text", "empty_blocks", "block", "text_type", "unknown", "audio", "mixed"])
def test_invalid_input_never_reaches_upstream(reliability_stack, protocol, invalid):
    stack = reliability_stack
    path, body = _request(protocol)
    key = "contents" if protocol == "gemini" else "input" if protocol == "responses" else "messages"
    if invalid in {"json", "null", "array"}:
        raw = {"json": "{", "null": "null", "array": "[]"}[invalid]
    else:
        if invalid == "empty":
            body[key] = []
        elif invalid == "container":
            body[key] = {}
        elif invalid == "item":
            body[key] = [None]
        elif invalid == "role":
            body[key][0]["role"] = "bogus"
        elif invalid == "role_null":
            body[key][0]["role"] = None
        else:
            content_key = "parts" if protocol == "gemini" else "content"
            if invalid == "content":
                value = 17
            elif invalid == "empty_text":
                value = [{"text": ""}] if protocol == "gemini" else ""
            elif invalid == "empty_blocks":
                value = []
            elif invalid == "block":
                value = [None]
            elif invalid == "text_type":
                value = [{"text": 17}] if protocol == "gemini" else [{"type": "text", "text": 17}]
            else:
                audio = {"inlineData": {"mimeType": "audio/wav", "data": "AA=="}} if protocol == "gemini" else {"type": "input_audio", "input_audio": {"data": "AA==", "format": "wav"}}
                text = {"text": "hello"} if protocol == "gemini" else {"type": "text", "text": "hello"}
                value = ([{"unknown": {}}] if protocol == "gemini" else [{"type": "unknown"}]) if invalid == "unknown" else [audio] if invalid == "audio" else [text, audio]
            body[key][0][content_key] = value
        raw = json.dumps(body)
    before = len(stack["state"].snapshot())
    response = requests.post(stack["base_url"] + path, headers=_headers(), data=raw, timeout=5)
    assert response.status_code == (422 if invalid in {"unknown", "audio", "mixed"} else 400), response.text
    payload = response.json()
    if protocol == "gemini":
        assert payload["error"]["status"] in {"INVALID_ARGUMENT", "UNIMPLEMENTED"}
    elif protocol == "anthropic":
        assert payload["type"] == "error"
    assert response.headers.get("X-Request-ID")
    assert len(stack["state"].snapshot()) == before


@pytest.mark.smoke
@pytest.mark.parametrize("protocol", PROTOCOLS)
@pytest.mark.parametrize("model", ["constructor", "toString", "__proto__", "hasOwnProperty"])
def test_prototype_model_is_rejected(reliability_stack, protocol, model):
    path, body = _request(protocol, model=model)
    before = len(reliability_stack["state"].snapshot())
    response = _post(reliability_stack["base_url"], path, body)
    assert response.status_code == 404, response.text
    assert len(reliability_stack["state"].snapshot()) == before


@pytest.mark.smoke
@pytest.mark.parametrize("protocol", PROTOCOLS)
@pytest.mark.parametrize("label", ["[1m]", " [200k]"])
def test_registered_model_window_label_is_only_an_alias(reliability_stack, protocol, label):
    path, body = _request(protocol, model="gpt-5.5" + label)
    response = _post(reliability_stack["base_url"], path, body)
    assert response.status_code == 200, response.text
    assert reliability_stack["state"].snapshot()[-1]["model"] == "gpt-5.5"
    path, body = _request(protocol, model="unknown" + label)
    before = len(reliability_stack["state"].snapshot())
    assert _post(reliability_stack["base_url"], path, body).status_code == 404
    assert len(reliability_stack["state"].snapshot()) == before


@pytest.mark.smoke
@pytest.mark.parametrize("protocol", ["openai", "responses", "anthropic"])
@pytest.mark.parametrize("field,value", [("model", None), ("model", {}), ("model", 1), ("model", ""), ("stream", "false")])
def test_model_and_stream_types_are_validated(reliability_stack, protocol, field, value):
    path, body = _request(protocol)
    body[field] = value
    before = len(reliability_stack["state"].snapshot())
    response = _post(reliability_stack["base_url"], path, body)
    assert response.status_code == 400, response.text
    assert len(reliability_stack["state"].snapshot()) == before


@pytest.mark.smoke
@pytest.mark.parametrize("protocol", PROTOCOLS)
def test_early_rejection_records_requested_model_and_completion_log(reliability_stack, protocol):
    stack = reliability_stack
    path, body = _request(protocol, model="gpt-5.5")
    key = "contents" if protocol == "gemini" else "input" if protocol == "responses" else "messages"
    field = "parts" if protocol == "gemini" else "content"
    body[key][0][field] = [{"unknown": {}}] if protocol == "gemini" else [{"type": "unknown"}]
    def failures():
        snapshot = requests.get(stack["base_url"] + "/stats.json", timeout=5).json()
        return next((row["failures"] for row in snapshot["models"] if row["model"] == "gpt-5.5"), 0)
    before = failures()
    request_id = "early-" + uuid4().hex
    response = _post(stack["base_url"], path, body, headers={"X-Request-ID": request_id})
    assert response.status_code == 422, response.text
    assert failures() == before + 1
    assert response.headers["X-Request-ID"] == request_id
    deadline = time.time() + 2
    while time.time() < deadline:
        logs = [line for line in stack["logs"] if request_id in line and "[请求完成]" in line]
        if logs:
            break
        time.sleep(0.01)
    assert len(logs) == 1
    assert '"externalModel":"gpt-5.5"' in logs[0]


def _word_count(text):
    cjk = re.findall(r"[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]", text)
    rest = re.sub(r"[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]", " ", text)
    return len(cjk) + len(rest.split())


@pytest.mark.smoke
@pytest.mark.parametrize("protocol", PROTOCOLS)
@pytest.mark.parametrize("history", ["word " * 5994, "中" * 5994, "中 word " * 2997, "a" * 49450], ids=["english", "chinese", "mixed", "chars"])
@pytest.mark.parametrize("stream", [False, True])
def test_final_context_budget_and_visible_trimming(reliability_stack, protocol, history, stream):
    path, body = _request(protocol, [
        {"role": "user", "content": history}, {"role": "assistant", "content": "answer"},
        {"role": "user", "content": "question"},
    ], stream=stream)
    response = _post(reliability_stack["base_url"], path, body)
    assert response.status_code == 200, response.text
    prompt = _prompt_from_sider_body(reliability_stack["state"].snapshot()[-1])
    assert len(prompt) <= 49500
    assert _word_count(prompt) <= 6000
    assert response.headers.get("X-Context-Truncated") == "true"
    assert "X-Context-Truncated" in response.headers.get("Access-Control-Expose-Headers", "")
    assert "question" in prompt


@pytest.mark.smoke
@pytest.mark.parametrize("protocol", PROTOCOLS)
@pytest.mark.parametrize("boundary", ["words", "chars"])
def test_exact_final_budget_is_accepted_without_trimming(reliability_stack, protocol, boundary):
    prefix = "[Conversation History]\nUser: "
    suffix = "\n\n---\n\n[Current User]\nq"
    history = "word " * 5993 if boundary == "words" else "a" * (49500 - len(prefix + suffix))
    path, body = _request(protocol, [{"role": "user", "content": history}, {"role": "user", "content": "q"}])
    response = _post(reliability_stack["base_url"], path, body)
    assert response.status_code == 200, response.text
    assert response.headers["X-Context-Truncated"] == "false"
    prompt = _prompt_from_sider_body(reliability_stack["state"].snapshot()[-1])
    assert (_word_count(prompt) if boundary == "words" else len(prompt)) == (6000 if boundary == "words" else 49500)


@pytest.mark.smoke
@pytest.mark.parametrize("stream", [False, True])
@pytest.mark.parametrize("failure", ["MOCK_TERMINAL_AFTER_TEXT", "MOCK_EOF_AFTER_TEXT", "MOCK_EMPTY_OK", "MOCK_MAX"])
def test_failed_or_limited_turn_keeps_completed_checkpoint(reliability_stack, stream, failure):
    base = reliability_stack["base_url"]
    headers = {"X-Session-ID": uuid4().hex}
    path, body = _request("openai")
    assert _post(base, path, body, headers=headers).status_code == 200
    first_seq = len(reliability_stack["state"].snapshot())
    body["messages"][0]["content"] = failure
    body["stream"] = stream
    if failure == "MOCK_MAX":
        body["max_tokens"] = 1
    failed = _post(base, path, body, headers=headers)
    assert failed.status_code in {200, 502}, failed.text
    path, body = _request("openai")
    assert _post(base, path, body, headers=headers).status_code == 200
    latest = reliability_stack["state"].snapshot()[-1]
    assert latest["parent_message_id"] == f"mock-assistant-{first_seq}"


@pytest.mark.smoke
@pytest.mark.parametrize("stream", [False, True])
def test_successful_turn_commits_checkpoint(reliability_stack, stream):
    headers = {"X-Session-ID": uuid4().hex}
    path, body = _request("openai", stream=stream)
    response = _post(reliability_stack["base_url"], path, body, headers=headers)
    assert response.status_code == 200, response.text
    first_seq = len(reliability_stack["state"].snapshot())
    path, body = _request("openai")
    assert _post(reliability_stack["base_url"], path, body, headers=headers).status_code == 200
    assert reliability_stack["state"].snapshot()[-1]["parent_message_id"] == f"mock-assistant-{first_seq}"


@pytest.mark.smoke
def test_same_session_serializes_before_reading_parent_and_binds_model(reliability_stack):
    stack = reliability_stack
    headers = {"X-Session-ID": uuid4().hex}
    path, body = _request("openai", [{"role": "user", "content": "MOCK_SLOW"}])
    before = len(stack["state"].snapshot())
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(_post, stack["base_url"], path, body, headers=headers)
        deadline = time.time() + 2
        while len(stack["state"].snapshot()) == before and time.time() < deadline:
            time.sleep(0.01)
        second = pool.submit(_post, stack["base_url"], path, body, headers=headers)
        assert first.result().status_code == second.result().status_code == 200
    sent = stack["state"].snapshot()[before:]
    assert sent[1].get("cid") == f"mock-cid-{before + 1}"
    assert sent[1].get("parent_message_id") == f"mock-assistant-{before + 1}"
    body["model"] = "grok-4"
    response = _post(stack["base_url"], path, body, headers=headers)
    assert response.status_code == 400, response.text
    assert "session_model_mismatch" in response.text
    assert len(stack["state"].snapshot()) == before + 2


@pytest.mark.smoke
def test_disconnected_turn_does_not_advance_session(reliability_stack):
    stack = reliability_stack
    sid = uuid4().hex
    headers = {"X-Session-ID": sid}
    path, body = _request("openai")
    assert _post(stack["base_url"], path, body, headers=headers).status_code == 200
    checkpoint_seq = len(stack["state"].snapshot())
    path, body = _request("openai", [{"role": "user", "content": "MOCK_LONG_STREAM"}], stream=True)
    payload = json.dumps(body).encode()
    port = int(stack["base_url"].rsplit(":", 1)[1])
    with socket.create_connection(("127.0.0.1", port), timeout=3) as conn:
        conn.sendall((f"POST {path} HTTP/1.1\r\nHost: localhost\r\n"
                      f"Authorization: {_headers()['Authorization']}\r\nX-Session-ID: {sid}\r\n"
                      f"Content-Type: application/json\r\nContent-Length: {len(payload)}\r\n\r\n").encode() + payload)
        received = b""
        while b"part-0" not in received:
            received += conn.recv(4096)
    path, body = _request("openai")
    response = _post(stack["base_url"], path, body, headers=headers)
    assert response.status_code == 200, response.text
    assert stack["state"].snapshot()[-1]["parent_message_id"] == f"mock-assistant-{checkpoint_seq}"


@pytest.mark.smoke
def test_deadline_includes_queue_and_heartbeats_and_frees_resources():
    with _launch_stack({
        "RATE_LIMIT_ENABLED": "false", "UPSTREAM_MAX_CONCURRENCY": "1",
        "UPSTREAM_TOTAL_TIMEOUT_MS": "1000", "REQUEST_TIMEOUT_RESERVE_MS": "100",
        "UPSTREAM_HEADER_TIMEOUT_MS": "5000", "UPSTREAM_STREAM_IDLE_TIMEOUT_MS": "5000",
        "SSE_PING_INTERVAL_MS": "25",
    }) as stack:
        path, body = _request("openai", [{"role": "user", "content": "MOCK_SLOW"}])
        with ThreadPoolExecutor(max_workers=1) as pool:
            first = pool.submit(_post, stack["base_url"], path, body)
            deadline = time.time() + 2
            while not stack["state"].snapshot() and time.time() < deadline:
                time.sleep(0.01)
            start = time.monotonic()
            response = _post(stack["base_url"], path, body)
            assert first.result().status_code == 200
        assert response.status_code == 504, response.text
        assert time.monotonic() - start < 1.25
        for protocol in PROTOCOLS:
            path, body = _request(protocol, [{"role": "user", "content": "MOCK_LONG_STREAM"}], stream=True)
            start = time.monotonic()
            response = _post(stack["base_url"], path, body)
            assert "timeout" in response.text.lower() or "DEADLINE_EXCEEDED" in response.text
            assert time.monotonic() - start < 1.25
        for marker in ["MOCK_HANG_HEADERS", "MOCK_HANG_BODY", "MOCK_HTTP_SLOW_BODY"]:
            path, body = _request("openai", [{"role": "user", "content": marker}])
            start = time.monotonic()
            response = _post(stack["base_url"], path, body)
            assert response.status_code == 504, response.text
            assert time.monotonic() - start < 1.25
        # 请求体停在半途中也必须在总期限内收尾，不能等到客户端读超时。
        port = int(stack["base_url"].rsplit(":", 1)[1])
        with socket.create_connection(("127.0.0.1", port), timeout=3) as conn:
            start = time.monotonic()
            conn.sendall(("POST /v1/chat/completions HTTP/1.1\r\nHost: localhost\r\n"
                          f"Authorization: {_headers()['Authorization']}\r\n"
                          "Content-Type: application/json\r\nContent-Length: 1000\r\n\r\n{").encode())
            received = conn.recv(4096)
            assert b"504" in received, received
            assert time.monotonic() - start < 1.25
        path, body = _request("openai")
        assert _post(stack["base_url"], path, body).status_code == 200
