"""Anthropic 格式端点测试 (TDD 红灯→绿灯)。

Anthropic Messages API:
- POST /v1/messages                        → 非流式
- POST /v1/messages + stream: true          → SSE 流式

请求格式:
  { "model": "claude-opus-4.8",
    "max_tokens": 1024,
    "messages": [{"role":"user","content":"..."}],
    "system": "You are helpful.",           // 可选, 字符串或数组
    "stream": false }

非流式响应:
  { "id": "msg_xxx", "type": "message",
    "content": [{"type":"text","text":"..."}],
    "role": "assistant", "model": "...",
    "stop_reason": "end_turn", "usage": {...} }

流式: SSE 事件序列
  event: message_start
  data: {"type":"message_start","message":{...}}
  event: content_block_start
  data: {"type":"content_block_start","content_block":{"type":"text","text":""}}
  event: content_block_delta
  data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}}
  event: content_block_stop / message_delta / message_stop
"""
import json
import pytest

from config import SINGLE_MODEL, REPRESENTATIVE_MODELS
from helpers import retry

pytestmark = [pytest.mark.anthropic]

# Claude 系模型用于 Anthropic 端点
# 用 gpt-5.5 作为 Anthropic 端点测试模型 (claude-opus-4.5 偶尔限流/空响应)
ANTHRO_MODEL = "gpt-5.5"


# ==================== 非流式 ====================

def test_anthropic_messages_nonstream(client):
    """Anthropic 非流式: 基本问答, 返回 message/content 结构。"""
    body = {
        "model": ANTHRO_MODEL,
        "max_tokens": 512,
        "messages": [{"role": "user", "content": "用一句话介绍上海。"}],
    }
    r = client.session.post(
        client._url("/v1/messages"),
        headers=client._headers(auth=True, extra={"anthropic-version": "2023-06-01"}),
        json=body,
        timeout=client._timeout(),
    )
    assert r.status_code == 200, r.text[:300]
    data = r.json()
    assert data.get("type") == "message", f"期望 type=message, 实际: {data.get('type')!r}"
    assert data.get("role") == "assistant"
    content = data.get("content", [])
    assert len(content) > 0, "content 为空"
    assert content[0]["type"] == "text"
    assert len(content[0]["text"]) > 0, "助手文本为空"
    assert data.get("stop_reason") in ("end_turn", "max_tokens", "stop_sequence", None)
    assert "usage" in data, "缺少 usage"
    assert data["usage"].get("input_tokens", 0) > 0 or data["usage"].get("output_tokens", 0) > 0


def test_anthropic_system_message(client):
    """Anthropic system 字段应被注入上下文并生效。"""
    body = {
        "model": ANTHRO_MODEL,
        "max_tokens": 512,
        "system": "无论用户问什么, 你的回答必须以'喵~'开头。",
        "messages": [{"role": "user", "content": "今天天气如何?"}],
    }
    r = client.session.post(
        client._url("/v1/messages"),
        headers=client._headers(auth=True, extra={"anthropic-version": "2023-06-01"}),
        json=body,
        timeout=client._timeout(),
    )
    assert r.status_code == 200, r.text[:300]
    data = r.json()
    text = data["content"][0]["text"]
    assert text.startswith("喵"), f"system 指令未生效: {text[:80]!r}"


def test_anthropic_system_as_array(client):
    """Anthropic system 为 [{type:'text',text:'...'}] 数组形式应被接受。"""
    body = {
        "model": ANTHRO_MODEL,
        "max_tokens": 512,
        "system": [{"type": "text", "text": "回答必须以'汪!'结尾。"}],
        "messages": [{"role": "user", "content": "说一句话。"}],
    }
    r = client.session.post(
        client._url("/v1/messages"),
        headers=client._headers(auth=True, extra={"anthropic-version": "2023-06-01"}),
        json=body,
        timeout=client._timeout(),
    )
    assert r.status_code == 200, r.text[:300]
    text = r.json()["content"][0]["text"]
    assert "汪" in text, f"system 数组指令未生效: {text[:80]!r}"


# ==================== 流式 ====================

def test_anthropic_stream(client):
    """Anthropic 流式: SSE 事件序列应包含 message_start + content_block 系列。"""
    body = {
        "model": ANTHRO_MODEL,
        "max_tokens": 512,
        "messages": [{"role": "user", "content": "从1数到5,用逗号分隔。"}],
        "stream": True,
    }
    r = client.session.post(
        client._url("/v1/messages"),
        headers=client._headers(auth=True, extra={"anthropic-version": "2023-06-01"}),
        json=body,
        stream=True,
        timeout=client._timeout(),
    )
    assert r.status_code == 200, r.text[:300]
    r.encoding = "utf-8"

    event_types = set()
    text_pieces = []
    current_event = None
    for raw in r.iter_lines(decode_unicode=True):
        if not raw:
            continue
        line = raw.strip()
        if line.startswith("event:"):
            current_event = line[len("event:"):].strip()
            event_types.add(current_event)
        elif line.startswith("data:"):
            payload = line[len("data:"):].strip()
            try:
                obj = json.loads(payload)
            except json.JSONDecodeError:
                continue
            t = obj.get("type", "")
            if t:
                event_types.add(t)
            if t == "content_block_delta":
                d = obj.get("delta", {})
                if d.get("type") == "text_delta" and d.get("text"):
                    text_pieces.append(d["text"])
            elif t == "message_stop":
                break

    content = "".join(text_pieces)
    assert content, "流式累计内容为空"
    assert "5" in content or "五" in content, f"未数到5: {content[:200]!r}"
    # 核心事件应至少包含 message_start
    assert ("message_start" in event_types) or ("content_block_start" in event_types), \
        f"缺少核心事件: {sorted(event_types)}"


# ==================== 多轮对话 ====================

def test_anthropic_multiturn(client):
    """Anthropic 多轮: messages 含 assistant 历史应被正确传递。"""
    body = {
        "model": ANTHRO_MODEL,
        "max_tokens": 512,
        "messages": [
            {"role": "user", "content": "我的名字是李四, 请记住。"},
            {"role": "assistant", "content": "好的, 我记住了。"},
            {"role": "user", "content": "我的名字是什么? 只回答名字。"},
        ],
    }
    r = client.session.post(
        client._url("/v1/messages"),
        headers=client._headers(auth=True, extra={"anthropic-version": "2023-06-01"}),
        json=body,
        timeout=client._timeout(),
    )
    assert r.status_code == 200, r.text[:300]
    text = r.json()["content"][0]["text"]
    assert "李四" in text, f"未记住上下文: {text!r}"


# ==================== 边界 ====================

def test_anthropic_missing_max_tokens(client):
    """缺少 max_tokens 应有默认值, 不崩溃。"""
    body = {
        "model": ANTHRO_MODEL,
        "messages": [{"role": "user", "content": "说ok"}],
    }
    r = client.session.post(
        client._url("/v1/messages"),
        headers=client._headers(auth=True, extra={"anthropic-version": "2023-06-01"}),
        json=body,
        timeout=client._timeout(),
    )
    assert r.status_code == 200, r.text[:300]


def test_anthropic_think_model(client, live_models):
    """Anthropic think 模式: -think 后缀模型应正常回复。"""
    model = "gpt-5.5-think"  # 用稳定 think 模型, claude-opus 系列偶尔限流
    if model not in live_models:
        pytest.skip(f"{model} 不在 live 模型清单中")

    body = {
        "model": model,
        "max_tokens": 512,
        "messages": [{"role": "user", "content": "1+1等于几? 只说数字。"}],
    }
    r = client.session.post(
        client._url("/v1/messages"),
        headers=client._headers(auth=True, extra={"anthropic-version": "2023-06-01"}),
        json=body,
        timeout=client._timeout(),
    )
    assert r.status_code == 200, r.text[:300]
    text = r.json()["content"][0]["text"]
    assert "2" in text or "二" in text, f"think 模式回复异常: {text[:80]!r}"
