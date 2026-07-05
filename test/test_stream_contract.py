"""流式 SSE 契约测试 (TDD)。

借鉴 sider2claude 的真流式 content-block 状态机后, 对 sider2api 的流式事件序列
建立不变量断言。覆盖本次优化项:

1. Anthropic content-block 状态机
   - message_start 恰好一次且在最前;
   - content_block_start / content_block_stop 严格成对;
   - block index 从 0 连续、单调、无重复、无负值 (修复旧版对 index 0 重复
     发送 content_block_start、thinking 块(index 1)永不闭合、无内容时发
     content_block_stop index:-1 等硬伤);
   - 每个 content_block_delta.index 必须落在已开启的块上;
   - message_delta.usage.output_tokens 为 token 估算 (非字符数直填)。
2. think 模式下 thinking 块必须闭合, 且位于 text 块之前。
3. SSE 心跳: 短 ping 间隔下应出现 ping 帧且不破坏内容解析 (gated, 见下)。

均为流式请求, 消耗少量上游额度 (cost)。心跳存在性断言需被测实例以
SSE_PING_INTERVAL_MS<=500 启动, 并设 EXPECT_SSE_PING=1, 否则自动跳过。
"""
import json
import os

import pytest

pytestmark = [pytest.mark.stream, pytest.mark.anthropic]

ANTHRO_MODEL = "gpt-5.5"
ANTHRO_THINK_MODEL = "gpt-5.5-think"

# 被 ping 心跳产生、解析时应忽略的事件名
_PING_NAMES = (":comment", "ping")


def _collect_anthropic_events(client, body):
    """发起 Anthropic 流式请求, 返回 [(event_name, obj_or_None), ...] (保序)。

    - `event: xxx` 行决定后续 data 的事件名; data 中 type 作兜底。
    - `: ...` SSE 注释行 (comment ping) 记为 (":comment", None)。
    - `event: ping` + data 记为 ("ping", {...})。
    """
    r = client.session.post(
        client._url("/v1/messages"),
        headers=client._headers(auth=True, extra={"anthropic-version": "2023-06-01"}),
        json={**body, "stream": True},
        stream=True,
        timeout=client._timeout(),
    )
    assert r.status_code == 200, r.text[:300]
    r.encoding = "utf-8"

    events = []
    cur_event = None
    for raw in r.iter_lines(decode_unicode=True):
        if raw is None:
            continue
        line = raw.strip()
        if not line:
            continue
        if line.startswith(":"):
            events.append((":comment", None))
            continue
        if line.startswith("event:"):
            cur_event = line[len("event:"):].strip()
            continue
        if line.startswith("data:"):
            payload = line[len("data:"):].strip()
            if payload == "[DONE]":
                cur_event = None
                continue
            try:
                obj = json.loads(payload)
            except json.JSONDecodeError:
                cur_event = None
                continue
            name = cur_event or (obj.get("type") if isinstance(obj, dict) else None)
            events.append((name, obj))
            cur_event = None
    return events


def _core(events):
    """剔除心跳/注释后的核心事件。"""
    return [(n, o) for n, o in events if n not in _PING_NAMES]


# ==================== Anthropic content-block 状态机契约 ====================

@pytest.mark.cost
def test_anthropic_stream_block_contract(client):
    """Anthropic 流式事件序列应满足 content-block 状态机不变量。"""
    events = _collect_anthropic_events(client, {
        "model": ANTHRO_MODEL,
        "max_tokens": 512,
        "messages": [{"role": "user", "content": "从1数到5,用逗号分隔。"}],
    })
    core = _core(events)
    names = [n for n, _ in core]
    assert names, "无核心事件"

    # message_start 恰好一次且在最前
    ms_positions = [i for i, (n, _) in enumerate(core) if n == "message_start"]
    assert len(ms_positions) == 1, f"message_start 应恰好一次, 实际 {len(ms_positions)}: {names}"
    assert ms_positions[0] == 0, f"message_start 应为首个事件: {names[:3]}"

    starts = [o for n, o in core if n == "content_block_start"]
    stops = [o for n, o in core if n == "content_block_stop"]
    assert len(starts) >= 1, "应至少有一个 content block"
    assert len(starts) == len(stops), \
        f"content_block_start({len(starts)}) 与 content_block_stop({len(stops)}) 不成对: {names}"

    start_idx = [o["index"] for o in starts]
    stop_idx = [o["index"] for o in stops]
    assert all(i >= 0 for i in start_idx), f"block index 不应为负: {start_idx}"
    assert len(set(start_idx)) == len(start_idx), f"content_block_start index 重复: {start_idx}"
    assert start_idx == list(range(len(start_idx))), f"block index 应从 0 连续: {start_idx}"
    assert sorted(stop_idx) == sorted(start_idx), \
        f"每个 start 应有同 index 的 stop: start={start_idx} stop={stop_idx}"

    # 每个 delta 的 index 必须落在已开启的块上
    open_indices = set(start_idx)
    for n, o in core:
        if n == "content_block_delta":
            assert o.get("index") in open_indices, \
                f"content_block_delta.index={o.get('index')} 无对应 content_block_start"

    # message_delta 存在, message_stop 收尾
    assert "message_delta" in names, f"缺少 message_delta: {names}"
    assert core[-1][0] == "message_stop", f"末事件应为 message_stop, 实际 {core[-1][0]}"

    # usage.output_tokens 为正整数且是 token 估算 (不等于字符数)
    md = next(o for n, o in core if n == "message_delta")
    ot = md.get("usage", {}).get("output_tokens")
    text = "".join(
        o["delta"]["text"] for n, o in core
        if n == "content_block_delta" and o.get("delta", {}).get("type") == "text_delta"
    )
    assert isinstance(ot, int) and ot > 0, f"output_tokens 应为正整数: {ot}"
    if len(text) >= 8:
        assert ot < len(text), \
            f"output_tokens({ot}) 疑似字符数直填(字符数={len(text)}), 应为 token 估算"


@pytest.mark.think
@pytest.mark.cost
def test_anthropic_stream_thinking_block_closed(client, live_models):
    """think 模式: thinking 块必须闭合, 且位于 text 块之前。"""
    if ANTHRO_THINK_MODEL not in live_models:
        pytest.skip(f"{ANTHRO_THINK_MODEL} 不在 live 模型清单中")

    events = _collect_anthropic_events(client, {
        "model": ANTHRO_THINK_MODEL,
        "max_tokens": 512,
        "messages": [{"role": "user", "content": "1+1等于几? 简要说明理由。"}],
    })
    core = _core(events)
    starts = [o for n, o in core if n == "content_block_start"]
    stops = [o for n, o in core if n == "content_block_stop"]
    assert len(starts) >= 1, "应至少有一个 content block"
    assert len(starts) == len(stops), \
        f"content block start/stop 不成对: start={len(starts)} stop={len(stops)}"

    idx = [o["index"] for o in starts]
    assert idx == list(range(len(idx))), f"block index 应从 0 连续: {idx}"

    kinds = [o["content_block"]["type"] for o in starts]
    if "thinking" in kinds and "text" in kinds:
        assert kinds.index("thinking") < kinds.index("text"), \
            f"thinking 块应先于 text 块: {kinds}"


# ==================== SSE 心跳 (gated) ====================

@pytest.mark.think
@pytest.mark.cost
def test_anthropic_stream_heartbeat_ping(client, live_models):
    """短 ping 间隔下, think 流式应出现 ping 心跳且不破坏内容完整性。

    需被测实例以 SSE_PING_INTERVAL_MS<=500 启动, 且设环境变量 EXPECT_SSE_PING=1;
    否则跳过 (生产默认 15s 心跳, 快响应不会触发 ping, 断言存在性会误伤)。
    """
    if os.getenv("EXPECT_SSE_PING") != "1":
        pytest.skip("未启用心跳存在性断言 (需 EXPECT_SSE_PING=1 且实例短 ping 间隔)")
    if ANTHRO_THINK_MODEL not in live_models:
        pytest.skip(f"{ANTHRO_THINK_MODEL} 不在 live 模型清单中")

    events = _collect_anthropic_events(client, {
        "model": ANTHRO_THINK_MODEL,
        "max_tokens": 512,
        "messages": [{"role": "user", "content": "用三句话解释相对论。"}],
    })
    assert any(n in _PING_NAMES for n, _ in events), "未观测到 SSE 心跳 ping 帧"

    core = _core(events)
    assert core and core[-1][0] == "message_stop", "心跳干扰下内容未正常收尾"
    starts = [o for n, o in core if n == "content_block_start"]
    stops = [o for n, o in core if n == "content_block_stop"]
    assert len(starts) == len(stops) >= 1, "心跳干扰下 content block 不成对"
