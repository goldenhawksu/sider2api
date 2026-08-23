"""sider2pro 生产端点综合能力探针 (probe-first, 经被测 deno 实例间接测试).

对 https://sider2pro.asu.deno.net 做系统能力探测, 产出"所有模型的能力极限报告"。

覆盖维度:
  1. 模型可用性矩阵: 全部 59 模型, 每模型 1 次最小文本请求 (可用/失败/回退)。
  2. 上下文窗口: 代表模型 (各家族取 1) 发递增长度 prompt, 找最大可处理上下文。
  3. 工具能力: 触发 search / data_analysis, 记录各模型工具调用情况。
  4. 图像识别: 发图像输入, 验证能力门控返回 not_supported (上游不支持视觉)。
  5. 图像生成: 对话触发 + 专用端点, 记录各模型出图能力。

用法 (anaconda python310, 仓库根; BASE_URL 默认指向生产):
    python test/probe_capabilities.py --stage availability    # 模型可用性 (59 次)
    python test/probe_capabilities.py --stage context         # 上下文窗口 (代表模型)
    python test/probe_capabilities.py --stage tools           # 工具能力 (代表模型)
    python test/probe_capabilities.py --stage vision          # 图像识别门控
    python test/probe_capabilities.py --stage image           # 图像生成 (专用端点, 全量)
    python test/probe_capabilities.py --all                   # 全部阶段

注意: 经 deno 实例间接测试 (CLAUDE.md 铁律); 消耗真实 sider 额度。
"""
import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import config
from helpers import ApiClient, extract_content

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001
    pass

# 请求间隔 (秒): 经 deno 实例但避免上游并发限制
BETWEEN_S = 1.5

# 各模型家族代表 (上下文/工具深度探测用)
REPRESENTATIVES = [
    "gpt-5.5", "gpt-4.1", "gpt-5",
    "claude-opus-4.8", "claude-sonnet-5", "claude-haiku-4.5",
    "gemini-2.5-pro", "gemini-3.5-flash",
    "deepseek-v4-pro", "grok-4", "glm-5", "qwen3.8-max", "kimi-k3",
    "llama-3.1-405b", "sider",
]

# 上下文窗口探测: 递增的 prompt 长度 (字符数)
CONTEXT_STEPS = [500, 2000, 8000, 16000, 32000, 48000]


def probe_availability(client):
    """全部模型可用性矩阵: 每模型 1 次最小请求。"""
    models = client.list_model_ids()
    print(f"\n{'='*64}\n[1/5] 模型可用性矩阵 ({len(models)} 模型)\n{'='*64}")
    rows = []
    for m in models:
        t0 = time.perf_counter()
        try:
            r = client.chat(m, [{"role": "user", "content": "只回复:OK"}], stream=False)
            dt = round(time.perf_counter() - t0, 1)
            if r.status_code == 200:
                body = r.json()
                content = extract_content(body)
                ok = bool(content.strip())
                echo = body.get("model", "")
                fb = echo and echo != m and echo != "sider" and m != "sider"
                rows.append({"model": m, "ok": ok, "echo": echo, "fb": fb, "ms": dt, "chars": len(content)})
            else:
                rows.append({"model": m, "ok": False, "echo": "", "fb": False,
                             "ms": dt, "err": f"HTTP{r.status_code}:{r.text[:80]}"})
        except Exception as e:  # noqa: BLE001
            rows.append({"model": m, "ok": False, "echo": "", "fb": False, "err": str(e)[:80]})
        time.sleep(BETWEEN_S)
    # 输出
    usable = [r for r in rows if r["ok"]]
    fail = [r for r in rows if not r["ok"]]
    fb = [r for r in rows if r.get("fb")]
    print(f"可用 {len(usable)}/{len(rows)}; 失败 {len(fail)}; 疑似回退 {len(fb)}")
    print(f"\n{'模型':<26}{'可用':<6}{'回显':<14}{'耗时':<8}{'字符':<6}备注")
    for r in rows:
        mark = "✅" if r["ok"] else "❌"
        echo = r.get("echo", "") or "-"
        note = "fallback" if r.get("fb") else (r.get("err", "")[:40] if not r["ok"] else "")
        print(f"  {mark} {r['model']:<24}{'是' if r['ok'] else '否':<6}{echo:<14}"
              f"{r.get('ms',0):<8}{r.get('chars',0):<6}{note}")
    return {"usable": [r["model"] for r in usable], "fail": [r["model"] for r in fail],
            "fallback": [r["model"] for r in fb]}


def probe_context(client):
    """代表模型上下文窗口: 递增 prompt 长度, 找最大可处理值。"""
    print(f"\n{'='*64}\n[2/5] 上下文窗口探测 (代表模型)\n{'='*64}")
    results = {}
    for m in REPRESENTATIVES:
        row = {}
        print(f"\n--- {m} ---")
        for n in CONTEXT_STEPS:
            prompt = "请只回复：收到。" + ("内容填充。" * (n // 4))  # 约 n 字符
            try:
                r = client.chat(m, [{"role": "user", "content": prompt}], stream=False)
                if r.status_code == 200:
                    ok = bool(extract_content(r.json()).strip())
                    row[str(n)] = "ok" if ok else "empty"
                    print(f"  {n:>6} 字符: ✅")
                else:
                    code = r.json().get("error", {}).get("code", r.status_code)
                    row[str(n)] = f"err:{code}"
                    print(f"  {n:>6} 字符: ❌ {r.text[:60]}")
            except Exception as e:  # noqa: BLE001
                row[str(n)] = f"transport:{str(e)[:40]}"
                print(f"  {n:>6} 字符: ⚠️ {str(e)[:40]}")
            time.sleep(BETWEEN_S)
        results[m] = row
    return results


def probe_tools(client):
    """代表模型工具能力: 触发 search / data_analysis。"""
    print(f"\n{'='*64}\n[3/5] 工具能力探测 (代表模型)\n{'='*64}")
    results = {}
    for m in REPRESENTATIVES:
        print(f"\n--- {m} ---")
        r = client.chat(m, [{"role": "user", "content": "请搜索2026年AI领域最新进展, 并计算 1234*5678"}],
                        stream=False)
        body = r.json() if r.status_code == 200 else {}
        msg = body.get("choices", [{}])[0].get("message", {}) if body else {}
        content = msg.get("content", "") or ""
        # deno 对工具降级的标记: warning.tools_not_supported
        warn = body.get("warning", {}).get("type", "") if body else ""
        has_link = "http" in content
        results[m] = {"http": r.status_code, "chars": len(content), "has_link": has_link,
                      "warning": warn}
        mark = "✅" if r.status_code == 200 else "❌"
        print(f"  {mark} HTTP{r.status_code} 字符={len(content)} 含链接={has_link} 降级警告={warn or '无'}")
        time.sleep(BETWEEN_S)
    return results


def probe_vision(client):
    """图像识别: 验证能力门控 (上游不支持视觉, 返回 not_supported)。"""
    print(f"\n{'='*64}\n[4/5] 图像识别门控验证\n{'='*64}")
    r = client.chat("gpt-5.5", [{"role": "user", "content": [
        {"type": "text", "text": "这是什么?"},
        {"type": "image_url", "image_url": {"url": "https://upload.wikimedia.org/wikipedia/commons/thumb/3/3a/Cat03.jpg/240px-Cat03.jpg"}},
    ]}], stream=False)
    print(f"  OpenAI chat 图像输入 -> HTTP {r.status_code}: {r.text[:150]}")
    return {"openai_chat": r.status_code, "body": r.text[:200]}


def probe_image(client):
    """图像生成: 专用端点全量探测。"""
    print(f"\n{'='*64}\n[5/5] 图像生成探测 (专用端点, 全量模型)\n{'='*64}")
    models = client.list_model_ids()
    rows = []
    for m in models:
        try:
            r = client.image_raw({"prompt": "a cute orange cat sitting on a wooden table",
                                  "model": m, "n": 1, "size": "1024x1024"})
            if r.status_code == 200:
                data = r.json().get("data", [])
                url = data[0].get("url", "") if data else ""
                ok = bool(url.startswith("http"))
                rows.append({"model": m, "ok": ok, "ms": None})
                print(f"  {'✅' if ok else '❌'} {m:<24} 出图={ok}")
            else:
                err = r.json().get("error", {}).get("message", "") if r.headers.get("content-type","").startswith("application/json") else r.text[:80]
                code = "?"
                rows.append({"model": m, "ok": False, "err": err[:60]})
                print(f"  ❌ {m:<24} HTTP{r.status_code}: {err[:60]}")
        except Exception as e:  # noqa: BLE001
            rows.append({"model": m, "ok": False, "err": str(e)[:60]})
            print(f"  ❌ {m:<24} {str(e)[:60]}")
        time.sleep(BETWEEN_S)
    ok = [r["model"] for r in rows if r["ok"]]
    fail = [r["model"] for r in rows if not r["ok"]]
    print(f"\n✅ 出图 ({len(ok)}): {', '.join(ok)}")
    print(f"❌ 失败 ({len(fail)}): {', '.join(fail)}")
    return {"ok": ok, "fail": fail}


STAGES = {
    "availability": probe_availability,
    "context": probe_context,
    "tools": probe_tools,
    "vision": probe_vision,
    "image": probe_image,
}


def main():
    ap = argparse.ArgumentParser(description="sider2pro 生产端点综合能力探针")
    ap.add_argument("--stage", choices=list(STAGES) + ["all"], default="all")
    args = ap.parse_args()

    base = config.DEFAULT_BASE_URL
    token = config.DEFAULT_TOKEN
    client = ApiClient(base, token, read_timeout=120)
    print(f"[OK] 目标实例: {base}")

    if args.stage == "all":
        stages = list(STAGES)
    else:
        stages = [args.stage]

    report = {}
    for s in stages:
        report[s] = STAGES[s](client)

    # 汇总
    ts = time.strftime("%Y%m%d_%H%M%S")
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "reports",
                        f"capabilities_{ts}.json")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2, default=str)
    print(f"\n📄 报告已保存: {path}")


if __name__ == "__main__":
    main()
