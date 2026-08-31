#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""分批集成回归: 在【限速门开启】的实例上跑完整回归而不产生假失败。

背景: 实例对每个模型限速「60s 内最多 6 次」。而 `pytest -m "not perf"` 会在
同一窗口内对 gpt-5.5 / sider 连打远超 6 次, 导致大量 429 假失败 —— 实测首轮
13 个失败全部是限速误伤, 分批重跑后 13/13 通过。

本脚本按测试文件分批, 在消耗额度的批次之间等待限速窗口重置。零额度批次
(纯契约/mock) 连续跑, 不浪费时间。

用法 (仓库根, anaconda python310):
    python scripts/run_regression_batched.py                        # 打 .env 的 BASE_URL
    python scripts/run_regression_batched.py --base-url http://localhost:8011
    python scripts/run_regression_batched.py --gap 70               # 自定义批次间隔
    python scripts/run_regression_batched.py --dry-run              # 只打印批次计划

退出码: 0 = 全部通过; 1 = 有失败; 2 = 上游额度耗尽(测评无效, 需等额度恢复)。
"""
import argparse
import os
import re
import subprocess
import sys
import time

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 零额度批次: 契约/结构/mock/鉴权拒绝路径, 不打上游, 可连续跑
FREE_BATCHES = [
    "test/test_meta.py",
    "test/test_deno_pro_mock_regression.py",
    "test/test_errors.py",
]

# 消耗额度的批次: 每个文件内同模型调用已 <= 6 次, 批次之间等窗口重置
COST_BATCHES = [
    "test/test_sdk_auth.py",
    "test/test_chat.py",
    "test/test_multiturn.py",
    "test/test_think.py",
    "test/test_image.py",
    "test/test_anthropic_format.py",
    "test/test_gemini_format.py",
    "test/test_openai_responses.py",
    "test/test_tools.py",
    "test/test_vision.py",
    "test/test_stream_contract.py",
    "test/test_stats.py",
    "test/test_rate_limit.py",  # 测限速本身, 必须在限速开启的实例上跑
]

# 上游额度耗尽的特征 (sider 业务码 1135), 与本地限速 429 区分开。
# 注意: 1135 是【模型级】的 —— 旗舰模型 (如 claude-opus-4.8) 额度稀缺, 单个模型耗尽
# 不代表整个账号不可用。故不一次中止, 只有连续多批都撞上才判定为账号级耗尽。
QUOTA_EXHAUSTED = re.compile(r"reached the current usage limit|upstream_code[\"']?:\s*1135")
LOCAL_RATE_LIMIT = re.compile(r"model_rate_limited")
# 连续多少个批次出现 1135 就认定账号级耗尽并中止
QUOTA_ABORT_STREAK = 3

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001
    pass


def run_batch(paths, base_url, token, extra_args):
    cmd = [sys.executable, "-m", "pytest", *paths, "-m", "not perf", "-q", "--tb=line"]
    if base_url:
        cmd += ["--base-url", base_url]
    if token:
        cmd += ["--token", token]
    cmd += extra_args
    env = dict(os.environ, PYTHONIOENCODING="utf-8")
    p = subprocess.run(cmd, cwd=REPO_ROOT, env=env, capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    return p.returncode, (p.stdout or "") + (p.stderr or "")


def summarize(out):
    """从 pytest 输出末行提取 passed/failed/skipped 计数。"""
    m = {k: 0 for k in ("passed", "failed", "skipped")}
    for key in m:
        hit = re.search(rf"(\d+) {key}", out)
        if hit:
            m[key] = int(hit.group(1))
    return m


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", default=None)
    ap.add_argument("--token", default=None)
    ap.add_argument("--gap", type=float, default=65.0, help="耗额度批次之间的等待秒数")
    ap.add_argument("--dry-run", action="store_true")
    args, extra = ap.parse_known_args()

    batches = [(p, False) for p in FREE_BATCHES] + [(p, True) for p in COST_BATCHES]
    print(f"分批回归: {len(FREE_BATCHES)} 个零额度批次 + {len(COST_BATCHES)} 个耗额度批次"
          f" (间隔 {args.gap}s)\n")
    if args.dry_run:
        for path, cost in batches:
            print(f"  [{'额度' if cost else '免费'}] {path}")
        return 0

    total = {"passed": 0, "failed": 0, "skipped": 0}
    failed_batches, quota_batches, t_start = [], [], time.time()
    quota_streak = 0

    for i, (path, cost) in enumerate(batches):
        if cost and i > 0:
            print(f"  … 等待限速窗口 {args.gap:.0f}s")
            time.sleep(args.gap)

        print(f"[{i+1}/{len(batches)}] {path}", flush=True)
        rc, out = run_batch([path], args.base_url, args.token, extra)
        counts = summarize(out)
        for k in total:
            total[k] += counts[k]

        hit_quota = bool(QUOTA_EXHAUSTED.search(out))
        quota_streak = quota_streak + 1 if hit_quota else 0
        if hit_quota:
            quota_batches.append(path)
        if quota_streak >= QUOTA_ABORT_STREAK:
            print(f"\n[ABORT] 连续 {QUOTA_ABORT_STREAK} 个批次撞上 upstream_code 1135, "
                  "判定为账号级额度耗尽。")
            print("        本轮结果无效 —— 失败并非代码缺陷。请等额度恢复后重跑。")
            print(f"        已完成 {i+1}/{len(batches)} 批, 累计 {total}")
            return 2

        status = "OK " if rc == 0 else "FAIL"
        note = ""
        if hit_quota:
            note = "  ⚠ 含上游额度受限(1135), 该类失败非代码缺陷"
        elif LOCAL_RATE_LIMIT.search(out):
            note = "  ⚠ 仍有 model_rate_limited, 该批次内同模型调用可能超过 6 次"
        print(f"       {status} passed={counts['passed']} failed={counts['failed']} "
              f"skipped={counts['skipped']}{note}")
        if rc != 0:
            failed_batches.append(path)
            for line in out.splitlines():
                if line.startswith("FAILED"):
                    print(f"         {line}")

    mins = (time.time() - t_start) / 60
    print(f"\n{'='*70}")
    print(f"合计: passed={total['passed']} failed={total['failed']} "
          f"skipped={total['skipped']}  用时 {mins:.1f} 分钟")
    if quota_batches:
        print(f"上游额度受限批次(非代码缺陷): {', '.join(quota_batches)}")
    if failed_batches:
        print(f"失败批次: {', '.join(failed_batches)}")
        # 失败全部来自额度受限的批次时, 退出码 2 (结果不完整) 而非 1 (真实失败)
        return 2 if set(failed_batches) <= set(quota_batches) else 1
    print("全部通过 ✅")
    return 0


if __name__ == "__main__":
    sys.exit(main())
