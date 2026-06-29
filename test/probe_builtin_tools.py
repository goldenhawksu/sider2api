"""内置工具完整清单挖掘探针 (probe-first, 跨模型).

深度探针已确认 ToolsParam 只有 auto/image 两字段, 无自定义 function calling。
本脚本聚焦另一面: 最大限度挖掘 sider 内置工具白名单 (tools.auto 接受哪些工具名),
并跨模型记录每个模型实际能触发的内置工具完整集合。

已知内置工具: search, data_analysis, create_image, web_fetch (gpt-5.4 实测新发现)。
本脚本用诱导性 prompt (需搜索+抓取网页+计算+画图) 让模型自然触发尽可能多工具,
完整捕获 tool_call.name; 并试探 auto 白名单候选工具名是否被接受/触发。

低频直连 (--min-interval 8)。
用法: python test/probe_builtin_tools.py --min-interval 8
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from upstream_client import UpstreamClient, load_token

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001
    pass

MODELS = [
    ("OpenAI",    "gpt-5.4"),
    ("Google",    "gemini-3.5-flash"),
    ("Anthropic", "claude-sonnet-4.6"),
    ("DeepSeek",  "deepseek-v4-pro"),
    ("xAI",       "grok-4"),
]

# auto 白名单候选 (已知 + 猜测), 全部塞进 auto, 看哪些被真正触发
TOOL_CANDIDATES = [
    "search", "data_analysis", "create_image", "web_fetch",
    "web_search", "browse", "code", "code_interpreter", "python",
    "retrieval", "knowledge", "image_edit", "vision", "url_fetch",
]

# 诱导多工具的复合任务 prompt
MULTI_TOOL_PROMPT = (
    "请完成: 1) 搜索 2026 年 AI 领域最新进展; "
    "2) 抓取并阅读其中一个来源网页的内容; "
    "3) 计算 1234 * 5678 的结果; "
    "4) 画一张代表 AI 的简单图标。请依次执行。"
)


def probe_model(client, company, model):
    res = client.send(
        prompt=MULTI_TOOL_PROMPT, model=model,
        tools={"auto": TOOL_CANDIDATES, "image": {"quality_level": "nano_banana"}},
        max_seconds=120,
    )
    names = sorted(res.tool_names)
    # 提取每个工具的 arguments 样例 (前1个)
    detail_sample = {}
    for d in res.tool_details:
        n = d.get("name")
        if n and n not in detail_sample and d.get("arguments"):
            detail_sample[n] = d["arguments"][:80]
    print(f"\n{'='*64}")
    print(f">>> {company} / {model}")
    print(f"    ok={res.ok} code={res.error_code} events={list(res.event_types.keys())}")
    print(f"    触发工具: {names or '(无)'}")
    for n, arg in detail_sample.items():
        print(f"      - {n}: args={arg}")
    has_image = any(f.get("type") == "image" for f in res.files)
    print(f"    出图: {has_image}; 文本{len(res.text)}字")
    return {"company": company, "model": model, "ok": res.ok,
            "code": res.error_code, "tools": names, "has_image": has_image}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-interval", type=float, default=8.0)
    args = ap.parse_args()

    token = load_token()
    if not token:
        print("[FATAL] 未找到 SIDER_AUTH_TOKEN")
        sys.exit(2)
    print(f"[OK] token loaded; min_interval={args.min_interval}s")
    print(f"[INFO] auto 候选工具 ({len(TOOL_CANDIDATES)}): {TOOL_CANDIDATES}")

    client = UpstreamClient(token, timeout=120, min_interval=args.min_interval)

    rows = [probe_model(client, c, m) for c, m in MODELS]

    # 全局汇总
    print(f"\n\n{'#'*64}\n# 内置工具完整清单 (跨模型聚合)\n{'#'*64}")
    all_tools = set()
    for r in rows:
        all_tools.update(r["tools"])
    print(f"\n[发现的全部内置工具]: {sorted(all_tools)}")
    print(f"\n[各模型触发能力]:")
    for r in rows:
        print(f"    {r['company']:10} {r['model']:22} -> {r['tools'] or '(无)'} 出图={r['has_image']}")

    # 哪些候选未被任何模型触发 (可能不存在或难诱导)
    untriggered = [t for t in TOOL_CANDIDATES if t not in all_tools]
    print(f"\n[候选中未观察到触发]: {untriggered}")
    print(f"\n{'='*64}")
    print("说明: auto 是 []string 白名单, 传未知工具名不报错但不会触发;")
    print("      '触发'才是上游真实支持的内置工具证据。")


if __name__ == "__main__":
    main()
