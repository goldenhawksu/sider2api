"""跨模型图像生成能力探针 (probe-first, 经被测 deno 实例间接测试).

探测: 哪些模型能可靠地生成图像?
两条触发路径是独立的:
  - 对话触发 (默认): 发"画图"对话请求, 模型自主决定是否调用 create_image 工具。
  - 专用端点 (--endpoint): POST /v1/images/generations, 硬触发上游 tools.image。

对话触发可靠性取决于模型自主调用工具的倾向; 专用端点近乎全模型可用。

注意: 经 deno 实例 (本地/生产) 间接测试, 符合 CLAUDE.md "优先间接测试" 铁律;
     消耗真实 sider 额度, 图像生成较慢 (~8-20s/次)。
用法 (anaconda python310, 仓库根):
    python test/probe_image_models.py                                  # 对话触发, 代表模型子集
    python test/probe_image_models.py --models gpt-5.5,sider           # 指定模型
    python test/probe_image_models.py --attempts 3                     # 每模型尝试次数
    python test/probe_image_models.py --endpoint --models sider,gpt-5.5 # 专用端点模式
    python test/probe_image_models.py --all                            # 全部 live 模型 (耗时长)
"""
import argparse
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

# 画图提示词 (与 test_image.py 一致, 强触发图像工具)
IMAGE_PROMPT = "请画一只可爱的橘猫"
ENDPOINT_PROMPT = "a cute orange cat sitting on a wooden table"

# 默认代表模型子集 (覆盖各大模型家族; 含 -think 观察 think 模式对出图的影响)
DEFAULT_MODELS = [
    "gpt-4.1",
    "gpt-5",
    "gpt-5.5",
    "gpt-5.5-think",
    "claude-opus-4.8",
    "claude-sonnet-5",
    "claude-haiku-4.5",
    "gemini-2.5-pro",
    "gemini-3.5-flash",
    "deepseek-v4-pro",
    "grok-4",
    "glm-5",
    "qwen3.8-max",
    "kimi-k3",
    "llama-3.1-405b",
    "sider",
]

# 请求间隔 (秒): 经 deno 实例但图像请求较重, 留间隔避免上游并发限制
BETWEEN_S = 2.0


def _chat_got_image(resp) -> bool:
    """判断一次对话响应是否返回图片 (专用字段 image_urls 或 Markdown 图片链接)。"""
    if resp.status_code != 200:
        return False
    try:
        body = resp.json()
    except Exception:  # noqa: BLE001
        return False
    msg = body.get("choices", [{}])[0].get("message", {})
    if msg.get("image_urls"):
        return True
    content = msg.get("content") or ""
    return ("![" in content) and (".png" in content or ".jpg" in content)


def _endpoint_got_image(resp) -> bool:
    """判断专用端点响应是否返回图片 URL。"""
    if resp.status_code != 200:
        return False
    try:
        data = resp.json().get("data", [])
        return bool(data and str(data[0].get("url", "")).startswith("http"))
    except Exception:  # noqa: BLE001
        return False


def probe_chat(client, model, attempts):
    """对话触发: 发 attempts 次画图请求, 返回 (成功次数, 明细)。"""
    ok, results = 0, []
    for i in range(attempts):
        t0 = time.perf_counter()
        try:
            resp = client.chat(model, [{"role": "user", "content": IMAGE_PROMPT}], stream=False)
        except Exception as e:  # noqa: BLE001
            results.append({"try": i + 1, "ok": False, "detail": f"transport: {e}"})
            continue
        dt = round(time.perf_counter() - t0, 1)
        got = _chat_got_image(resp)
        if got:
            ok += 1
            results.append({"try": i + 1, "ok": True, "detail": "图片链接", "ms": dt})
        elif resp.status_code == 200:
            body = resp.json()
            detail = f"纯文本({len(extract_content(body))}字)"
            results.append({"try": i + 1, "ok": False, "detail": detail, "ms": dt})
        else:
            results.append({"try": i + 1, "ok": False,
                            "detail": f"HTTP {resp.status_code}: {resp.text[:120]}", "ms": dt})
        if i < attempts - 1:
            time.sleep(BETWEEN_S)
    return ok, results


def probe_endpoint(client, model, attempts):
    """专用端点: 发 attempts 次, 返回 (成功次数, 明细)。"""
    ok, results = 0, []
    for i in range(attempts):
        t0 = time.perf_counter()
        try:
            resp = client.image_raw({"prompt": ENDPOINT_PROMPT, "model": model, "n": 1, "size": "1024x1024"})
        except Exception as e:  # noqa: BLE001
            results.append({"try": i + 1, "ok": False, "detail": f"transport: {e}"})
            continue
        dt = round(time.perf_counter() - t0, 1)
        got = _endpoint_got_image(resp)
        if got:
            ok += 1
            url = resp.json().get("data", [{}])[0].get("url", "")[:80]
            results.append({"try": i + 1, "ok": True, "detail": f"出图 {url}", "ms": dt})
        elif resp.status_code == 200:
            results.append({"try": i + 1, "ok": False, "detail": "无 url", "ms": dt})
        else:
            results.append({"try": i + 1, "ok": False,
                            "detail": f"HTTP {resp.status_code}: {resp.text[:120]}", "ms": dt})
        if i < attempts - 1:
            time.sleep(BETWEEN_S)
    return ok, results


def main():
    ap = argparse.ArgumentParser(description="跨模型图像生成能力探针")
    ap.add_argument("--models", default=None, help="逗号分隔模型清单, 覆盖默认子集")
    ap.add_argument("--attempts", type=int, default=2, help="每模型尝试次数 (默认 2)")
    ap.add_argument("--endpoint", action="store_true", help="用专用 /v1/images/generations 端点")
    ap.add_argument("--all", action="store_true", help="全部 live 模型 (耗时长)")
    args = ap.parse_args()

    base = config.DEFAULT_BASE_URL
    token = config.DEFAULT_TOKEN
    client = ApiClient(base, token, read_timeout=120)

    if args.models:
        models = [m.strip() for m in args.models.split(",") if m.strip()]
    elif args.all:
        models = client.list_model_ids()
    else:
        live = set(client.list_model_ids())
        models = [m for m in DEFAULT_MODELS if m in live]

    mode = "专用端点 /v1/images/generations" if args.endpoint else "对话触发 (模型自主调用工具)"
    print(f"[OK] 目标实例: {base}")
    print(f"[INFO] 模式: {mode}")
    print(f"[INFO] 测试模型 ({len(models)}): {models}")
    print(f"[INFO] 每模型尝试 {args.attempts} 次\n")

    rows = []
    for model in models:
        if args.endpoint:
            ok, results = probe_endpoint(client, model, args.attempts)
        else:
            ok, results = probe_chat(client, model, args.attempts)
        rows.append({"model": model, "ok": ok, "attempts": args.attempts, "results": results})
        flag = "✅ 可靠" if ok == args.attempts else ("🟡 不稳定" if ok > 0 else "⛔ 不出图")
        print(f"  [{flag}] {model:24} 成功 {ok}/{args.attempts}")
        for r in results:
            extra = f" ({r.get('ms')}s)" if "ms" in r else ""
            print(f"      try{r['try']}: {'✅' if r['ok'] else '❌'} {r['detail']}{extra}")
        time.sleep(1.0)

    print(f"\n{'#' * 60}\n# 图像生成能力汇总 ({mode})\n{'#' * 60}")
    reliable = [r["model"] for r in rows if r["ok"] == r["attempts"] and r["attempts"] > 0]
    unreliable = [r["model"] for r in rows if 0 < r["ok"] < r["attempts"]]
    none = [r["model"] for r in rows if r["ok"] == 0]
    print(f"\n✅ 可靠 (全部尝试成功): {reliable or '(无)'}")
    print(f"🟡 不稳定 (部分成功):   {unreliable or '(无)'}")
    print(f"⛔ 不出图 (全失败):     {none or '(无)'}")
    print(f"\n说明: {'专用端点硬触发上游 tools.image, 出图确定性高;' if args.endpoint else '对话触发依赖模型自主调用 create_image, 可靠性因模型而异;'}")
    print("      1135 = 上游用量限制 (非能力缺失); 失败时请区分错误码。")


if __name__ == "__main__":
    main()
