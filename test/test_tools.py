"""Function Calling / Tools 测试 (TDD).

基于上游能力探针 (test/probe_tools.py) 的确认结论:
  - 上游 sider 不支持自定义 function calling (顶层 tools[] 报 code:1000)
  - 上游只支持内置工具 (search/data_analysis/create_image), 由 LLM 自主触发
  - 旧版 functions[] 字段被静默忽略

按 CLAUDE.md 能力门控铁律: 绝不 fake。
deno_pro 收到 OpenAI tools[] 时应:
  - 返回标准化 not_supported 错误 (推荐), 或
  - 优雅降级为纯文本对话 (忽略 tools, 不崩溃, 不伪造 tool_calls)

本测试断言「优雅处理」: 不崩溃 + 不伪造 tool_calls。
"""
import json
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


def test_tools_not_supported_graceful(client):
    """传 OpenAI tools[] 应优雅处理: 要么标准 not_supported 错误, 要么降级纯文本。

    经探针确认上游不支持自定义 function calling, 此处验证 deno_pro 不崩溃、
    不伪造 tool_calls (能力门控铁律: 不 fake)。
    """
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
    # 两种合法行为: 400 标准 not_supported, 或 200 降级纯文本
    assert r.status_code in (200, 400, 422), r.text[:300]

    if r.status_code == 200:
        data = r.json()
        msg = data["choices"][0]["message"]
        # 关键: 不能伪造 tool_calls (上游不支持, 不能凭空捏造)
        assert not msg.get("tool_calls"), f"不应伪造 tool_calls: {msg.get('tool_calls')!r}"
        # 应有正常文本回复 (降级行为)
        assert extract_content(data), "降级后应返回文本内容"
    else:
        # 标准 not_supported 错误结构
        err = r.json().get("error", {})
        assert err, "错误响应应含 error 字段"
        assert "support" in (err.get("message", "").lower() + err.get("code", "").lower()) \
            or "tool" in err.get("message", "").lower(), \
            f"错误应说明工具不支持: {err!r}"


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


def test_tools_stream_graceful(client):
    """流式 + tools[] 应优雅处理 (不崩溃, 不伪造 tool_calls delta)。"""
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
    # 400 标准错误 或 200 降级流
    assert r.status_code in (200, 400, 422), r.text[:300]
    if r.status_code == 200:
        r.encoding = "utf-8"
        has_tool_call_delta = False
        for raw in r.iter_lines(decode_unicode=True):
            if not raw or not raw.strip().startswith("data:"):
                continue
            payload = raw.strip()[len("data:"):].strip()
            if payload == "[DONE]":
                break
            try:
                obj = json.loads(payload)
            except json.JSONDecodeError:
                continue
            delta = obj.get("choices", [{}])[0].get("delta", {})
            if delta.get("tool_calls"):
                has_tool_call_delta = True
        assert not has_tool_call_delta, "降级流不应伪造 tool_calls delta"
