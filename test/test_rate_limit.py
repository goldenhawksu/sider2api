"""限速门控的【真实上游】行为测试: Sider code:603 不应触发本地熔断。

设计要点:
- 每个测试用【独立模型】, 避免与主测试套件及测试文件内部互相干扰
  (限速状态在实例内存, 共享)。
- Sider code:603 是输入过长, 不应触发模型熔断。

覆盖:
- 输入过长: code:603 返回 400, 但后续短请求不被本地熔断 (普通模型 + opus 各一例)。

注: 配额耗尽拦截 / 模型隔离 / 429 错误格式这三项原本也在本文件, 每例要真打 6+ 次上游。
它们测的是门控逻辑而非上游行为, 已迁至 test_deno_pro_mock_regression.py::
test_quota_exhaustion_blocks_and_isolates_by_model (mock 实例, 零额度, 且用固定配额
不受 AIMD 自适应放宽影响)。

金额消耗: 每用例 2 次真实额度 (一次超长 prompt + 一次短请求)。
"""
import time

import pytest

import config

pytestmark = [pytest.mark.cost, pytest.mark.rate_limit]

# 各用例独立模型 (不在主套件 REPRESENTATIVE_MODELS 中, 避免干扰)
CONTEXT_MODEL = "gpt-5.6-terra"   # 603 不熔断
OPUS_CONTEXT_MODEL = "claude-opus-4.6"   # opus 的 603 也不熔断 (取额度较宽松的 opus 变体)

# 触发上游 code:603 的超长 prompt (~48000 字符, 超 8810~22000 阈值)
_LONG_PROMPT = "请逐字复述。" + ("测试数据" * 12000)


def test_603_does_not_trigger_circuit_breaker(client):
    """输入过长(code:603)只拒绝当前请求, 不应让该模型进入 60s 熔断。"""
    model = CONTEXT_MODEL
    # 触发上游失败 (超长 prompt -> code 603)
    r = client.chat(model, [{"role": "user", "content": _LONG_PROMPT}], stream=False)
    assert r.status_code == 400, f"超长 prompt 应触发 603 类错误: {r.status_code} {r.text[:100]}"
    time.sleep(0.5)
    # 不应熔断: 立即调用短请求应继续触达上游
    r2 = client.chat(model, [{"role": "user", "content": "说一个字"}], stream=False)
    assert r2.status_code == 200, f"603 后不应本地熔断: {r2.status_code} {r2.text[:120]}"


def test_opus_603_does_not_trigger_1hour_circuit_breaker(client):
    """opus 模型的 code:603 也只是输入错误, 不应触发 1 小时熔断。"""
    model = OPUS_CONTEXT_MODEL
    r = client.chat(model, [{"role": "user", "content": _LONG_PROMPT}], stream=False)
    assert r.status_code == 400, f"超长 prompt 应触发 603 类错误: {r.status_code} {r.text[:100]}"
    time.sleep(0.5)
    r2 = client.chat(model, [{"role": "user", "content": "说一个字"}], stream=False)
    assert r2.status_code == 200, f"opus 的 603 后不应本地熔断: {r2.status_code} {r2.text[:120]}"
