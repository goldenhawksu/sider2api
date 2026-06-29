"""上游 Function Calling 能力探针 (probe-first).

按 CLAUDE.md 铁律: 新能力上线前必须先 probe 上游确认其存在与协议形状。
本脚本探测 sider.ai 是否支持标准 OpenAI function calling 协议:
  1. 传入 OpenAI 风格 tools[] (function 定义), 看上游是否接受 / 报错
  2. 观察响应里是否出现 tool_calls / function_call 事件
  3. 探测 sider 原生 tools.auto 字段 (已知支持) 作为对照

低频直连 (--min-interval 8), 严禁高频。
用法: python test/probe_tools.py --min-interval 8
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

# OpenAI 风格 function 定义 (标准协议)
WEATHER_TOOL = {
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "获取指定城市的当前天气",
        "parameters": {
            "type": "object",
            "properties": {
                "city": {"type": "string", "description": "城市名称"},
                "unit": {"type": "string", "enum": ["celsius", "fahrenheit"]},
            },
            "required": ["city"],
        },
    },
}


def _summarize(res, label):
    print(f"\n{'='*60}")
    print(f">>> {label}")
    print(f"    http={res.http_status} ok={res.ok} error_code={res.error_code}")
    if res.error_msg:
        print(f"    error_msg={res.error_msg[:200]}")
    print(f"    event_types={res.event_types}")
    print(f"    tool_calls={res.tool_calls}")
    print(f"    text[:120]={res.text[:120]!r}")
    if res.raw_first:
        print(f"    raw_first:")
        for r in res.raw_first[:6]:
            print(f"      {r}")


def probe_openai_tools_field(client):
    """探测1: 传 OpenAI 风格顶层 tools=[{type:function,...}], tool_choice=auto。"""
    res = client.send(
        prompt="北京今天天气怎么样? 用工具查询。",
        model="sider",
        overrides={
            "tools": [WEATHER_TOOL],
            "tool_choice": "auto",
        },
        max_seconds=60,
    )
    _summarize(res, "探测1: OpenAI 顶层 tools[] + tool_choice")
    return res


def probe_sider_native_tools(client):
    """探测2 (对照): sider 原生 tools.auto 字段 (已知支持 search/data_analysis)。"""
    res = client.send(
        prompt="搜索一下北京今天的天气",
        model="sider",
        tools={"auto": ["search", "data_analysis"]},
        max_seconds=60,
    )
    _summarize(res, "探测2 (对照): sider 原生 tools.auto")
    return res


def probe_functions_field(client):
    """探测3: 传旧版 OpenAI functions=[...] 字段 (functions/function_call)。"""
    res = client.send(
        prompt="上海现在几点? 用工具查。",
        model="sider",
        overrides={
            "functions": [WEATHER_TOOL["function"]],
            "function_call": "auto",
        },
        max_seconds=60,
    )
    _summarize(res, "探测3: 旧版 functions[] + function_call")
    return res


def probe_tool_in_tools_obj(client):
    """探测4: 把 function 塞进 sider tools 对象 (tools.functions 猜测形状)。"""
    res = client.send(
        prompt="深圳天气如何? 调用工具。",
        model="sider",
        tools={
            "auto": ["search", "data_analysis"],
            "functions": [WEATHER_TOOL["function"]],
        },
        max_seconds=60,
    )
    _summarize(res, "探测4: sider tools.functions 嵌套")
    return res


def main():
    ap = argparse.ArgumentParser(description="上游 Function Calling 能力探针")
    ap.add_argument("--min-interval", type=float, default=8.0, help="相邻请求最小间隔秒")
    args = ap.parse_args()

    token = load_token()
    if not token:
        print("[FATAL] 未找到 SIDER_AUTH_TOKEN")
        sys.exit(2)
    print(f"[OK] token loaded (len={len(token)}); min_interval={args.min_interval}s")

    client = UpstreamClient(token, timeout=60, min_interval=args.min_interval)

    results = {}
    results["openai_tools"] = probe_openai_tools_field(client)
    results["sider_native"] = probe_sider_native_tools(client)
    results["functions"] = probe_functions_field(client)
    results["tools_nested"] = probe_tool_in_tools_obj(client)

    # 结论汇总
    print(f"\n\n{'#'*60}")
    print("# Function Calling 能力结论")
    print(f"{'#'*60}")

    def verdict(res):
        # 出现 tool_call 事件且非 search/create_image 内置工具 = 可能支持 function calling
        has_tool_events = bool(res.tool_calls)
        return {
            "ok": res.ok, "error_code": res.error_code,
            "has_tool_events": has_tool_events,
            "event_types": list(res.event_types.keys()),
        }

    for name, res in results.items():
        v = verdict(res)
        print(f"\n[{name}]")
        print(f"  接受请求 (ok): {v['ok']}")
        print(f"  错误码: {v['error_code']}")
        print(f"  工具事件: {v['has_tool_events']}")
        print(f"  事件类型: {v['event_types']}")

    print(f"\n{'='*60}")
    print("判定: 若 openai_tools/functions 均无 tool_call 事件且仅返回普通文本,")
    print("      说明上游不支持标准 function calling 协议, 只支持原生 tools.auto。")
    print("      => deno_pro 应返回 not_supported 或降级为纯文本 (不 fake)。")


if __name__ == "__main__":
    main()
