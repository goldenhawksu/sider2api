"""性能测试: 非流式总延迟 (参数化代表子集) + 流式 TTFT/吞吐。

阈值取宽松上限 (见 config.PERF_*), 仅作冒烟门槛; 真实指标记录在
test/reports/ 报告中, 用于横向对比 deno_pro.ts 各版本性能。
"""
import pytest

from config import PERF_TOTAL_MAX_S, PERF_TTFT_MAX_S, STREAM_MODEL
from helpers import measure_chat

pytestmark = [pytest.mark.perf, pytest.mark.cost]

_PROMPT = [{"role": "user", "content": "用两三句话介绍一下杭州这座城市。"}]


def test_perf_nonstream_latency(client, perf_recorder, chat_model):
    metric = measure_chat(client, chat_model, _PROMPT, stream=False, label="nonstream")
    perf_recorder.append(metric)
    assert metric.chars > 0
    assert metric.total_s < PERF_TOTAL_MAX_S, f"非流式总耗时过长: {metric.total_s}s"


@pytest.mark.stream
def test_perf_stream_ttft(client, perf_recorder):
    metric = measure_chat(client, STREAM_MODEL, _PROMPT, stream=True, label="stream")
    perf_recorder.append(metric)
    assert metric.chunks > 0
    assert metric.ttft_s is not None, "未测得 TTFT"
    assert metric.ttft_s < PERF_TTFT_MAX_S, f"首字延迟过长: {metric.ttft_s}s"
