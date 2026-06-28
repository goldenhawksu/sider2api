"""多轮会话记忆测试 (X-Session-ID): 第一轮告知信息, 第二轮验证能记住。"""
import uuid

import pytest

from config import SINGLE_MODEL
from helpers import extract_content

pytestmark = [pytest.mark.cost, pytest.mark.multiturn]


def test_session_memory(client):
    sid = "pytest-" + uuid.uuid4().hex[:12]

    r1 = client.chat(
        SINGLE_MODEL,
        [{"role": "user", "content": "请记住:我的幸运数字是42。"}],
        session_id=sid,
    )
    assert r1.status_code == 200, r1.text[:200]

    r2 = client.chat(
        SINGLE_MODEL,
        [
            {"role": "user", "content": "请记住:我的幸运数字是42。"},
            {"role": "assistant", "content": "好的,我记住了。"},
            {"role": "user", "content": "我的幸运数字是多少?只回答数字。"},
        ],
        session_id=sid,
    )
    assert r2.status_code == 200, r2.text[:200]
    content = extract_content(r2.json())
    assert "42" in content, f"未记住上下文: {content!r}"
