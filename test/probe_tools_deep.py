"""上游 Tool/Function Calling 深度能力探针 (probe-first, 跨模型 + 结构逆向).

目标: 最大限度挖掘 sider 上游的 tool/function calling 能力。

方法学:
  阶段1 [结构逆向]: 上次探针发现 tools 是 Go 结构体 request.ToolsParam
    (报错 "cannot unmarshal array into ... ToolsParam")。
    利用 Go json unmarshal 行为 — 对候选字段传"故意错误类型", 若该字段存在,
    会报 "cannot unmarshal X into field tools.<name> of type <T>", 从而逆向出
    ToolsParam 的完整字段表与类型; 若字段不存在则被静默忽略 (无错)。
  阶段2 [跨模型内置工具]: gpt-5.4 / gemini-3.5-flash / claude-sonnet-4.6 /
    deepseek-v4-pro / grok-4, 各测 tools.auto 全开, 看内置工具 (search/
    data_analysis/create_image) 触发能力是否因模型而异。
  阶段3 [有效字段跨模型验证]: 若阶段1发现疑似 function 字段, 跨模型验证
    能否真正触发自定义函数调用。

低频直连 (--min-interval 8)。严禁高频。
用法: python test/probe_tools_deep.py --min-interval 8
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from upstream_client import UpstreamClient, load_token

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001
    pass

# 跨公司主流模型 (各取一个代表)
MODELS = [
    ("OpenAI",    "gpt-5.4"),
    ("Google",    "gemini-3.5-flash"),
    ("Anthropic", "claude-sonnet-4.6"),
    ("DeepSeek",  "deepseek-v4-pro"),
    ("xAI",       "grok-4"),
]

# OpenAI 标准 function 定义 (用于阶段3)
WEATHER_FN = {
    "name": "get_weather",
    "description": "获取指定城市的当前天气",
    "parameters": {
        "type": "object",
        "properties": {"city": {"type": "string", "description": "城市名"}},
        "required": ["city"],
    },
}

# ToolsParam 候选字段 (常见 LLM API + sider 已知); 用"故意错误类型"探测字段是否存在
# 已知: auto(数组), image(对象)。其余为待验证猜测。
FIELD_CANDIDATES = [
    "auto", "image", "functions", "function", "function_call", "tools",
    "tool_choice", "mcp", "code_interpreter", "web_search", "retrieval",
    "file_search", "search", "artifacts", "custom_tools", "plugins",
]


def _short(res):
    return {
        "ok": res.ok, "http": res.http_status, "code": res.error_code,
        "msg": res.error_msg[:240], "events": list(res.event_types.keys()),
        "tool_calls": res.tool_calls, "text": res.text[:100],
    }


# ---------------- 阶段1: ToolsParam 结构逆向 ----------------

def reverse_engineer_toolsparam(client):
    """对每个候选字段传错误类型 (数字 12345), 借 Go unmarshal 错误逆向字段表。"""
    print(f"\n{'#'*64}\n# 阶段1: ToolsParam 结构逆向 (字段套话)\n{'#'*64}")
    findings = {}
    for field in FIELD_CANDIDATES:
        # 传一个几乎必错的类型: 数字。若字段存在且非数字类型, Go 报错暴露类型。
        res = client.send(
            prompt="hi", model="sider",
            overrides={"tools": {field: 12345}},
            max_seconds=40,
        )
        msg = res.error_msg or ""
        # Go 错误形如: cannot unmarshal number into Go struct field ToolsParam.<field> of type X
        exists = None
        gotype = None
        if "cannot unmarshal" in msg:
            # 字段相关错误 => 字段存在
            if field.lower() in msg.lower() or "ToolsParam" in msg:
                exists = True
                # 提取 "of type X"
                if "of type " in msg:
                    gotype = msg.split("of type ", 1)[1].split()[0].rstrip(".")
        elif res.ok:
            # 接受了数字 (字段是数字类型) 或字段被忽略
            exists = "maybe"  # 需进一步区分
        findings[field] = {"exists": exists, "go_type": gotype,
                           "ok": res.ok, "code": res.error_code, "msg": msg[:200]}
        flag = "✅存在" if exists is True else ("❓忽略/未知" if exists == "maybe" else "⛔")
        print(f"  [{flag:8}] tools.{field:16} type={gotype or '-':24} | {msg[:90]}")
    return findings


# ---------------- 阶段2: 跨模型内置工具能力 ----------------

def cross_model_builtin_tools(client):
    """各模型 tools.auto 全开, 观察内置工具触发能力。"""
    print(f"\n{'#'*64}\n# 阶段2: 跨模型内置工具触发 (search/data_analysis/create_image)\n{'#'*64}")
    rows = []
    for company, model in MODELS:
        res = client.send(
            prompt="搜索一下2026年6月的重大科技新闻, 并简要分析。",
            model=model,
            tools={"auto": ["search", "data_analysis", "create_image"]},
            max_seconds=75,
        )
        # 提取触发的工具名 (从 raw_first 里找 tool_call.name)
        tool_names = set()
        for raw in res.raw_first:
            if '"name"' in raw and "tool_call" in raw:
                try:
                    obj = json.loads(raw)
                    tc = obj.get("data", {}).get("tool_call", {})
                    if tc.get("name"):
                        tool_names.add(tc["name"])
                except Exception:  # noqa: BLE001
                    pass
        rows.append({"company": company, "model": model, "ok": res.ok,
                     "code": res.error_code, "tool_calls": res.tool_calls,
                     "tool_names": sorted(tool_names), "events": list(res.event_types.keys())})
        flag = "✅" if res.ok else "⛔"
        print(f"  [{flag}] {company:10} {model:22} tools={sorted(tool_names) or res.tool_calls} code={res.error_code}")
    return rows


# ---------------- 阶段3: 自定义 function 跨模型验证 ----------------

def cross_model_custom_functions(client, candidate_fields):
    """对阶段1发现的疑似 function 字段, 跨模型验证能否真正触发自定义函数。"""
    print(f"\n{'#'*64}\n# 阶段3: 自定义 function 跨模型验证\n{'#'*64}")
    if not candidate_fields:
        print("  (阶段1未发现疑似 function 字段, 跳过)")
        return []
    rows = []
    for company, model in MODELS[:3]:  # 仅 3 大主流, 控制额度
        for field in candidate_fields:
            # 按字段类型构造: functions 大概率是数组
            tools_obj = {"auto": ["data_analysis"]}
            tools_obj[field] = [WEATHER_FN]
            res = client.send(
                prompt="北京今天天气如何? 必须调用 get_weather 工具查询。",
                model=model, tools=tools_obj, max_seconds=60,
            )
            # 是否出现自定义函数调用 (tool_call.name == get_weather)
            custom_called = False
            for raw in res.raw_first:
                if "get_weather" in raw:
                    custom_called = True
            rows.append({"company": company, "model": model, "field": field,
                         "ok": res.ok, "code": res.error_code,
                         "custom_called": custom_called, "msg": res.error_msg[:120]})
            flag = "🎯触发" if custom_called else ("✅接受" if res.ok else "⛔")
            print(f"  [{flag}] {company:10} {model:20} tools.{field}=[fn] ok={res.ok} custom={custom_called}")
    return rows


def main():
    ap = argparse.ArgumentParser(description="上游 Tool/Function Calling 深度探针")
    ap.add_argument("--min-interval", type=float, default=8.0)
    args = ap.parse_args()

    token = load_token()
    if not token:
        print("[FATAL] 未找到 SIDER_AUTH_TOKEN")
        sys.exit(2)
    print(f"[OK] token loaded; min_interval={args.min_interval}s")

    client = UpstreamClient(token, timeout=80, min_interval=args.min_interval)

    findings = reverse_engineer_toolsparam(client)
    builtin = cross_model_builtin_tools(client)

    # 从阶段1挑出疑似 function 相关且"存在"的字段
    candidate_fields = [f for f, v in findings.items()
                        if v["exists"] is True and f not in ("auto", "image")
                        and any(k in f for k in ("function", "tool", "custom", "mcp", "plugin"))]
    custom = cross_model_custom_functions(client, candidate_fields)

    # 总结
    print(f"\n\n{'='*64}\n# 深度探测结论\n{'='*64}")
    confirmed_fields = [f for f, v in findings.items() if v["exists"] is True]
    print(f"\n[ToolsParam 确认存在的字段]: {confirmed_fields}")
    for f in confirmed_fields:
        print(f"    tools.{f}: go_type={findings[f]['go_type']}")

    print(f"\n[跨模型内置工具能力]:")
    for r in builtin:
        print(f"    {r['company']:10} {r['model']:22} -> {r['tool_names'] or '(无)'} (ok={r['ok']})")

    any_custom = any(r["custom_called"] for r in custom)
    print(f"\n[自定义 function calling]: {'🎯 发现可触发!' if any_custom else '⛔ 所有模型/字段均无法触发自定义函数'}")
    if any_custom:
        for r in custom:
            if r["custom_called"]:
                print(f"    🎯 {r['company']} {r['model']} via tools.{r['field']}")
    print(f"\n{'='*64}")
    print("结论: 若无自定义触发, 上游仅支持内置工具 (search/data_analysis/create_image),")
    print("      deno_pro 维持现有能力门控 (tools[] 降级 + warning) 是正确的。")


if __name__ == "__main__":
    main()
