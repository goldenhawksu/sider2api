"""OpenAI Responses API 端点测试 (TDD 红灯→绿灯).

OpenAI Responses API:
- POST /v1/responses              → 非流式
- POST /v1/responses + stream:true → SSE 流式

请求格式:
  { "model": "gpt-5.5",
    "input": "用一句话介绍深圳。" | [{"role":"user","content":"..."}],
    "instructions": "...",           // 可选, 系统级指令
    "stream": false,
    "max_output_tokens": 512 }

非流式响应:
  { "id": "resp_xxx", "object": "response",
    "output": [{"type":"message","role":"assistant",
                "content":[{"type":"output_text","text":"..."}]}],
    "model": "...", "usage": {...} }

流式 SSE:
  event: response.created
  data: {"type":"response.created","response":{...}}
  event: response.output_text.delta
  data: {"type":"response.output_text.delta","delta":"..."}
  event: response.completed
  data: {"type":"response.completed","response":{...}}
"""
import json
import pytest

from config import SINGLE_MODEL, REPRESENTATIVE_THINK_MODEL

pytestmark = [pytest.mark.openai]


# ==================== 非流式 ====================

def test_responses_nonstream_string_input(client):
    """Responses API 非流式: input 为字符串, 返回 output_text。"""
    body = {
        "model": SINGLE_MODEL,
        "input": "用一句话介绍杭州。",
    }
    r = client.session.post(
        client._url("/v1/responses"),
        headers=client._headers(),
        json=body,
        timeout=client._timeout(),
    )
    assert r.status_code == 200, r.text[:300]
    data = r.json()
    assert data.get("object") == "response", f"期望 object=response, 实际: {data.get('object')!r}"
    assert data.get("id", "").startswith("resp_"), f"id 应以 resp_ 开头: {data.get('id')!r}"
    output = data.get("output", [])
    assert len(output) > 0, "output 为空"
    msg = output[0]
    assert msg.get("type") == "message", f"期望 type=message: {msg.get('type')!r}"
    assert msg.get("role") == "assistant"
    content = msg.get("content", [])
    assert len(content) > 0, "content 为空"
    assert content[0].get("type") == "output_text", f"期望 output_text: {content[0].get('type')!r}"
    assert len(content[0].get("text", "")) > 0, "助手文本为空"
    assert "model" in data
    assert "usage" in data


def test_responses_nonstream_array_input(client):
    """Responses API 非流式: input 为消息数组。"""
    body = {
        "model": SINGLE_MODEL,
        "input": [{"role": "user", "content": "说OK"}],
    }
    r = client.session.post(
        client._url("/v1/responses"),
        headers=client._headers(),
        json=body,
        timeout=client._timeout(),
    )
    assert r.status_code == 200, r.text[:300]
    data = r.json()
    text = data["output"][0]["content"][0]["text"]
    assert text, "助手文本为空"


def test_responses_instructions(client):
    """Responses API instructions 应作为 system 指令生效。"""
    body = {
        "model": SINGLE_MODEL,
        "instructions": "无论用户问什么, 回答必须以'汪!'结尾。",
        "input": "说一句话。",
    }
    r = client.session.post(
        client._url("/v1/responses"),
        headers=client._headers(),
        json=body,
        timeout=client._timeout(),
    )
    assert r.status_code == 200, r.text[:300]
    text = r.json()["output"][0]["content"][0]["text"]
    assert "汪" in text, f"instructions 未生效: {text[:80]!r}"


def test_responses_multiturn(client):
    """Responses API 多轮: input 含历史消息应记住上下文。"""
    body = {
        "model": SINGLE_MODEL,
        "input": [
            {"role": "user", "content": "我的名字是王五, 请记住。"},
            {"role": "assistant", "content": "好的, 记住了。"},
            {"role": "user", "content": "我的名字是什么? 只回答名字。"},
        ],
    }
    r = client.session.post(
        client._url("/v1/responses"),
        headers=client._headers(),
        json=body,
        timeout=client._timeout(),
    )
    assert r.status_code == 200, r.text[:300]
    text = r.json()["output"][0]["content"][0]["text"]
    assert "王五" in text, f"未记住上下文: {text!r}"


def test_responses_think_model(client, live_models):
    """Responses API think 模式: -think 后缀模型正常回复。"""
    model = REPRESENTATIVE_THINK_MODEL
    if model not in live_models:
        pytest.skip(f"{model} 不在 live 模型清单中")

    body = {
        "model": model,
        "input": "1+1等于几? 只说数字。",
    }
    r = client.session.post(
        client._url("/v1/responses"),
        headers=client._headers(),
        json=body,
        timeout=client._timeout(),
    )
    assert r.status_code == 200, r.text[:300]
    text = r.json()["output"][0]["content"][0]["text"]
    assert ("2" in text) or ("二" in text), f"think 回复异常: {text[:80]!r}"


# ==================== 流式 ====================

def test_responses_stream(client):
    """Responses API 流式: SSE 事件序列应含 output_text.delta。"""
    body = {
        "model": SINGLE_MODEL,
        "input": "从1数到5,用逗号分隔。",
        "stream": True,
    }
    r = client.session.post(
        client._url("/v1/responses"),
        headers=client._headers(),
        json=body,
        stream=True,
        timeout=client._timeout(),
    )
    assert r.status_code == 200, r.text[:300]
    r.encoding = "utf-8"

    event_types = set()
    text_pieces = []
    for raw in r.iter_lines(decode_unicode=True):
        if not raw:
            continue
        line = raw.strip()
        if line.startswith("event:"):
            event_types.add(line[len("event:"):].strip())
        elif line.startswith("data:"):
            payload = line[len("data:"):].strip()
            if payload == "[DONE]":
                break
            try:
                obj = json.loads(payload)
            except json.JSONDecodeError:
                continue
            t = obj.get("type", "")
            if t:
                event_types.add(t)
            if t == "response.output_text.delta":
                if obj.get("delta"):
                    text_pieces.append(obj["delta"])

    content = "".join(text_pieces)
    assert content, "流式累计内容为空"
    assert "5" in content or "五" in content, f"未数到5: {content[:200]!r}"
    assert ("response.created" in event_types) or ("response.output_text.delta" in event_types), \
        f"缺少核心事件: {sorted(event_types)}"


# ==================== 边界 ====================

def test_responses_missing_input(client):
    """缺少 input 应返回 400。"""
    body = {"model": SINGLE_MODEL}
    r = client.session.post(
        client._url("/v1/responses"),
        headers=client._headers(),
        json=body,
        timeout=client._timeout(),
    )
    assert r.status_code == 400, r.text[:200]
    assert "error" in r.json()
