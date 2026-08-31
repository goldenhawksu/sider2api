"""限速门控功能测试: 每模型 1 分钟最多 6 次调用, 配额耗尽后熔断。

设计要点:
- 每个测试用【独立模型】, 避免与主测试套件 (gpt-5.5/claude-opus-4.8/gemini-2.5-pro 等)
  及测试文件内部互相干扰 (限速状态在实例内存, 共享)。
- 熔断/限速影响最多持续 1 小时 (opus), 因此受影响的模型不用于其他测试。
- Sider code:603 是输入过长, 不应触发模型熔断。

覆盖:
- 限速窗口: 连续 6 次成功后第 7 次应被 429 拒绝 (model_rate_limited)。
- 模型隔离: 一个模型限速不影响其他模型。
- 错误格式: 429 响应 OpenAI 兼容 (type/code/model + Retry-After)。
- 输入过长: code:603 返回 400, 但后续短请求不被本地熔断。

金额消耗: 每用例约 6 次真实额度 (第 7 次被门控拦截), 603 用例会额外发起一次短请求。
"""
import time

import pytest

import config

pytestmark = [pytest.mark.cost, pytest.mark.rate_limit]

# 各用例独立模型 (不在主套件 REPRESENTATIVE_MODELS 中, 避免干扰)
RL_MODEL_A = "gpt-5-mini"        # 6 次限速窗口
RL_MODEL_B = "gpt-5.1"           # 隔离测试 - 被限速
RL_OTHER = "gpt-5.4-mini"        # 隔离测试 - 不应被限速
RL_MODEL_C = "gpt-5.6-sol"       # 错误格式
CONTEXT_MODEL = "gpt-5.6-terra"   # 603 不熔断
OPUS_CONTEXT_MODEL = "claude-opus-4.5"   # opus 的 603 也不熔断

# 触发上游 code:603 的超长 prompt (~48000 字符, 超 8810~22000 阈值)
_LONG_PROMPT = "请逐字复述。" + ("测试数据" * 12000)


def _exhaust_quota(client, model, n=6):
    """耗掉某模型 n 次配额 (n 次应全部成功; 之后下一次调用才被限速拒绝)。"""
    for i in range(n):
        r = client.chat(model, [{"role": "user", "content": "说一个字"}], stream=False)
        assert r.status_code == 200, f"第{i+1}次应成功: {r.text[:100]}"
        time.sleep(0.3)


def test_rate_limit_after_6_calls(client):
    """连续 6 次成功后, 第 7 次应被限速拒绝 (429 + Retry-After)。"""
    model = RL_MODEL_A
    _exhaust_quota(client, model)  # 6 次成功, count=6
    r7 = client.chat(model, [{"role": "user", "content": "说一个字"}], stream=False)  # 第 7 次
    assert r7.status_code == 429, f"第7次应 429: {r7.status_code} {r7.text[:150]}"
    err = r7.json().get("error", {})
    assert err.get("type") == "rate_limit_error", f"应 rate_limit_error: {err}"
    assert err.get("code") == "model_rate_limited", f"应 model_rate_limited: {err}"
    assert err.get("model") == model
    assert int(r7.headers.get("retry-after", "0")) >= 1, "应带 Retry-After"


def test_rate_limit_isolation(client):
    """模型限速互相隔离: 一个模型被限速不影响其他模型。"""
    _exhaust_quota(client, RL_MODEL_B)  # 6 次成功
    r_limited = client.chat(RL_MODEL_B, [{"role": "user", "content": "说一个字"}], stream=False)  # 第 7 次
    assert r_limited.status_code == 429, f"RL_MODEL_B 应已限速: {r_limited.status_code}"
    r_other = client.chat(RL_OTHER, [{"role": "user", "content": "说一个字"}], stream=False)
    assert r_other.status_code == 200, f"其他模型不应被限速: {r_other.status_code} {r_other.text[:100]}"


def test_rate_limit_error_format(client):
    """限速错误响应 OpenAI 兼容格式 (error.type/code/model + message 含限速说明)。"""
    model = RL_MODEL_C
    _exhaust_quota(client, model)  # 6 次成功
    r = client.chat(model, [{"role": "user", "content": "说一个字"}], stream=False)  # 第 7 次
    assert r.status_code == 429
    body = r.json()
    assert "error" in body and "message" in body["error"], f"缺 message: {body}"
    assert "限速" in body["error"]["message"], f"message 应含限速说明: {body}"
    assert "60 秒最多 6 次" in body["error"]["message"], f"message 应含策略: {body}"


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
