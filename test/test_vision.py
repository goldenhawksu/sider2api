"""Vision (视觉输入) 测试 (TDD).

基于上游能力探针 (test/probe_vision.py) 的决定性结论:
  上游 sider **不支持视觉输入**。multi_content type 只接受 [text, file];
  image/image_url 块报 code:1000; base64 不被处理; images 属性虽不报错但
  经"读图中文字"判别确认模型完全读不出 (仅幻觉)。

按 CLAUDE.md 能力门控铁律: 绝不 fake。
deno_pro 收到图像输入应返回标准 not_supported (HTTP 422), 不静默丢给上游幻觉。

本测试断言各端点 (OpenAI Chat / Gemini / Anthropic / Responses) 对视觉输入
均返回标准化 not_supported; 纯文本请求不受影响 (回归保护)。
"""
import pytest

from config import SINGLE_MODEL
from helpers import extract_content

pytestmark = [pytest.mark.vision]

# 测试图 URL (内容无关紧要, 重点是图像块结构被识别)
_IMG = "https://example.com/cat.jpg"


def _is_not_supported(resp_json) -> bool:
    """判断响应是否为标准 not_supported 错误。"""
    err = resp_json.get("error", {})
    if isinstance(err, dict):
        blob = (str(err.get("type", "")) + str(err.get("code", "")) +
                str(err.get("message", ""))).lower()
        return ("not_supported" in blob) or ("不支持" in str(err.get("message", "")))
    return False


# ==================== OpenAI Chat Completions ====================

def test_openai_vision_not_supported(client):
    """OpenAI image_url 块应返回 not_supported (422)。"""
    body = {
        "model": SINGLE_MODEL,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": "这是什么?"},
                {"type": "image_url", "image_url": {"url": _IMG}},
            ],
        }],
        "stream": False,
    }
    r = client.session.post(
        client._url("/v1/chat/completions"),
        headers=client._headers(), json=body, timeout=client._timeout(),
    )
    assert r.status_code == 422, r.text[:300]
    assert _is_not_supported(r.json()), f"应为 not_supported: {r.text[:200]}"


def test_openai_text_only_still_works(client):
    """纯文本 (含 content 数组但无图像) 应正常 (回归保护)。"""
    body = {
        "model": SINGLE_MODEL,
        "messages": [{
            "role": "user",
            "content": [{"type": "text", "text": "说『收到』两个字"}],
        }],
        "stream": False,
    }
    r = client.session.post(
        client._url("/v1/chat/completions"),
        headers=client._headers(), json=body, timeout=client._timeout(),
    )
    assert r.status_code == 200, r.text[:300]
    assert extract_content(r.json())


# ==================== Gemini ====================

def test_gemini_vision_not_supported(client):
    """Gemini inline_data (图像) 应返回 not_supported。"""
    body = {
        "contents": [{
            "role": "user",
            "parts": [
                {"text": "这是什么?"},
                {"inline_data": {"mime_type": "image/jpeg", "data": "BASE64DATA"}},
            ],
        }],
    }
    r = client.session.post(
        client._url(f"/v1beta/models/{SINGLE_MODEL}:generateContent"),
        headers=client._headers(), json=body, timeout=client._timeout(),
    )
    assert r.status_code == 422, r.text[:300]
    assert _is_not_supported(r.json()), f"应为 not_supported: {r.text[:200]}"


# ==================== Anthropic ====================

def test_anthropic_vision_not_supported(client):
    """Anthropic image source 块应返回 not_supported。"""
    body = {
        "model": SINGLE_MODEL,
        "max_tokens": 256,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": "这是什么?"},
                {"type": "image", "source": {
                    "type": "base64", "media_type": "image/jpeg", "data": "BASE64DATA"}},
            ],
        }],
    }
    r = client.session.post(
        client._url("/v1/messages"),
        headers=client._headers(extra={"anthropic-version": "2023-06-01"}),
        json=body, timeout=client._timeout(),
    )
    assert r.status_code == 422, r.text[:300]
    err = r.json().get("error", {})
    blob = (str(err.get("type", "")) + str(err.get("message", ""))).lower()
    assert "not_supported" in blob or "不支持" in str(err.get("message", "")), \
        f"应为 not_supported: {r.text[:200]}"


# ==================== Responses ====================

def test_responses_vision_not_supported(client):
    """Responses input_image 块应返回 not_supported。"""
    body = {
        "model": SINGLE_MODEL,
        "input": [{
            "role": "user",
            "content": [
                {"type": "input_text", "text": "这是什么?"},
                {"type": "input_image", "image_url": _IMG},
            ],
        }],
    }
    r = client.session.post(
        client._url("/v1/responses"),
        headers=client._headers(), json=body, timeout=client._timeout(),
    )
    assert r.status_code == 422, r.text[:300]
    assert _is_not_supported(r.json()), f"应为 not_supported: {r.text[:200]}"
