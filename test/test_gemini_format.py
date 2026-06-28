"""Gemini 格式端点测试 (TDD 红灯)。

Gemini API 拓补:
- POST /v1beta/models/{model}:generateContent    → 非流式
- POST /v1beta/models/{model}:streamGenerateContent → SSE 流式

请求格式:
  { "contents": [{ "role":"user", "parts":[{"text":"..."}] }],
    "systemInstruction": {"parts":[{"text":"..."}]},
    "generationConfig": {...} }

响应格式 (非流式):
  { "candidates": [{ "content": {"role":"model", "parts":[{"text":"..."}]},
    "finishReason":"STOP", "index":0 }], "usageMetadata": {...} }

流式 SSE: data: {"candidates":[{...}]}\\n\\n, 终以 data: [DONE] 结束
"""
import json
import pytest

from config import SINGLE_MODEL, REPRESENTATIVE_THINK_MODEL
from helpers import retry

pytestmark = [pytest.mark.gemini]


# ==================== 非流式 ====================

def test_gemini_generate_content_nonstream(client):
    """Gemini 非流式: 基本文本问答, 返回 candidates/content 结构。"""
    body = {
        "contents": [{"role": "user", "parts": [{"text": "用一句话介绍深圳。"}]}],
    }
    r = client.session.post(
        client._url(f"/v1beta/models/{SINGLE_MODEL}:generateContent"),
        headers=client._headers(),
        json=body,
        timeout=client._timeout(),
    )
    assert r.status_code == 200, r.text[:300]
    data = r.json()
    assert "candidates" in data, f"缺少 candidates: {list(data.keys())}"
    cand = data["candidates"][0]
    role = cand.get("content", {}).get("role", "")
    parts = cand.get("content", {}).get("parts", [])
    text = "".join(p.get("text", "") for p in parts)
    assert role == "model", f"期望 role=model, 实际 {role!r}"
    assert text, "助手文本为空"
    assert cand.get("finishReason") in ("STOP", "MAX_TOKENS", None)
    assert "usageMetadata" in data


def test_gemini_system_instruction(client):
    """Gemini systemInstruction 应被注入上下文并生效。"""
    body = {
        "contents": [{"role": "user", "parts": [{"text": "今天天气如何?"}]}],
        "systemInstruction": {"parts": [{"text": "无论用户问什么, 都必须说'喵'。"}]},
    }
    r = client.session.post(
        client._url(f"/v1beta/models/{SINGLE_MODEL}:generateContent"),
        headers=client._headers(),
        json=body,
        timeout=client._timeout(),
    )
    assert r.status_code == 200, r.text[:300]
    cand = r.json()["candidates"][0]
    text = "".join(p.get("text", "") for p in cand["content"]["parts"])
    assert "喵" in text, f"systemInstruction 未生效: {text!r}"


def test_gemini_think_mode(client, live_models):
    """Gemini think 模式: 使用 -think 后缀模型应能正常回复。"""
    model = REPRESENTATIVE_THINK_MODEL
    if model not in live_models:
        pytest.skip(f"{model} 不在 live 模型清单中")

    body = {
        "contents": [{"role": "user", "parts": [{"text": "1.5和1.50哪个大? 从精度角度分析。"}]}],
    }
    r = client.session.post(
        client._url(f"/v1beta/models/{model}:generateContent"),
        headers=client._headers(),
        json=body,
        timeout=client._timeout(),
    )
    assert r.status_code == 200, r.text[:300]
    cand = r.json()["candidates"][0]
    text = "".join(p.get("text", "") for p in cand["content"]["parts"])
    assert text, "助手文本为空"


# ==================== 流式 ====================

def test_gemini_stream_generate_content(client):
    """Gemini 流式 SSE: streamGenerateContent 应逐块返回 candidates。"""
    body = {
        "contents": [{"role": "user", "parts": [{"text": "从1数到5,用逗号分隔。"}]}],
    }
    r = client.session.post(
        client._url(f"/v1beta/models/{SINGLE_MODEL}:streamGenerateContent"),
        headers=client._headers(),
        json=body,
        stream=True,
        timeout=client._timeout(),
    )
    assert r.status_code == 200, r.text[:300]
    r.encoding = "utf-8"
    pieces = []
    done = False
    for raw in r.iter_lines(decode_unicode=True):
        if not raw:
            continue
        line = raw.strip()
        if not line.startswith("data:"):
            continue
        payload = line[len("data:"):].strip()
        if payload == "[DONE]":
            done = True
            break
        try:
            obj = json.loads(payload)
        except json.JSONDecodeError:
            continue
        cands = obj.get("candidates", [])
        for c in cands:
            for p in c.get("content", {}).get("parts", []):
                if p.get("text"):
                    pieces.append(p["text"])
    content = "".join(pieces)
    assert content, "流式累计内容为空"
    assert "5" in content or "五" in content, f"未数到5: {content[:200]!r}"
    assert done, "流未以 [DONE] 正常终止"


# ==================== 多轮对话 ====================

def test_gemini_multiturn(client):
    """Gemini 多轮: contents 数组含历史应被正确传递。"""
    body = {
        "contents": [
            {"role": "user", "parts": [{"text": "我的名字是张三, 请记住。"}]},
            {"role": "model", "parts": [{"text": "好的, 我记住了。"}]},
            {"role": "user", "parts": [{"text": "我的名字是什么? 只回答名字。"}]},
        ],
    }
    r = client.session.post(
        client._url(f"/v1beta/models/{SINGLE_MODEL}:generateContent"),
        headers=client._headers(),
        json=body,
        timeout=client._timeout(),
    )
    assert r.status_code == 200, r.text[:300]
    cand = r.json()["candidates"][0]
    text = "".join(p.get("text", "") for p in cand["content"]["parts"])
    assert "张三" in text, f"未记住名字: {text!r}"


# ==================== 边界 ====================

def test_gemini_unknown_route(client):
    """不存在的 Gemini 路由应返回 404。"""
    r = client.session.post(
        client._url("/v1beta/models/no-such-model-xyz:generateContent"),
        headers=client._headers(),
        json={"contents": [{"role": "user", "parts": [{"text": "hi"}]}]},
        timeout=client._timeout(),
    )
    # 应回退到 sider 智能路由, 返回 200
    assert r.status_code == 200, r.text[:300]
