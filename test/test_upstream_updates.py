"""上游更新移植回归：仅使用本地模拟服务。"""
import json
import time
from uuid import uuid4

import pytest
import requests

from test_deno_pro_mock_regression import AUTH_TOKEN, _headers, _launch_stack, _post
from test_deno_pro_reliability import PROTOCOLS, _request

pytestmark = pytest.mark.smoke


@pytest.mark.parametrize("protocol", PROTOCOLS)
@pytest.mark.parametrize("marker,status", [("MOCK_1135_MIN", 429), ("MOCK_603", 400)])
def test_stream_error_before_content_is_http(protocol, marker, status):
    with _launch_stack() as stack:
        path, body = _request(protocol, [{"role": "user", "content": marker}], stream=True)
        response = _post(stack["base_url"], path, body)
        assert response.status_code == status, response.text
        assert "application/json" in response.headers["Content-Type"]
        assert response.headers.get("X-Request-ID")
        if status == 429:
            assert response.headers["Retry-After"] == "60"
        else:
            assert "Retry-After" not in response.headers
        assert len(stack["state"].snapshot()) == 1


@pytest.mark.parametrize("protocol", PROTOCOLS)
@pytest.mark.parametrize("window", ["0", "50"])
def test_stream_error_after_commit_keeps_retry_details(protocol, window):
    with _launch_stack({"STREAM_COMMIT_WINDOW_MS": window, "SSE_PING_INTERVAL_MS": "10"}) as stack:
        path, body = _request(protocol, [{"role": "user", "content": "MOCK_SLOW_1135"}], stream=True)
        response = _post(stack["base_url"], path, body)
        assert response.status_code == 200
        assert "retry_after" in response.text
        assert "error" in response.text.lower()


@pytest.mark.parametrize("protocol", PROTOCOLS)
def test_partial_output_stays_streaming_on_failure(protocol):
    with _launch_stack() as stack:
        path, body = _request(protocol, [{"role": "user", "content": "MOCK_TERMINAL_AFTER_TEXT"}], stream=True)
        response = _post(stack["base_url"], path, body)
        assert response.status_code == 200
        assert "partial before failure" in response.text
        assert "terminal failure" in response.text


@pytest.mark.parametrize("open_auth,status", [("false", 503), ("true", 404)])
def test_unconfigured_auth_requires_explicit_open_mode(open_auth, status):
    with _launch_stack({"AUTH_TOKEN": "", "ALLOW_OPEN_AUTH": open_auth}) as stack:
        path, body = _request("openai", model="unknown")
        response = requests.post(stack["base_url"] + path, json=body, timeout=5)
        assert response.status_code == status
        assert not stack["state"].snapshot()


def test_management_and_stats_credentials_are_separate():
    with _launch_stack({"ADMIN_TOKEN": "admin-only", "STATS_TOKEN": "stats-only"}) as stack:
        base = stack["base_url"]
        page = requests.get(base + "/admin", timeout=5)
        assert page.status_code == 200 and "请输入管理凭证" in page.text
        assert requests.get(base + "/api/admin/models", headers=_headers(), timeout=5).status_code == 401
        assert requests.get(base + "/api/admin/models", headers={"x-api-key": "admin-only"}, timeout=5).status_code == 200
        for token in ["admin-only", "stats-only"]:
            path, body = _request("openai", model="unknown")
            assert requests.post(base + path, headers={"x-api-key": token}, json=body, timeout=5).status_code == 401
        for path in ["/stats", "/stats.json"]:
            assert requests.get(base + path, timeout=5).status_code == 401
            for token in [AUTH_TOKEN, "stats-only", "admin-only"]:
                assert requests.get(base + path, headers={"x-api-key": token}, timeout=5).status_code == 200
        session = requests.Session()
        login = session.post(base + "/stats/login", json={"token": "stats-only"}, timeout=5)
        assert login.status_code == 200
        cookie = login.headers["Set-Cookie"]
        assert "HttpOnly" in cookie and "SameSite=Strict" in cookie and "stats-only" not in cookie
        assert session.get(base + "/stats", timeout=5).status_code == 200
        assert session.get(base + "/stats.json", timeout=5).status_code == 200
        assert session.post(base + "/stats/logout", timeout=5).status_code == 200
        assert session.get(base + "/stats.json", timeout=5).status_code == 401
        assert requests.post(base + "/stats/login", json={"token": "wrong"}, timeout=5).status_code == 401


@pytest.mark.parametrize("protocol", PROTOCOLS)
@pytest.mark.parametrize("chunked", [False, True])
def test_body_limit_counts_bytes_before_upstream(protocol, chunked):
    with _launch_stack({"MAX_REQUEST_BODY_BYTES": "1024"}) as stack:
        path, body = _request(protocol, [{"role": "user", "content": "中" * 400}])
        raw = json.dumps(body, ensure_ascii=False).encode()
        data = (raw[i:i + 73] for i in range(0, len(raw), 73)) if chunked else raw
        response = requests.post(stack["base_url"] + path, headers=_headers(), data=data, timeout=5)
        assert response.status_code == 413, response.text
        assert not stack["state"].snapshot()
        path, body = _request(protocol)
        assert _post(stack["base_url"], path, body).status_code == 200


def test_hourly_totals_outlive_recent_detail_limit():
    with _launch_stack({"STATS_KV": "", "RATE_LIMIT_ENABLED": "false"}) as stack:
        path, body = _request("openai")
        for _ in range(205):
            assert _post(stack["base_url"], path, body).status_code == 200
        snapshot = requests.get(stack["base_url"] + "/stats.json", headers=_headers(), timeout=5).json()
        assert snapshot["totals"]["requests"] == 205
        assert sum(row["requests"] for row in snapshot["models"]) == 205
        assert sum(row["requests"] for row in snapshot["trend"]) == 205
        assert len(snapshot["recent"]) == 10


def test_session_capacity_evicts_least_recently_used():
    with _launch_stack({"MAX_CONVERSATION_SESSIONS": "2", "RATE_LIMIT_ENABLED": "false"}) as stack:
        ids = [uuid4().hex for _ in range(3)]
        path, body = _request("openai")
        for index in [0, 1, 0, 2, 0, 1]:
            response = _post(stack["base_url"], path, body, headers={"X-Session-ID": ids[index]})
            assert response.status_code == 200
        sent = stack["state"].snapshot()
        assert sent[4].get("cid") == "mock-cid-3"
        assert not sent[5].get("cid")


@pytest.mark.parametrize("kv", ["", "memory"])
def test_upstream_attempts_are_separate_from_business_responses(kv):
    with _launch_stack({"STATS_KV": kv}) as stack:
        for marker in ["ok", "MOCK_1135_MIN", "ok"]:
            path, body = _request("openai", [{"role": "user", "content": marker}])
            _post(stack["base_url"], path, body)
        for _ in range(100):
            snapshot = requests.get(stack["base_url"] + "/stats.json", headers=_headers(), timeout=5).json()
            if snapshot["upstream"]["gateRejections"] == 1:
                break
            time.sleep(0.01)
        assert snapshot["upstream"] == {"attempts": 2, "succeeded": 1, "failed": 1,
                                        "quotaErrors": 1, "gateRejections": 1}
        assert snapshot["totals"]["requests"] == 1
        assert sum(row["failures"] for row in snapshot["trend"]) == 2
        assert snapshot["persisted"] is bool(kv)


def test_public_stats_requires_explicit_setting():
    with _launch_stack({"AUTH_TOKEN": "", "STATS_PUBLIC": "true"}) as stack:
        assert requests.get(stack["base_url"] + "/stats", timeout=5).status_code == 200
        assert requests.get(stack["base_url"] + "/stats.json", timeout=5).status_code == 200
        assert requests.get(stack["base_url"] + "/api/admin/models", timeout=5).status_code == 503


@pytest.mark.parametrize("path", ["/v1/images/generations", "/api/admin/models", "/stats/login"])
def test_non_text_endpoints_share_body_limit(path):
    with _launch_stack({"MAX_REQUEST_BODY_BYTES": "1024"}) as stack:
        response = requests.post(stack["base_url"] + path, headers=_headers(), json={"prompt": "x" * 2048}, timeout=5)
        assert response.status_code == 413, response.text
        assert not stack["state"].snapshot()


def test_stats_cookie_rejects_tampering_and_expiry():
    with _launch_stack() as stack:
        base = stack["base_url"]
        page = requests.get(base + "/stats", headers={"Accept": "text/html"}, timeout=5)
        assert page.status_code == 401 and "/stats/login" in page.text
        login = requests.post(base + "/stats/login", json={"token": AUTH_TOKEN},
                              headers={"X-Forwarded-Proto": "https"}, timeout=5)
        cookie = login.headers["Set-Cookie"].split(";")[0]
        assert "Secure" in login.headers["Set-Cookie"]
        for forged in [cookie + "a", "s2p_stats=1." + cookie.split(".", 1)[1]]:
            assert requests.get(base + "/stats.json", headers={"Cookie": forged}, timeout=5).status_code == 401
        assert requests.get(base + "/stats.json", headers={"Cookie": cookie, "x-api-key": "wrong"}, timeout=5).status_code == 401


@pytest.mark.parametrize("protocol", PROTOCOLS)
def test_timeout_before_stream_commit_is_http_and_releases_slot(protocol):
    with _launch_stack({"UPSTREAM_STREAM_IDLE_TIMEOUT_MS": "150",
                        "UPSTREAM_MAX_CONCURRENCY": "1"}) as stack:
        path, body = _request(protocol, [{"role": "user", "content": "MOCK_HANG_BODY"}], stream=True)
        response = _post(stack["base_url"], path, body)
        assert response.status_code == 504, response.text
        assert response.headers["Retry-After"] == "1"
        path, body = _request(protocol)
        assert _post(stack["base_url"], path, body).status_code == 200


@pytest.mark.parametrize("protocol", PROTOCOLS)
def test_exact_body_byte_limit_is_accepted(protocol):
    with _launch_stack({"MAX_REQUEST_BODY_BYTES": "1024"}) as stack:
        path, body = _request(protocol)
        raw = json.dumps(body).encode()
        raw += b" " * (1024 - len(raw))
        response = requests.post(stack["base_url"] + path, headers=_headers(), data=raw, timeout=5)
        assert response.status_code == 200, response.text
        response = requests.post(stack["base_url"] + path, headers=_headers(), data=raw + b" ", timeout=5)
        assert response.status_code == 413
        assert len(stack["state"].snapshot()) == 1


def test_connection_failure_does_not_expose_internal_address():
    with _launch_stack({"SIDER_API_ENDPOINT": "http://127.0.0.1:1/private-path-marker"}) as stack:
        path, body = _request("openai")
        response = _post(stack["base_url"], path, body)
        assert response.status_code == 502
        assert "private-path-marker" not in response.text
        assert "127.0.0.1" not in response.text
        assert response.headers.get("X-Request-ID")


@pytest.mark.parametrize("protocol", PROTOCOLS)
def test_auth_error_preserves_protocol_contract(protocol):
    with _launch_stack() as stack:
        path, body = _request(protocol)
        response = requests.post(stack["base_url"] + path, json=body, timeout=5)
        assert response.status_code == 401
        error = response.json()["error"]
        if protocol == "anthropic":
            assert error["type"] == "authentication_error"
        elif protocol == "gemini":
            assert error["status"] == "UNAUTHENTICATED"
        else:
            assert error["type"] == "invalid_request_error"
        assert not stack["state"].snapshot()
