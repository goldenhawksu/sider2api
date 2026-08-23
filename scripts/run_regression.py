#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
sider2api 推送门禁 · 集成回归测试运行器。

在推送 main 触发生产部署前, 用【当前工作区代码】起一个本地临时 deno 实例,
跑完整集成回归 (pytest -m "not perf", 覆盖全部能力端点), 100% 通过才返回 0。

用法 (在仓库根, 用 anaconda python310):
    python scripts/run_regression.py                # 完整回归 (默认门禁)
    python scripts/run_regression.py --smoke        # 仅零额度冒烟 (快速自检)
    python scripts/run_regression.py --port 8011    # 自定义临时端口
    python scripts/run_regression.py --keep-server  # 调试: 测试后不杀服务

退出码: 0 = 全部通过; 1 = 有失败/异常。供 pre-push hook 与手动调用使用。
"""
import argparse
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DENO_PRO = os.path.join(REPO_ROOT, "deno_pro.ts")
ENV_FILE = os.path.join(REPO_ROOT, ".env")
DEFAULT_PORT = 8010  # 独立于用户本地默认 8000, 避免与已在跑的服务冲突

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001
    pass


def log(msg):
    print(f"  {msg}", flush=True)


def die(msg):
    print(f"\n[FAIL] {msg}", flush=True)
    sys.exit(1)


def check_deno():
    for cand in ("deno", os.path.expanduser("~/.deno/bin/deno")):
        try:
            r = subprocess.run([cand, "--version"], capture_output=True, text=True, timeout=10)
            if r.returncode == 0:
                return cand
        except Exception:  # noqa: BLE001
            continue
    die("未找到 deno 可执行文件 (PATH 或 ~/.deno/bin/deno)")


def env_has_stats_kv():
    """.env 是否设置了 STATS_KV (kv/memory) -> 本地起实例需 --unstable-kv 标志。"""
    if not os.path.exists(ENV_FILE):
        return False
    for line in open(ENV_FILE, encoding="utf-8"):
        line = line.strip()
        if line.startswith("STATS_KV") and "=" in line and not line.startswith("#"):
            val = line.split("=", 1)[1].strip().strip('"').strip("'")
            if val:
                return True
    return False


def wait_ready(base_url, timeout_s=60):
    url = f"{base_url}/v1/models"
    t0 = time.time()
    while time.time() - t0 < timeout_s:
        try:
            with urllib.request.urlopen(url, timeout=5) as r:
                if r.status == 200:
                    return True
        except Exception:  # noqa: BLE001
            time.sleep(1)
    return False


def start_server(deno, base_url, port, env_extra=None, log_path=None):
    """启动临时 deno 实例 (当前工作区代码), 返回 (proc, log_path)。"""
    if not os.path.exists(DENO_PRO):
        die(f"未找到 {DENO_PRO}")
    cmd = [deno, "run", "--allow-env", "--allow-net", "--allow-read"]
    if env_has_stats_kv():
        cmd.append("--unstable-kv")
    cmd += ["--env-file=.env", DENO_PRO]
    env = dict(os.environ)
    env["PORT"] = str(port)
    if env_extra:
        env.update(env_extra)
    log("命令: " + " ".join(cmd) + f"  (PORT={port})")
    log_path = log_path or os.path.join(REPO_ROOT, "regression_server.log")
    with open(log_path, "w", encoding="utf-8", errors="replace") as f:
        f.write("")
    proc = subprocess.Popen(
        cmd,
        cwd=REPO_ROOT,
        env=env,
        stdout=open(log_path, "a", encoding="utf-8", errors="replace"),
        stderr=subprocess.STDOUT,
    )
    if not wait_ready(base_url):
        out = ""
        try:
            out = open(log_path, encoding="utf-8", errors="replace").read()
        except Exception:  # noqa: BLE001
            pass
        die(f"实例未在 {base_url} 就绪, 启动输出片段:\n{out[-1500:]}")
    log("实例就绪")
    return proc, log_path


def stop_server(proc, keep=False):
    if keep:
        return
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
    log("已清理临时实例")


def main():
    ap = argparse.ArgumentParser(description="推送门禁集成回归测试运行器")
    ap.add_argument("--smoke", action="store_true", help="仅零额度冒烟 (快速自检)")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT, help="临时实例端口")
    ap.add_argument("--keep-server", action="store_true", help="测试后不杀服务 (调试)")
    args = ap.parse_args()

    deno = check_deno()
    base_url = f"http://localhost:{args.port}"

    # ---- 1. 静态类型检查 ----
    print("=" * 62)
    print("[1/4] 静态类型检查: deno check deno_pro.ts")
    print("=" * 62)
    r = subprocess.run([deno, "check", DENO_PRO], capture_output=True, text=True, timeout=180)
    if r.returncode != 0:
        print(r.stdout[-2000:])
        print(r.stderr[-2000:])
        die("deno check 失败, 请先修复类型错误")
    log("deno check 通过")

    # ---- 2+3. 分阶段: 每阶段启动独立服务实例 (限速开关不同) + 跑对应测试 ----
    # 两阶段 (完整门禁时): 限速专项先跑 (开启限速), 功能回归后跑 (关闭限速)。
    # 原因: 功能回归对同一模型高频调用 (>6次/分钟) 会触发限速门控, 两者必须分开;
    #       且 RATE_LIMIT_ENABLED 是【服务进程】环境变量, 故每阶段必须重启独立实例。
    if args.smoke:
        phases = [("零额度冒烟 (smoke)", "smoke", False)]
    else:
        phases = [
            ("限速专项 (rate_limit, 开启限速)", "rate_limit", True),
            ("完整集成回归 (not perf, 关闭限速)", "not perf and not rate_limit", False),
        ]

    pytest_env = dict(os.environ)
    pytest_env["PYTHONIOENCODING"] = "utf-8"
    active_proc = None
    try:
        for idx, (label, marker, rate_limit_on) in enumerate(phases):
            # 每阶段独立端口, 避免 Windows 上端口 TIME_WAIT 导致新实例绑定失败、
            # wait_ready 误连到旧实例 (旧实例限速开关不符)。
            phase_port = args.port + idx
            phase_url = f"http://localhost:{phase_port}"
            print("\n" + "=" * 62)
            print(f"[2/4→3/4] ({idx + 1}/{len(phases)}) 启动实例 + pytest {label}")
            print("=" * 62)
            active_proc, log_path = start_server(
                deno, phase_url, phase_port,
                env_extra={"RATE_LIMIT_ENABLED": "true" if rate_limit_on else "false"},
            )
            # 不传 --token: test/config.py 会 load_dotenv 从仓库根 .env 读 AUTH_TOKEN,
            # 且 base-url 显式指向本门禁临时实例。仅在进程环境已有 AUTH_TOKEN 时透传。
            pytest_cmd = [
                sys.executable, "-m", "pytest",
                "-m", marker, "-q",
                "--base-url", phase_url,
            ]
            r = subprocess.run(pytest_cmd, cwd=REPO_ROOT, env=pytest_env)
            stop_server(active_proc, keep=args.keep_server)
            active_proc = None
            if r.returncode != 0:
                die(f"集成回归测试失败 (exit {r.returncode}), 请修复后重试。如需跳过: git push --no-verify")
            log(f"{label} 100% 通过")

        # ---- 4. 汇总 ----
        total_label = "冒烟" if args.smoke else "限速专项 + 完整集成回归"
        print("\n" + "=" * 62)
        print(f"[4/4] 门禁通过 ✅  ({total_label} 全部通过)")
        print("=" * 62)
        return 0
    finally:
        if active_proc is not None:
            stop_server(active_proc, keep=args.keep_server)


if __name__ == "__main__":
    sys.exit(main())
