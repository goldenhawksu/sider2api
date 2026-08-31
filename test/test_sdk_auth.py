"""官方 SDK 鉴权约定兼容性回归.

背景: 实例实现了 Anthropic / Gemini 的协议格式, 但早期鉴权门只认
`Authorization: Bearer`, 导致 anthropic / google-genai 官方 SDK 开箱即 401
(它们分别发 `x-api-key` 与 `x-goog-api-key`)。既有套件用 requests 手工构造
Authorization 头, 从未走过 SDK 的鉴权路径, 属测试盲区。本文件补上。

零额度技巧: 用【错误的 token】走各种头。若该头未被识别, 返回
"Missing or invalid credentials"; 若被识别但 token 不对, 返回 "Invalid token"。
两者都在上游调用之前拦截, 因此不消耗额度, 却能精确断言"头被认出来了"。
"""
import pytest
import requests

import config

BODY = {"model": "gpt-4.1", "messages": [{"role": "user", "content": "只回答: OK"}]}

# (用例名, 构造带 token 的 headers/params) — 覆盖三家官方 SDK 的鉴权约定
AUTH_STYLES = [
    ("openai_bearer", lambda t: ({"Authorization": f"Bearer {t}"}, {})),
    ("anthropic_x_api_key", lambda t: ({"x-api-key": t}, {})),
    ("gemini_x_goog_api_key", lambda t: ({"x-goog-api-key": t}, {})),
    ("gemini_query_key", lambda t: ({}, {"key": t})),
]


def _post(client, headers, params):
    return requests.post(
        f"{client.base_url}/v1/chat/completions",
        headers={"Content-Type": "application/json", **headers},
        params=params, json=BODY,
        timeout=(config.CONNECT_TIMEOUT, client.read_timeout),
    )


@pytest.mark.smoke
@pytest.mark.parametrize("name,build", AUTH_STYLES, ids=[s[0] for s in AUTH_STYLES])
def test_auth_style_is_recognized(client, name, build):
    """每种鉴权约定都应被识别: 错误 token 报 'Invalid token', 而非 'Missing'。"""
    headers, params = build("sk-definitely-wrong-token")
    r = _post(client, headers, params)
    assert r.status_code == 401, r.text[:200]
    msg = r.json()["error"]["message"]
    assert "Invalid token" in msg, f"{name} 未被识别为凭证来源: {msg}"


@pytest.mark.smoke
def test_no_credentials_401(client):
    """完全不带凭证 -> 401, 且提示列出所有支持的方式。"""
    r = _post(client, {}, {})
    assert r.status_code == 401
    msg = r.json()["error"]["message"]
    assert "Missing or invalid credentials" in msg
    for hint in ("Bearer", "x-api-key", "x-goog-api-key", "key="):
        assert hint in msg, f"401 提示未包含 {hint}: {msg}"


@pytest.mark.smoke
def test_cors_preflight_allows_sdk_headers(client):
    """CORS 预检需放行三家 SDK 的鉴权头, 否则浏览器端 SDK 被拦。"""
    allowed = client.options("/v1/chat/completions").headers.get(
        "Access-Control-Allow-Headers", "").lower()
    for h in ("authorization", "x-api-key", "x-goog-api-key", "anthropic-version"):
        assert h in allowed, f"CORS 未放行 {h}: {allowed}"


@pytest.mark.cost
@pytest.mark.parametrize(
    "name,build,model",
    [("anthropic_x_api_key", AUTH_STYLES[1][1], "gemini-2.5-flash"),
     ("gemini_x_goog_api_key", AUTH_STYLES[2][1], "deepseek-v4-flash"),
     ("gemini_query_key", AUTH_STYLES[3][1], "qwen3.8-max")],
    ids=["anthropic_x_api_key", "gemini_x_goog_api_key", "gemini_query_key"],
)
def test_auth_style_works_end_to_end(client, name, build, model):
    """非 Bearer 的鉴权方式也能真正跑通请求 (每种用不同模型, 避开每模型限速)。"""
    headers, params = build(client.token)
    r = requests.post(
        f"{client.base_url}/v1/chat/completions",
        headers={"Content-Type": "application/json", **headers},
        params=params, json={**BODY, "model": model},
        timeout=(config.CONNECT_TIMEOUT, client.read_timeout),
    )
    assert r.status_code == 200, r.text[:200]
    assert r.json()["choices"][0]["message"]["content"]
