"""think 模式测试 (-think 后缀): 非流式 + 流式推理检查。

注: 上游 reasoning_content 触发具有非确定性 (取决于问题难易与模型判断),
    测试用多条高概率推理题 + retry 容错; 全都未触发时跳过。
"""
import random
import time

import pytest

from config import REPRESENTATIVE_THINK_MODEL
from helpers import extract_content, extract_reasoning, parse_stream, retry

pytestmark = [pytest.mark.cost, pytest.mark.think]

# 经验证高概率触发 reasoning_content 的题目 (来自 prompt_bank THINK_PROMPTS)
_HARD_THINK_PROMPTS = [
    "1.5 和 1.50 哪个更大? 从精度和有效数字角度分析两者的区别。",
    "9.8 和 9.80 数值上相等吗? 从 IEEE 754 浮点数精度角度逐步解释。",
    "一个水池进水管3小时注满排水管5小时排空, 同时开几小时注满? 分步计算。",
]


def test_think_mode_nonstream(client, live_models):
    model = REPRESENTATIVE_THINK_MODEL
    if model not in live_models:
        pytest.skip(f"{model} 不在 live 模型清单中")

    def call():
        q = random.choice(_HARD_THINK_PROMPTS)
        return client.chat(model, [{"role": "user", "content": q}], stream=False)

    def ok(r):
        if r.status_code != 200:
            return False
        return bool(extract_reasoning(r.json()))

    r = retry(call, ok, attempts=3, delay=5.0)
    data = r.json()
    content = extract_content(data)
    reasoning = extract_reasoning(data)
    assert r.status_code == 200, r.text[:200]
    assert content, "助手内容为空"
    if not reasoning:
        pytest.skip("上游 reasoning_content 连续3次均未触发 (问题被模型直接回答, 属上游行为)")


def test_think_mode_stream(client, live_models):
    model = REPRESENTATIVE_THINK_MODEL
    if model not in live_models:
        pytest.skip(f"{model} 不在 live 模型清单中")

    result = None
    for attempt in range(3):
        q = random.choice(_HARD_THINK_PROMPTS)
        r = client.chat(model, [{"role": "user", "content": q}], stream=True)
        if r.status_code != 200:
            continue
        result = parse_stream(r)
        if result.get("reasoning"):
            break
        if attempt < 2:
            time.sleep(5)

    assert r.status_code == 200, r.text[:200]
    assert result["chunks"] > 0, "未收到任何内容块"
    assert result["done"], "流未以 [DONE] 正常终止"
    if not result.get("reasoning"):
        pytest.skip("上游 reasoning_content 流连续3次均未触发 (问题被模型直接回答, 属上游行为)")
