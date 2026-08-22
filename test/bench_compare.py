"""sider2pro vs sider2claude Deno 部署实例 — 服务性能对比测评.

公平性设计:
- 两个服务都用 OpenAI 协议 /v1/chat/completions (两边都支持), 相同模型、相同 prompt。
- 会话管理各用各的机制 (s2pro: X-Session-ID/消息指纹; s2claude: 消息指纹), 都不手动传 session header。
- 每项测 3 次取样, 报告均值 ± 范围, 减少上游抖动影响。

测量维度:
1. 非流式: 端到端延迟 (总耗时)。
2. 流式: TTFT (首个内容块到达)、总耗时、输出字符数、块数、吞吐 (字符/秒)。
3. 对话记忆: 3 轮连续对话 (每轮带完整历史), 第 3 轮问第 1 轮的信息, 验证上下文保持。

注意: 消耗真实 sider 额度; s2claude 有混合路由 (sider + deepseek fallback), 若发生 fallback 会体现在后端。

用法 (anaconda python310, 仓库根):
    python test/bench_compare.py                      # 默认 claude-haiku-4.5
    python test/bench_compare.py --model gpt-5.5      # 换模型
    python test/bench_compare.py --rounds 3           # 取样次数
    python test/bench_compare.py --memory-only        # 只测对话记忆
"""
import argparse
import json
import os
import sys
import time

import requests

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001
    pass

S2P_URL = "https://sider2pro.asu.deno.net"
S2C_URL = "https://sider2claude.asu.deno.net"

# 凭证一律从环境/.env 读取, 不硬编码进代码库 (CLAUDE.md 约定: 代码库只用占位值)。
# - S2P_TOKEN: 读仓库根 .env 的 AUTH_TOKEN (sider2pro 的服务端 token), 也可用环境变量 S2P_TOKEN 覆盖。
# - S2C_TOKEN: 必须显式提供 (环境变量 S2C_TOKEN 或 --s2c-token), 因 sider2claude 的 token 不在本项目 .env 中。
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _load_env_token(key):
    """从仓库根 .env 读取指定 key 的值 (与 test/config.py 同口径)。"""
    env_path = os.path.join(_REPO_ROOT, ".env")
    if not os.path.exists(env_path):
        return None
    for line in open(env_path, encoding="utf-8"):
        line = line.strip()
        if line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        if k.strip() == key:
            return v.strip().strip('"').strip("'")


def resolve_tokens(s2c_token_arg=None):
    s2p = os.environ.get("S2P_TOKEN") or _load_env_token("AUTH_TOKEN")
    s2c = os.environ.get("S2C_TOKEN") or s2c_token_arg
    if not s2p:
        sys.exit("[FATAL] 未找到 sider2pro AUTH_TOKEN (仓库根 .env 或环境变量 S2P_TOKEN)")
    if not s2c:
        sys.exit("[FATAL] 未提供 sider2claude token: 环境变量 S2C_TOKEN 或 --s2c-token")
    return s2p, s2c

MEMORY_PROMPTS = [
    "记住我的代号是 AURORA-7。只回答：好的。",
    "继续。只回答：收到。",
    "我的代号是什么？只回答代号本身，不要解释。",
]


def make_session(base, token):
    s = requests.Session()
    s.headers.update({
        "Content-Type": "application/json",
        "Authorization": f"Bearer {token}",
    })
    return s


def chat_nonstream(sess, base, model, messages, timeout=90):
    t0 = time.perf_counter()
    r = sess.post(f"{base}/v1/chat/completions", json={
        "model": model, "stream": False, "messages": messages,
    }, timeout=(15, timeout))
    dt = time.perf_counter() - t0
    body = r.json() if r.status_code == 200 else {"_err": r.text[:200]}
    content = ""
    if r.status_code == 200:
        try:
            content = body["choices"][0]["message"].get("content") or ""
        except Exception:  # noqa: BLE001
            pass
    return {"http": r.status_code, "ms": round(dt * 1000), "chars": len(content),
            "content": content}


def chat_stream(sess, base, model, messages, timeout=120):
    t0 = time.perf_counter()
    r = sess.post(f"{base}/v1/chat/completions", json={
        "model": model, "stream": True, "messages": messages,
    }, timeout=(15, timeout), stream=True)
    if r.status_code != 200:
        return {"http": r.status_code, "err": r.text[:200]}
    ttft = None
    chunks = 0
    pieces = []
    r.encoding = "utf-8"
    for raw in r.iter_lines(decode_unicode=True):
        if not raw:
            continue
        line = raw.strip()
        if not line.startswith("data:"):
            continue
        payload = line[5:].strip()
        if payload == "[DONE]":
            break
        try:
            obj = json.loads(payload)
        except json.JSONDecodeError:
            continue
        delta = None
        try:
            delta = obj["choices"][0]["delta"].get("content")
        except Exception:  # noqa: BLE001
            pass
        if delta:
            if ttft is None:
                ttft = time.perf_counter() - t0
            pieces.append(delta)
            chunks += 1
    total = time.perf_counter() - t0
    content = "".join(pieces)
    cps = None
    if ttft is not None and total > ttft:
        cps = round(len(content) / (total - ttft), 1)
    return {
        "http": 200, "ms": round(total * 1000),
        "ttft_ms": round(ttft * 1000) if ttft is not None else None,
        "chars": len(content), "chunks": chunks,
        "cps": cps, "content": content,
    }


def memory_probe(sess, base, model):
    """3 轮对话, 每轮带完整历史, 验证跨轮记忆。"""
    history = []
    rounds = []
    for i, p in enumerate(MEMORY_PROMPTS):
        history.append({"role": "user", "content": p})
        r = chat_nonstream(sess, base, model, history)
        r["round"] = i + 1
        r["prompt"] = p
        rounds.append(r)
        if r["http"] == 200:
            history.append({"role": "assistant", "content": r["content"]})
        else:
            break
    # 判定: 第 3 轮回答是否包含代号 AURORA-7
    last = rounds[-1] if rounds else {}
    remembered = ("AURORA-7" in last.get("content", "")) if last.get("http") == 200 else False
    return {"rounds": rounds, "remembered": remembered}


def avg(vals):
    vals = [v for v in vals if v is not None]
    return round(sum(vals) / len(vals)) if vals else None


def fmt_ms(v):
    return f"{v}ms" if v is not None else "-"


def run_bench(model, rounds, memory_only, s2p_token, s2c_token):
    s2p = make_session(S2P_URL, s2p_token)
    s2c = make_session(S2C_URL, s2c_token)
    print(f"[OK] 对比: {S2P_URL} (sider2pro) vs {S2C_URL} (sider2claude)")
    print(f"[INFO] 模型: {model}, 取样次数: {rounds}\n")

    if memory_only:
        print("=" * 70)
        print("对话记忆对比 (3 轮连续对话)")
        print("=" * 70)
        for label, sess, url in (("sider2pro", s2p, S2P_URL), ("sider2claude", s2c, S2C_URL)):
            res = memory_probe(sess, url, model)
            print(f"\n--- {label} ---")
            for rd in res["rounds"]:
                mem = "✅" if rd["http"] == 200 else "❌"
                print(f"  第{rd['round']}轮 {mem} HTTP {rd['http']} {rd['ms']}ms  "
                      f"{rd['prompt'][:18]}...  => {rd['content'][:60]!r}")
            print(f"  记忆判定: {'✅ 记得代号 AURORA-7' if res['remembered'] else '❌ 未记住'}")
        return

    print("=" * 70)
    print(f"1. 非流式对比 (stream=false, {rounds} 次取样)")
    print("=" * 70)
    for label, sess in (("sider2pro", s2p), ("sider2claude", s2c)):
        results = []
        for _ in range(rounds):
            r = chat_nonstream(sess, S2P_URL if label == "sider2pro" else S2C_URL,
                               model, [{"role": "user", "content": "用三句话介绍什么是 Deno KV"}])
            results.append(r)
        ms = [r["ms"] for r in results if r["http"] == 200]
        chars = [r["chars"] for r in results if r["http"] == 200]
        ok = sum(1 for r in results if r["http"] == 200)
        print(f"  {label:14} 成功率 {ok}/{rounds}  延迟均值 {fmt_ms(avg(ms))}  "
              f"(范围 {fmt_ms(min(ms))}-{fmt_ms(max(ms))})  输出字符均值 {avg(chars) or 0}")

    print()
    print("=" * 70)
    print(f"2. 流式对比 (stream=true, {rounds} 次取样)")
    print("=" * 70)
    for label, sess, url in (("sider2pro", s2p, S2P_URL), ("sider2claude", s2c, S2C_URL)):
        results = []
        for _ in range(rounds):
            r = chat_stream(sess, url, model,
                            [{"role": "user", "content": "用三句话介绍什么是 Deno KV"}])
            results.append(r)
        ok = [r for r in results if r["http"] == 200]
        ttft = avg([r["ttft_ms"] for r in ok])
        ms = avg([r["ms"] for r in ok])
        chars = avg([r["chars"] for r in ok])
        cps = avg([r["cps"] for r in ok])
        chunks = avg([r["chunks"] for r in ok])
        print(f"  {label:14} 成功率 {len(ok)}/{rounds}  TTFT {fmt_ms(ttft)}  "
              f"总耗时 {fmt_ms(ms)}  字符 {chars or 0}  块数 {chunks or 0}  吞吐 {cps or 0} 字符/s")

    print()
    print("=" * 70)
    print("3. 对话记忆对比 (3 轮连续对话, 每轮带完整历史)")
    print("=" * 70)
    for label, sess, url in (("sider2pro", s2p, S2P_URL), ("sider2claude", s2c, S2C_URL)):
        res = memory_probe(sess, url, model)
        print(f"\n  --- {label} ---")
        for rd in res["rounds"]:
            mem = "✅" if rd["http"] == 200 else "❌"
            print(f"    第{rd['round']}轮 {mem} HTTP {rd['http']} {rd['ms']}ms  "
                  f"=> {rd['content'][:50]!r}")
        print(f"    记忆判定: {'✅ 记得代号 AURORA-7' if res['remembered'] else '❌ 未记住'}")


def run_multi(models, rounds, s2p_token, s2c_token):
    """多模型批量对比: 每个模型跑非流式+流式+记忆, 汇总成表格。"""
    s2p = make_session(S2P_URL, s2p_token)
    s2c = make_session(S2C_URL, s2c_token)
    print(f"[OK] 多模型对比: {S2P_URL} (sider2pro) vs {S2C_URL} (sider2claude)")
    print(f"[INFO] 模型: {models}, 每项取样 {rounds} 次\n")

    # 表头
    hdr = (f"{'模型':<22} {'服务':<6} {'非流式ms':>10} {'TTFT ms':>8} {'流式总ms':>9} "
           f"{'字符':>5} {'吞吐c/s':>8} {'记忆':>4}")
    print(hdr)
    print("-" * len(hdr))

    for model in models:
        for label, sess, url in (("s2pro", s2p, S2P_URL), ("s2claude", s2c, S2C_URL)):
            # 非流式
            ns = [chat_nonstream(sess, url, model,
                                 [{"role": "user", "content": "用三句话介绍什么是 Deno KV"}])
                  for _ in range(rounds)]
            ns_ok = [r for r in ns if r["http"] == 200]
            ns_ms = avg([r["ms"] for r in ns_ok])
            # 流式
            st = [chat_stream(sess, url, model,
                              [{"role": "user", "content": "用三句话介绍什么是 Deno KV"}])
                  for _ in range(rounds)]
            st_ok = [r for r in st if r["http"] == 200]
            ttft = avg([r["ttft_ms"] for r in st_ok])
            st_ms = avg([r["ms"] for r in st_ok])
            chars = avg([r["chars"] for r in st_ok])
            cps = avg([r["cps"] for r in st_ok])
            # 记忆
            mem = memory_probe(sess, url, model)
            mem_flag = "✅" if mem["remembered"] else "❌"
            ns_ok_n = len(ns_ok)
            st_ok_n = len(st_ok)
            print(f"{model:<22} {label:<6} {fmt_ms(ns_ms):>10} {fmt_ms(ttft):>8} "
                  f"{fmt_ms(st_ms):>9} {chars or 0:>5} {cps or 0:>8} {mem_flag:>4}  "
                  f"(ns {ns_ok_n}/{rounds}, st {st_ok_n}/{rounds})")
        print()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=None, help="单个模型 (与 --models 互斥)")
    ap.add_argument("--models", default=None, help="逗号分隔多模型")
    ap.add_argument("--rounds", type=int, default=3)
    ap.add_argument("--memory-only", action="store_true")
    ap.add_argument("--s2c-token", default=None, help="sider2claude 的 AUTH_TOKEN (或用环境变量 S2C_TOKEN)")
    args = ap.parse_args()

    s2p_token, s2c_token = resolve_tokens(args.s2c_token)

    if args.models:
        models = [m.strip() for m in args.models.split(",") if m.strip()]
    elif args.model:
        models = [args.model]
    else:
        models = ["claude-haiku-4.5"]

    if args.memory_only:
        run_bench(models[0], args.rounds, True, s2p_token, s2c_token)
    elif len(models) > 1:
        run_multi(models, args.rounds, s2p_token, s2c_token)
    else:
        run_bench(models[0], args.rounds, False, s2p_token, s2c_token)
