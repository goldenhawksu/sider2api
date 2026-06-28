"""上游 sider.ai 能力探针 (probe)。

直连上游, 系统化探测其真实能力, 产出「上游能力清单」报告。落地 CLAUDE.md
第四节: 探针结果反过来定义 deno_pro.ts 该实现什么、测试该断言什么。

用法 (在仓库根或 test/ 下, 用 anaconda python310 运行):
    python test/probe_upstream.py                 # 核心维度 + 代表模型子集
    python test/probe_upstream.py --all-models    # 模型矩阵覆盖全部 live 模型
    python test/probe_upstream.py --include-vision --include-audio   # 加尝试性探测
    python test/probe_upstream.py --models gpt-5.5,sider --min-interval 8

每次产出: test/reports/upstream_capabilities_<时间戳>.md 与 .json
注意: 直连上游, 每次探测消耗真实 sider 额度; 默认限频(min_interval=5s)防 IP 级封禁,
      切勿短时间高频直连 sider.ai。
"""
import argparse
import datetime
import json
import os
import sys
from dataclasses import dataclass, field, asdict

# 直接运行时脚本目录(test/)在 sys.path[0], 可导入同目录模块
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import requests

import config
from upstream_client import UpstreamClient, load_token

# Windows 控制台安全输出中文/emoji
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001
    pass

# 状态枚举
SUPPORTED = "SUPPORTED"
PARTIAL = "PARTIAL"
NOT_SUPPORTED = "NOT_SUPPORTED"
UNKNOWN = "UNKNOWN"
ERROR = "ERROR"

_BADGE = {SUPPORTED: "✅", PARTIAL: "🟡", NOT_SUPPORTED: "⛔", UNKNOWN: "❓", ERROR: "❌"}

# 已知上游错误码语义 (来自 deno_pro.ts 与实测)
KNOWN_CODES = {
    0: "成功",
    603: "超出词数上限 (too many words)",
    1001: "无效 Token",
    1101: "并发/限流 (concurrent/rate limit)",
}


@dataclass
class DimensionResult:
    name: str
    status: str
    summary: str
    evidence: dict = field(default_factory=dict)


def _evi(res):
    """从 ProbeResult 提取通用证据。"""
    return {
        "http": res.http_status,
        "error_code": res.error_code,
        "error_msg": res.error_msg[:160],
        "event_types": res.event_types,
        "model_echo": sorted(res.model_echo),
        "ttft_s": res.ttft_s,
        "total_s": res.total_s,
        "transport_error": res.transport_error,
    }


# ---------------- 各维度探测 ----------------

def probe_connectivity(client):
    res = client.send(prompt="回复ok两个字", model="sider", stream=True)
    if res.transport_error:
        return DimensionResult("连通性与额度", ERROR, f"网络异常: {res.transport_error}", _evi(res))
    if not res.ok:
        return DimensionResult("连通性与额度", ERROR,
                               f"HTTP {res.http_status} / code {res.error_code}: {res.error_msg}", _evi(res))
    # 提取额度
    credit_brief = {}
    for c in res.credits:
        if isinstance(c, dict):
            info = c.get("info", {})
            credit_brief[c.get("type", "?")] = {"total": info.get("total"), "remain": info.get("remain"),
                                                 "used": info.get("used")}
    evi = _evi(res)
    evi["credits"] = credit_brief
    return DimensionResult("连通性与额度", SUPPORTED,
                           f"上游可达, token 有效; 额度: {credit_brief}", evi)


def probe_text(client):
    res = client.send(prompt="用一句话介绍杭州。", model="sider", stream=True)
    if not res.ok:
        return DimensionResult("文本对话", ERROR, f"code {res.error_code}: {res.error_msg}", _evi(res))
    status = SUPPORTED if res.text else PARTIAL
    return DimensionResult("文本对话", status,
                           f"返回 {len(res.text)} 字; 首字 {res.ttft_s}s", _evi(res))


def probe_think(client):
    model = config.REPRESENTATIVE_THINK_MODEL  # 例 gpt-5.5-think
    res = client.send(prompt="9.11 和 9.9 哪个更大? 简述推理。", model=model, think=True, max_seconds=90)
    if not res.ok:
        return DimensionResult("Think 模式", ERROR, f"code {res.error_code}: {res.error_msg}", _evi(res))
    has_reasoning = "reasoning_content" in res.event_types or bool(res.reasoning)
    correct = "9.9" in res.text
    if has_reasoning:
        status = SUPPORTED
        note = f"上游独立流式返回 reasoning_content (思考流 {len(res.reasoning)} 字), 答案正确={correct}"
    elif correct:
        status, note = PARTIAL, "think 参数被接受, 答案正确, 但无独立思考事件流"
    else:
        status, note = UNKNOWN, "think 参数被接受, 但未观察到明确思考证据"
    evi = _evi(res)
    evi["reasoning_chars"] = len(res.reasoning)
    evi["reasoning_preview"] = res.reasoning[:160]
    evi["answer_preview"] = res.text[:80]
    return DimensionResult("Think 模式", status, note, evi)


def probe_image(client):
    tools = {"image": {"quality_level": "nano_banana"},
             "auto": ["create_image", "data_analysis", "search"]}
    res = client.send(prompt="请画一只可爱的橘猫", model="sider", tools=tools, max_seconds=120)
    if not res.ok:
        return DimensionResult("图像生成", ERROR, f"code {res.error_code}: {res.error_msg}", _evi(res))
    imgs = [f for f in res.files if f.get("type") == "image"]
    evi = _evi(res); evi["files"] = res.files; evi["tool_calls"] = res.tool_calls
    if imgs:
        dims = f"{imgs[0].get('width')}x{imgs[0].get('height')}"
        return DimensionResult("图像生成", SUPPORTED,
                               f"生成 {len(imgs)} 图 (尺寸 {dims}); 工具调用 {res.tool_calls}", evi)
    if res.tool_calls:
        return DimensionResult("图像生成", PARTIAL, "触发图像工具但未收到图片(上游偶发失败)", evi)
    return DimensionResult("图像生成", UNKNOWN, "未触发图像工具", evi)


def probe_image_quality(client):
    """探测图像质量级别是否被上游接受 (不报错即接受)。"""
    levels = ["nano_banana", "nano_banana_lite", "nano_banana_pro"]
    accepted = {}
    for lv in levels:
        tools = {"image": {"quality_level": lv}, "auto": ["create_image", "data_analysis", "search"]}
        res = client.send(prompt="画一个红色圆形", model="sider", tools=tools, max_seconds=120)
        imgs = [f for f in res.files if f.get("type") == "image"]
        accepted[lv] = {"ok": res.ok, "error_code": res.error_code, "got_image": bool(imgs)}
    ok_levels = [k for k, v in accepted.items() if v["got_image"]]
    status = SUPPORTED if ok_levels else (PARTIAL if any(v["ok"] for v in accepted.values()) else UNKNOWN)
    return DimensionResult("图像质量级别", status, f"出图级别: {ok_levels}", {"levels": accepted})


def probe_search(client):
    tools = {"auto": ["search", "data_analysis"]}
    res = client.send(prompt="搜索一下: 2025年诺贝尔物理学奖得主是谁?", model="sider", tools=tools, max_seconds=90)
    if not res.ok:
        return DimensionResult("联网搜索", ERROR, f"code {res.error_code}: {res.error_msg}", _evi(res))
    extra_types = set(res.event_types) - {"message_start", "text", "credit_info", "pulse"}
    evi = _evi(res); evi["tool_calls"] = res.tool_calls; evi["answer_preview"] = res.text[:120]
    if res.tool_calls or extra_types:
        return DimensionResult("联网搜索", SUPPORTED,
                               f"观察到搜索/工具事件 {res.tool_calls or sorted(extra_types)}", evi)
    if res.text:
        return DimensionResult("联网搜索", UNKNOWN,
                               "有文本回答但无明确搜索事件证据(可能内置或未触发)", evi)
    return DimensionResult("联网搜索", UNKNOWN, "无明确证据", evi)


def probe_context_limit(client):
    """发送超长 prompt, 探测词数上限是否触发 code:603。"""
    # 实测: ~8810 字放行, ~22000 字起触发 603(边界有抖动); 用足量样本稳定触发
    long_prompt = ("请逐字复述以下内容。" + ("数据分析测试样本片段。" * 3000))  # ~33000 字
    res = client.send(prompt=long_prompt, model="sider", stream=True, max_seconds=90)
    evi = _evi(res); evi["prompt_chars"] = len(long_prompt)
    if res.error_code == 603:
        return DimensionResult("上下文/词数边界", SUPPORTED,
                               f"~{len(long_prompt)}字触发 code:603(超词); 阈值约 8810~22000字起; "
                               f"deno_pro 保守上限 49500字/6000词", evi)
    if res.error_code:
        return DimensionResult("上下文/词数边界", PARTIAL,
                               f"~{len(long_prompt)}字触发 code:{res.error_code}: {res.error_msg}", evi)
    return DimensionResult("上下文/词数边界", UNKNOWN,
                           f"~{len(long_prompt)}字未触发错误(上游放行或被截断)", evi)


def probe_vision(client):
    """尝试性: 在 multi_content 注入图像块, 探测上游是否接受视觉输入。

    sider 插件真实的图像输入格式未知, 故尝试几种候选形态, 如实记录。
    """
    img_url = "https://upload.wikimedia.org/wikipedia/commons/thumb/3/3a/Cat03.jpg/240px-Cat03.jpg"
    candidates = [
        [{"type": "image", "image": {"url": img_url}},
         {"type": "text", "text": "这张图里是什么动物?只回答动物名。", "user_input_text": "这张图里是什么动物?"}],
        [{"type": "image_url", "image_url": {"url": img_url}},
         {"type": "text", "text": "这张图里是什么动物?只回答动物名。", "user_input_text": "这张图里是什么动物?"}],
    ]
    trials = []
    understood = False
    for i, mc in enumerate(candidates):
        res = client.send(multi_content=mc, model="sider", max_seconds=60)
        ans = res.text[:60]
        hit = ("猫" in res.text) or ("cat" in res.text.lower())
        trials.append({"shape": "image" if i == 0 else "image_url", "ok": res.ok,
                       "error_code": res.error_code, "answer": ans, "looks_understood": hit})
        understood = understood or (res.ok and hit)
    status = SUPPORTED if understood else UNKNOWN
    note = "某候选格式下上游似能理解图像内容" if understood else "未观察到上游理解图像(格式未知或不支持视觉输入)"
    return DimensionResult("视觉输入(尝试性)", status, note, {"trials": trials})


def probe_audio(client):
    """尝试性: 请求语音/朗读, 探测是否返回音频产物。"""
    res = client.send(prompt="请把『你好世界』转成语音朗读并给我音频文件。", model="sider", max_seconds=60)
    audio_files = [f for f in res.files if (f.get("type") or "") != "image"]
    evi = _evi(res); evi["files"] = res.files
    if audio_files:
        return DimensionResult("音频(尝试性)", SUPPORTED, f"返回非图像文件: {audio_files}", evi)
    return DimensionResult("音频(尝试性)", NOT_SUPPORTED,
                           "未返回任何音频产物(上游大概率不支持音频)", evi)


def probe_models(client, models):
    """模型可用性矩阵: 逐个最小请求, 记录可用性与上游回显。"""
    rows = []
    for m in models:
        res = client.send(prompt="回复ok", model=m, stream=True, max_seconds=60)
        echo = sorted(res.model_echo)
        # 上游回显非请求模型 (且非空) 视为可能回退
        fell_back = bool(echo) and m not in echo and "sider" in echo and m != "sider"
        rows.append({"model": m, "ok": res.ok, "error_code": res.error_code,
                     "has_text": bool(res.text), "echo": echo, "fell_back": fell_back,
                     "ttft_s": res.ttft_s})
    usable = [r["model"] for r in rows if r["ok"] and r["has_text"]]
    fb = [r["model"] for r in rows if r["fell_back"]]
    errs = [(r["model"], r["error_code"]) for r in rows if not r["ok"]]
    status = SUPPORTED if usable and not errs else (PARTIAL if usable else ERROR)
    summary = f"可用 {len(usable)}/{len(rows)}"
    if fb:
        summary += f"; 疑似回退 sider: {fb}"
    if errs:
        summary += f"; 异常: {errs}"
    return DimensionResult("模型矩阵", status, summary, {"rows": rows})


# ---------------- 编排与报告 ----------------

def fetch_all_model_ids():
    r = requests.get(config.DEFAULT_BASE_URL + "/v1/models", timeout=20)
    r.raise_for_status()
    return [m["id"] for m in r.json().get("data", [])]


def build_report(results, observed_codes):
    ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    lines = [f"# 上游 sider.ai 能力清单  {ts}", "",
             "> 由 test/probe_upstream.py 直连上游探测产出。状态: "
             "✅支持 / 🟡部分 / ⛔不支持 / ❓未知 / ❌错误。", "",
             "## 能力总览", "", "| 维度 | 状态 | 结论 |", "|---|---|---|"]
    for r in results:
        lines.append(f"| {r.name} | {_BADGE.get(r.status,'')} {r.status} | {r.summary} |")
    lines += ["", "## 错误码字典", "", "| code | 含义 | 本次是否观察到 |", "|---|---|---|"]
    for code, mean in KNOWN_CODES.items():
        seen = "是" if code in observed_codes else ""
        lines.append(f"| {code} | {mean} | {seen} |")
    extra_codes = [c for c in observed_codes if c not in KNOWN_CODES]
    for c in extra_codes:
        lines.append(f"| {c} | (新观察, 待确认) | 是 |")
    lines += ["", "## 各维度证据", ""]
    for r in results:
        lines.append(f"### {_BADGE.get(r.status,'')} {r.name} — {r.status}")
        lines.append(f"{r.summary}")
        lines.append("```json")
        lines.append(json.dumps(r.evidence, ensure_ascii=False, indent=2))
        lines.append("```")
        lines.append("")
    return ts, "\n".join(lines)


def main():
    ap = argparse.ArgumentParser(description="上游 sider.ai 能力探针")
    ap.add_argument("--all-models", action="store_true", help="模型矩阵覆盖全部 live 模型")
    ap.add_argument("--models", default=None, help="逗号分隔的模型清单, 覆盖默认代表子集")
    ap.add_argument("--include-vision", action="store_true", help="加视觉输入尝试性探测")
    ap.add_argument("--include-audio", action="store_true", help="加音频尝试性探测")
    ap.add_argument("--include-quality", action="store_true", help="加图像质量级别探测")
    ap.add_argument("--min-interval", type=float, default=5.0,
                    help="相邻上游请求最小间隔秒(限频防 IP 封禁, 默认5)")
    ap.add_argument("--timeout", type=float, default=60.0, help="单请求超时秒")
    args = ap.parse_args()

    token = load_token()
    if not token:
        print("[FATAL] 未找到 SIDER_AUTH_TOKEN (.env 或环境变量)")
        sys.exit(2)
    print(f"[OK] token loaded (len={len(token)}); 限频 min_interval={args.min_interval}s")

    client = UpstreamClient(token, timeout=args.timeout, min_interval=args.min_interval)

    if args.models:
        models = [m.strip() for m in args.models.split(",") if m.strip()]
    elif args.all_models:
        try:
            models = fetch_all_model_ids()
        except Exception as e:  # noqa: BLE001
            print(f"[WARN] 拉取全量模型失败, 退回代表子集: {e}")
            models = list(config.REPRESENTATIVE_MODELS)
    else:
        models = list(config.REPRESENTATIVE_MODELS)

    # 编排探测维度 (顺序执行, 每个独立容错)
    probes = [
        ("连通性与额度", lambda: probe_connectivity(client)),
        ("文本对话", lambda: probe_text(client)),
        ("Think 模式", lambda: probe_think(client)),
        ("图像生成", lambda: probe_image(client)),
        ("联网搜索", lambda: probe_search(client)),
        ("上下文/词数边界", lambda: probe_context_limit(client)),
        (f"模型矩阵({len(models)})", lambda: probe_models(client, models)),
    ]
    if args.include_quality:
        probes.append(("图像质量级别", lambda: probe_image_quality(client)))
    if args.include_vision:
        probes.append(("视觉输入", lambda: probe_vision(client)))
    if args.include_audio:
        probes.append(("音频", lambda: probe_audio(client)))

    results = []
    observed_codes = set()
    for label, fn in probes:
        print(f"\n>>> 探测: {label} ...")
        try:
            r = fn()
        except Exception as e:  # noqa: BLE001
            r = DimensionResult(label, ERROR, f"探测异常: {type(e).__name__}: {e}")
        results.append(r)
        # 收集观察到的错误码
        ec = r.evidence.get("error_code")
        if ec not in (None, 0):
            observed_codes.add(ec)
        for row in r.evidence.get("rows", []):
            if row.get("error_code") not in (None, 0):
                observed_codes.add(row["error_code"])
        print(f"    -> {r.status}: {r.summary}")

    ts, report_md = build_report(results, observed_codes)
    reports_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "test", "reports")
    os.makedirs(reports_dir, exist_ok=True)
    md_path = os.path.join(reports_dir, f"upstream_capabilities_{ts}.md")
    json_path = os.path.join(reports_dir, f"upstream_capabilities_{ts}.json")
    with open(md_path, "w", encoding="utf-8") as f:
        f.write(report_md)
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump([asdict(r) for r in results], f, ensure_ascii=False, indent=2)

    print("\n" + "=" * 60)
    print("上游能力清单 (摘要):")
    for r in results:
        print(f"  [{r.status:13}] {r.name}: {r.summary}")
    print("=" * 60)
    print(f"报告: {md_path}")
    print(f"JSON: {json_path}")


if __name__ == "__main__":
    main()
