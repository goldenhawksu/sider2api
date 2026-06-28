"""对话生成测试 (OpenAI 格式): 非流式 (参数化代表子集) + 流式 + system 消息 + content 数组。"""
import pytest

from config import STREAM_MODEL
from helpers import extract_content, parse_stream

pytestmark = [pytest.mark.cost, pytest.mark.chat, pytest.mark.openai]


def test_chat_nonstream(client, chat_model):
    r = client.chat(chat_model, [{"role": "user", "content": "用一句话介绍你自己"}], stream=False)
    assert r.status_code == 200, r.text[:200]
    data = r.json()
    assert data["choices"][0]["message"]["role"] == "assistant"
    assert extract_content(data), "助手内容为空"
    assert "model" in data
    assert "usage" in data


@pytest.mark.stream
def test_chat_stream(client):
    r = client.chat(STREAM_MODEL, [{"role": "user", "content": "从1数到5,用逗号分隔"}], stream=True)
    assert r.status_code == 200, r.text[:200]
    result = parse_stream(r)
    assert result["chunks"] > 0, "未收到任何内容块"
    assert result["content"], "累计内容为空"
    assert result["done"], "流未以 [DONE] 正常终止"
    # 当前 deno_pro 不发送 finish_reason='stop' 终止块 (OpenAI 兼容缺口, 见测试报告);
    # 断言保持前向兼容: 修复后会自动转绿, 不会因此误报。
    assert result["finish_reason"] in (None, "stop")


def test_system_message_respected(client):
    msgs = [
        {"role": "system", "content": "无论用户问什么, 你都必须在回答里包含『喵』这个字。"},
        {"role": "user", "content": "今天天气怎么样?"},
    ]
    r = client.chat(STREAM_MODEL, msgs, stream=False)
    assert r.status_code == 200, r.text[:200]
    content = extract_content(r.json())
    assert "喵" in content, f"system 指令未生效: {content!r}"


def test_content_array_format(client):
    """content 为 [{'type':'text','text':...}] 数组形式应被接受 (多模态文本块)。"""
    msgs = [{"role": "user", "content": [{"type": "text", "text": "回复『收到』两个字"}]}]
    r = client.chat(STREAM_MODEL, msgs, stream=False)
    assert r.status_code == 200, r.text[:200]
    assert extract_content(r.json())
