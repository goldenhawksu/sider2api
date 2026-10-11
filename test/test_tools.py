"""Function Calling / Tools 测试 (TDD).

基于上游能力探针 (test/probe_tools.py) 的确认结论:
  - 上游 sider 不支持自定义 function calling (顶层 tools[] 报 code:1000)
  - 上游只支持内置工具 (search/data_analysis/create_image), 由 LLM 自主触发
  - 旧版 functions[] 字段被静默忽略

按 CLAUDE.md 能力门控铁律: 绝不 fake, 也不静默降级。
deno_pro 收到自定义函数声明时的契约是【唯一且确定】的:
  - tool_choice = "none" (明确不要工具): 正常放行, 走纯文本对话;
  - 其余情况: 返回协议原生 not_supported (HTTP 422), 绝不伪造 tool_calls。

此前"有时报错、有时静默降级"两种相反契约并存, 调用方无法写出稳定的处理逻辑,
本文件统一按上面的单一契约断言。
"""
import pytest

from config import SINGLE_MODEL
from helpers import extract_content

pytestmark = [pytest.mark.tools]

# OpenAI 标准 function 定义
_WEATHER_TOOL = {
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "获取指定城市的当前天气",
        "parameters": {
            "type": "object",
            "properties": {"city": {"type": "string"}},
            "required": ["city"],
        },
    },
}


def test_tools_not_supported_returns_protocol_native_error(client):
    """传 OpenAI tools[] 应返回标准 not_supported (422), 而不是静默降级。"""
    body = {
        "model": SINGLE_MODEL,
        "messages": [{"role": "user", "content": "北京天气如何?"}],
        "tools": [_WEATHER_TOOL],
        "tool_choice": "auto",
        "stream": False,
    }
    r = client.session.post(
        client._url("/v1/chat/completions"),
        headers=client._headers(),
        json=body,
        timeout=client._timeout(),
    )
    assert r.status_code == 422, r.text[:300]
    err = r.json().get("error", {})
    assert err.get("type") == "not_supported", f"错误类型应为 not_supported: {err!r}"
    assert err.get("code") == "tools_not_supported", f"错误码应可机器判别: {err!r}"
    assert "tool" in err.get("message", "").lower()


def test_legacy_functions_also_rejected(client):
    """旧版 functions[] 字段走同一条契约 (不因字段名不同就放行)。"""
    body = {
        "model": SINGLE_MODEL,
        "messages": [{"role": "user", "content": "北京天气如何?"}],
        "functions": [_WEATHER_TOOL["function"]],
        "stream": False,
    }
    r = client.session.post(
        client._url("/v1/chat/completions"),
        headers=client._headers(),
        json=body,
        timeout=client._timeout(),
    )
    assert r.status_code == 422, r.text[:300]
    assert r.json()["error"]["code"] == "tools_not_supported", r.text[:300]


def test_tool_choice_none_works(client):
    """tool_choice=none (明确不调用工具) 应正常返回纯文本。"""
    body = {
        "model": SINGLE_MODEL,
        "messages": [{"role": "user", "content": "用一句话介绍杭州。"}],
        "tools": [_WEATHER_TOOL],
        "tool_choice": "none",
        "stream": False,
    }
    r = client.session.post(
        client._url("/v1/chat/completions"),
        headers=client._headers(),
        json=body,
        timeout=client._timeout(),
    )
    assert r.status_code == 200, r.text[:300]
    data = r.json()
    msg = data["choices"][0]["message"]
    assert not msg.get("tool_calls"), "tool_choice=none 不应有 tool_calls"
    assert extract_content(data), "应返回正常文本"


def test_no_tools_still_works(client):
    """不带 tools 的普通请求应完全正常 (回归保护)。"""
    body = {
        "model": SINGLE_MODEL,
        "messages": [{"role": "user", "content": "说『收到』两个字"}],
        "stream": False,
    }
    r = client.session.post(
        client._url("/v1/chat/completions"),
        headers=client._headers(),
        json=body,
        timeout=client._timeout(),
    )
    assert r.status_code == 200, r.text[:300]
    assert extract_content(r.json())


def test_tools_stream_also_rejected(client):
    """流式 + tools[] 走同一条契约: 入站即 422, 不会先开流再降级。"""
    body = {
        "model": SINGLE_MODEL,
        "messages": [{"role": "user", "content": "北京天气如何?"}],
        "tools": [_WEATHER_TOOL],
        "stream": True,
    }
    r = client.session.post(
        client._url("/v1/chat/completions"),
        headers=client._headers(),
        json=body,
        stream=True,
        timeout=client._timeout(),
    )
    assert r.status_code == 422, r.text[:300]
    assert r.json()["error"]["type"] == "not_supported", r.text[:300]


def test_gemini_function_declarations_rejected(client):
    """Gemini tools[].functionDeclarations 走同一契约 (Gemini 原生错误结构)。"""
    body = {
        "contents": [{"role": "user", "parts": [{"text": "北京天气如何?"}]}],
        "tools": [{"functionDeclarations": [{
            "name": "get_weather",
            "parameters": _WEATHER_TOOL["function"]["parameters"],
        }]}],
    }
    r = client.session.post(
        client._url(f"/v1beta/models/{SINGLE_MODEL}:generateContent"),
        headers=client._headers(),
        json=body,
        timeout=client._timeout(),
    )
    assert r.status_code == 422, r.text[:300]
    err = r.json()["error"]
    assert err["status"] == "INVALID_ARGUMENT", err
    assert err["details"][0]["reason"] == "tools_not_supported", err


def test_anthropic_tools_rejected(client):
    """Anthropic tools[] 走同一契约 (Anthropic 原生错误结构)。"""
    body = {
        "model": SINGLE_MODEL,
        "max_tokens": 128,
        "messages": [{"role": "user", "content": "北京天气如何?"}],
        "tools": [{"name": "get_weather",
                   "input_schema": _WEATHER_TOOL["function"]["parameters"]}],
    }
    r = client.session.post(
        client._url("/v1/messages"),
        headers=client._headers(extra={"anthropic-version": "2023-06-01"}),
        json=body,
        timeout=client._timeout(),
    )
    assert r.status_code == 422, r.text[:300]
    err = r.json()["error"]
    assert err["type"] == "invalid_request_error", err
    assert err["code"] == "tools_not_supported", err
