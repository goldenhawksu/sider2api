"""stats 用量统计测试: /stats 页面公开可看, /stats.json 公开返回快照+预渲染片段,
时间戳用 UTC+8 显示, 页面内嵌 5 秒局部刷新脚本, 采集链路随真实请求生效。

分层:
- smoke 级 (零额度): /stats 200 + HTML 结构契约; /stats.json 公开 + 快照结构 + html 片段契约。
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
    "setInterval",
    "REFRESH_MS = 5000",
    "refreshStats",
]

SNAPSHOT_KEYS = {"since", "totals", "models", "tools", "trend", "recent", "note", "persisted", "html"}
TOTALS_KEYS = {"requests", "streaming", "toolCalls", "inputChars", "outputChars"}

# /stats.json 附带的预渲染 HTML 片段应覆盖这些区块 id
HTML_FRAGMENT_KEYS = {"tiles", "sub", "donut", "modelRows", "trend", "toolRows", "recentRows", "footer"}


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
    # 页面内嵌 5s 局部刷新脚本 (fetch /stats.json 原地替换 DOM, 不整页刷新)
    assert "fetch('/stats.json'" in html
    assert "setInterval" in html and "5000" in html


def test_stats_json_public(client):
    """/stats.json 与 /stats 同级公开 (页面每 5s 局部刷新依赖它, 无需鉴权)。"""
    r = client.get("/stats.json", auth=False)
    assert r.status_code == 200
    assert "application/json" in r.headers.get("content-type", "")


def test_stats_json_contract(client):
    """/stats.json 返回完整快照结构 (即使全 0) + 预渲染 HTML 片段。"""
    r = client.get("/stats.json", auth=False)
    assert r.status_code == 200
    snap = r.json()
    assert SNAPSHOT_KEYS <= set(snap.keys()), f"快照缺字段: {SNAPSHOT_KEYS - set(snap.keys())}"
    assert TOTALS_KEYS <= set(snap["totals"].keys())
    assert isinstance(snap["models"], list)
    assert isinstance(snap["tools"], list)
    assert isinstance(snap["trend"], list) and len(snap["trend"]) == 24  # 近 24 小时分桶
    assert isinstance(snap["recent"], list)
    # 预渲染 HTML 片段: 覆盖所有可局部刷新的区块
    frag = snap.get("html", {})
    missing = HTML_FRAGMENT_KEYS - set(frag.keys())
    assert not missing, f"html 片段缺区块: {missing}"


def test_stats_page_utc8_timestamps(client):
    """/stats 页面时间戳应为 UTC+8 (北京/上海), 而非服务器 UTC。

    通过 /stats.html 片段的趋势图 x 轴标签断言: 快照 trend 的 at 是 UTC ISO 字符串,
    页面显示的 hhmm 应等于 at+8h 的时分。取最近一个桶做验证。
    """
    r = client.get("/stats.json", auth=False)
    assert r.status_code == 200
    snap = r.json()
    trend = snap["trend"]
    assert trend, "trend 为空"
    last = trend[-1]
    # at 是 UTC ISO; UTC+8 的时分 = 原时分 + 8h (跨天自动进位)
    from datetime import datetime, timedelta, timezone
    utc = datetime.fromisoformat(last["at"].replace("Z", "+00:00"))
    utc8 = utc + timedelta(hours=8)
    expect_hhmm = f"{utc8.hour:02d}:{utc8.minute:02d}"

    page = client.get("/stats", auth=False)
    assert page.status_code == 200
    assert expect_hhmm in page.text, (
        f"页面未显示 UTC+8 时间 {expect_hhmm} (trend 末桶 at={last['at']})"
    )


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
