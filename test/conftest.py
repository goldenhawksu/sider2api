"""pytest 配置: 命令行选项、fixtures、模型参数化、报告钩子。"""
import datetime
import os
import sys
import warnings

# 保证 config / helpers 可被测试文件与本模块导入
sys.path.insert(0, os.path.dirname(__file__))

import pytest

import config
from helpers import ApiClient

# live 模型清单缓存, 供 pytest_generate_tests 与 live_models fixture 共享 (只拉一次)
_MODELS_CACHE = {}
# 性能记录, 由 perf_recorder fixture 收集, pytest_terminal_summary 汇总落盘
PERF_RECORDS = []


def _fetch_model_ids(base_url, token):
    key = (base_url, token)
    if key not in _MODELS_CACHE:
        _MODELS_CACHE[key] = ApiClient(base_url, token).list_model_ids()
    return _MODELS_CACHE[key]


def pytest_addoption(parser):
    g = parser.getgroup("sider2api")
    g.addoption("--base-url", action="store", default=None, help="覆盖被测实例地址")
    g.addoption("--token", action="store", default=None, help="覆盖鉴权 token")
    g.addoption("--full", action="store_true", default=False, help="遍历全部 live 模型, 而非代表子集")
    g.addoption("--read-timeout", action="store", type=float, default=None, help="读超时秒数")
    g.addoption("--run-concurrent", action="store_true", default=False,
                help="启用默认跳过的并发图像 429 测试")


def _resolve(pytest_config):
    base = pytest_config.getoption("base_url") or config.DEFAULT_BASE_URL
    token = pytest_config.getoption("token") or config.DEFAULT_TOKEN
    return base, token


@pytest.fixture(scope="session")
def client(request):
    base, token = _resolve(request.config)
    rt = request.config.getoption("read_timeout") or config.READ_TIMEOUT
    return ApiClient(base, token, read_timeout=rt)


@pytest.fixture(scope="session")
def live_models(request):
    base, token = _resolve(request.config)
    try:
        return _fetch_model_ids(base, token)
    except Exception as e:  # noqa: BLE001
        pytest.fail(f"无法获取 /v1/models ({base}): {e}")


@pytest.fixture
def perf_recorder():
    return PERF_RECORDS


def pytest_generate_tests(metafunc):
    """为请求 chat_model 参数的测试动态参数化: 默认代表子集, --full 时全量。"""
    if "chat_model" not in metafunc.fixturenames:
        return
    base, token = _resolve(metafunc.config)
    try:
        ids = _fetch_model_ids(base, token)
    except Exception as e:  # noqa: BLE001
        warnings.warn(f"获取模型清单失败, chat 参数化为空: {e}")
        metafunc.parametrize("chat_model", [], ids=[])
        return
    if metafunc.config.getoption("full"):
        chosen = ids
    else:
        chosen = [m for m in config.REPRESENTATIVE_MODELS if m in ids]
    metafunc.parametrize("chat_model", chosen, ids=chosen)


def pytest_terminal_summary(terminalreporter, exitstatus):
    """汇总通过矩阵与性能指标到 test/reports/ 并在终端简报 (ASCII 安全)。"""
    reports_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), "test", "reports")
    os.makedirs(reports_dir, exist_ok=True)
    ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")

    stats = terminalreporter.stats
    n_pass = len(stats.get("passed", []))
    n_fail = len(stats.get("failed", []))
    n_skip = len(stats.get("skipped", []))
    n_err = len(stats.get("error", []))

    lines = [
        f"# sider2api 测试报告 {ts}",
        "",
        f"- 通过: {n_pass}  失败: {n_fail}  跳过: {n_skip}  错误: {n_err}",
        f"- 退出码: {exitstatus}",
        "",
    ]
    if PERF_RECORDS:
        lines += [
            "## 性能指标",
            "",
            "| 标签 | 模型 | 模式 | TTFT(s) | 总耗时(s) | 字符数 | 块数 | 字符/秒 |",
            "|---|---|---|---|---|---|---|---|",
        ]
        for m in PERF_RECORDS:
            ttft = m.ttft_s if m.ttft_s is not None else "-"
            cps = m.chars_per_s if m.chars_per_s is not None else "-"
            lines.append(f"| {m.label} | {m.model} | {m.mode} | {ttft} | {m.total_s} | {m.chars} | {m.chunks} | {cps} |")
        lines.append("")

    report_path = os.path.join(reports_dir, f"pytest_report_{ts}.md")
    with open(report_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))

    tr = terminalreporter
    tr.write_sep("-", "sider2api summary")
    tr.write_line(f"pass={n_pass} fail={n_fail} skip={n_skip} err={n_err}")
    if PERF_RECORDS:
        tr.write_line("perf:")
        for m in PERF_RECORDS:
            tr.write_line(f"  [{m.mode}] {m.model} ttft={m.ttft_s} total={m.total_s}s chars={m.chars} cps={m.chars_per_s}")
    tr.write_line(f"report -> {report_path}")
