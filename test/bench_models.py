"""多模型性能横评: 对各系列代表模型逐个测流式 TTFT / 吞吐 / 总耗时。

串行执行(不同模型限速独立, 但串行避免相互干扰性能读数)。
运行: python test/bench_models.py   (读 .env 的 BASE_URL / AUTH_TOKEN)
"""
import json
import os
import statistics
import sys
import time

import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import config  # noqa: E402

BASE = config.DEFAULT_BASE_URL.rstrip("/")
TOKEN = config.DEFAULT_TOKEN
PROMPT = "用中文写一段大约200字的短文, 介绍杭州西湖的四季景色。直接输出正文。"

MODELS = [
    "gpt-4.1", "gpt-5.5", "gpt-5.6-sol",
    "claude-opus-4.5", "claude-sonnet-5", "claude-haiku-4.5",
    "gemini-2.5-flash", "gemini-3.7-flash",
    "deepseek-v4-pro", "grok-4", "glm-5", "qwen3.8-max", "kimi-k3",
    "llama-3.1-405b", "sider",
]


def bench(model):
    """发一次流式请求, 返回 (ttft, total, chars, chunks) 或抛异常。"""
    t0 = time.time()
    r = requests.post(
        f"{BASE}/v1/chat/completions",
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
        json={"model": model, "messages": [{"role": "user", "content": PROMPT}], "stream": True},
        stream=True, timeout=(15, 180),
    )
    if r.status_code != 200:
        raise RuntimeError(f"HTTP {r.status_code}: {r.text[:120]}")
    ttft, chars, chunks = None, 0, 0
    for line in r.iter_lines(decode_unicode=True):
        if not line or not line.startswith("data: "):
            continue
        payload = line[6:]
        if payload == "[DONE]":
            break
        try:
            delta = json.loads(payload)["choices"][0].get("delta", {})
        except Exception:  # noqa: BLE001
            continue
        piece = delta.get("content") or ""
        if piece:
            if ttft is None:
                ttft = time.time() - t0
            chars += len(piece)
            chunks += 1
    return ttft, time.time() - t0, chars, chunks


if __name__ == "__main__":
    print(f"被测实例: {BASE}\nprompt: {PROMPT}\n")
    rows = []
    for m in MODELS:
        try:
            ttft, total, chars, chunks = bench(m)
            cps = round(chars / total, 1) if total else 0
            rows.append((m, round(ttft, 2) if ttft else None, round(total, 2), chars, chunks, cps))
            print(f"{m:<20} ttft={ttft and round(ttft,2)!s:<7} total={total:.2f}s "
                  f"chars={chars:<5} chunks={chunks:<4} cps={cps}")
        except Exception as e:  # noqa: BLE001
            rows.append((m, None, None, 0, 0, f"ERR: {type(e).__name__}"))
            print(f"{m:<20} FAILED  {type(e).__name__}: {e}"[:160])
        time.sleep(3)

    ok = [r for r in rows if r[1] is not None]
    print("\n| 模型 | TTFT(s) | 总耗时(s) | 字符 | 块数 | 字符/秒 |")
    print("|---|---|---|---|---|---|")
    for m, ttft, total, chars, chunks, cps in rows:
        print(f"| {m} | {ttft or '-'} | {total or '-'} | {chars} | {chunks} | {cps} |")
    if ok:
        print(f"\n成功 {len(ok)}/{len(rows)}  "
              f"TTFT 中位数={statistics.median(r[1] for r in ok):.2f}s  "
              f"吞吐中位数={statistics.median(r[5] for r in ok):.1f} 字符/秒")
