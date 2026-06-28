"""think 模式测试 (-think 后缀): 需要推理的数值比较题。"""
import pytest

from config import REPRESENTATIVE_THINK_MODEL
from helpers import extract_content

pytestmark = [pytest.mark.cost, pytest.mark.think]


def test_think_mode_numeric_compare(client, live_models):
    model = REPRESENTATIVE_THINK_MODEL
    if model not in live_models:
        pytest.skip(f"{model} 不在 live 模型清单中")

    r = client.chat(
        model,
        [{"role": "user", "content": "9.11 和 9.9 哪个更大? 只回答更大的那个数字。"}],
        stream=False,
    )
    assert r.status_code == 200, r.text[:200]
    content = extract_content(r.json())
    assert "9.9" in content, f"think 模式推理结果不正确: {content!r}"
