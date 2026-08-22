"""stats 用量统计测试: /stats 页面公开可看, /stats.json 受鉴权保护, 采集链路随真实请求生效。

分层:
- smoke 级 (零额度): /stats 200 + HTML 结构契约; /stats.json 未鉴权 401; 鉴权后快照结构契约。
- chat 级 (耗真实额度): 发起一次对话后, /stats.json 应反映该请求 (模型/字符/耗时字段存在)。
"""
import re

import pytest

import config

pytestmark = pytest.mark.smoke

STATS_HTML_MARKERS = [
    "Sider2API 用量统计",
    "上游请求",
    "字符总量",
    "工具调用",
    "模型分布",
    "趋势",
    "最近请求",
]

SNAPSHOT_KEYS = {"since", "totals", "models", "tools", "trend", "recent", "note"}
TOTALS_KEYS = {"requests", "streaming", "toolCalls", "inputChars", "outputChars"}


def test_stats_page_public(client):
    """/stats 页面公开 (无需鉴权), 返回自包含 HTML。"""
    r = client.get("/stats", auth=False)
    assert r.status_code == 200
    assert "text/html" in r.headers.get("content-type", "")
    html = r.text
    for marker in STATS_HTML_MARKERS:
        assert marker in html, f"/stats 页面缺少关键区块: {marker}"
    # 自包含: 内联 SVG 环形图 / 面积图, 无外部资源依赖
    assert "<svg" in html and "viewBox" in html
    assert "statsDonut" not in html  # 服务端已渲染, 不依赖 JS


def test_stats_json_requires_auth(client):
    """/stats.json 原始数据受鉴权保护: 未带 token 应 401。"""
    r = client.get("/stats.json", auth=False)
    assert r.status_code == 401


def test_stats_json_contract(client):
    """鉴权后 /stats.json 返回完整快照结构 (即使全 0)。"""
    r = client.get("/stats.json")
    assert r.status_code == 200
    snap = r.json()
    assert SNAPSHOT_KEYS <= set(snap.keys()), f"快照缺字段: {SNAPSHOT_KEYS - set(snap.keys())}"
    assert TOTALS_KEYS <= set(snap["totals"].keys())
    assert isinstance(snap["models"], list)
    assert isinstance(snap["tools"], list)
    assert isinstance(snap["trend"], list) and len(snap["trend"]) == 24  # 近 24 小时分桶
    assert isinstance(snap["recent"], list)


@pytest.mark.chat
def test_stats_reflects_chat_request(client):
    """发起一次真实对话后, 快照应出现该模型且 requests 递增。

    注意: 快照为进程内累计, 若被测实例此前已有流量, 无法断言精确计数,
    只断言"记录存在 + 结构有效"。金额消耗: 1 次代表性模型请求。
    """
    model = config.SINGLE_MODEL
    r_before = client.get("/stats.json")
    assert r_before.status_code == 200
    before = r_before.json()["totals"]["requests"]

    r = client.chat(model, [{"role": "user", "content": "用三个字回答：你好吗？"}], stream=False)
    assert r.status_code == 200, f"chat 失败: {r.text[:200]}"

    r_after = client.get("/stats.json")
    assert r_after.status_code == 200
    snap = r_after.json()
    after = snap["totals"]["requests"]
    assert after >= before + 1, f"stats 未记录本次请求: before={before} after={after}"

    # 该模型应出现在分布中, 且字段结构完整
    models = {m["model"]: m for m in snap["models"]}
    assert model in models, f"模型 {model} 未出现在分布中: {list(models)[:5]}"
    row = models[model]
    for k in ("requests", "inputChars", "outputChars", "totalChars"):
        assert k in row
    # 最近请求明细应包含本次 (新在前)
    assert snap["recent"], "recent 为空"
    newest = snap["recent"][0]
    for k in ("time", "model", "stream", "tools", "ms", "chars"):
        assert k in newest, f"recent 行缺字段: {k}"
    # 结构完整性: 字符总量与模型合计一致 (进程内单实例下应吻合)
    assert snap["totals"]["inputChars"] + snap["totals"]["outputChars"] == sum(
        m["totalChars"] for m in snap["models"]
    ), "totals 与 models 合计不一致"
