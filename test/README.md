# sider2api 测试框架

针对 `deno_pro.ts` 部署实例的 pytest 回归测试框架。覆盖当前已实现能力:
模型清单、对话生成(流式/非流式)、多轮会话、think 模式、图像生成、错误处理、性能度量。

## 安装

```bash
d:/Anaconda3/envs/python310/python.exe -m pip install -r ../requirements-test.txt
```

## 运行(在仓库根目录执行)

> Windows 控制台请先设 `PYTHONIOENCODING=utf-8` 避免中文/emoji 乱码。

| 目的 | 命令 |
|---|---|
| 冒烟(零额度) | `pytest -m smoke -v` |
| 仅结构/契约(不耗额度) | `pytest -m "not cost and not perf" -v` |
| 功能回归(代表子集,耗少量额度) | `pytest -m "not perf" -v` |
| 全量模型 | `pytest --full -m "not perf"` |
| 性能套件 | `pytest -m perf -v` |
| 指定能力 | `pytest -m chat` / `-m image` / `-m multiturn` ... |
| 并发图像 429(默认跳过) | `pytest test/test_errors.py --run-concurrent` |

## 配置被测实例

配置来源优先级: **CLI 参数 > 进程环境变量 > 仓库根 `.env` > 内置默认**。
在 `.env` 中设 `BASE_URL` / `AUTH_TOKEN`(被测 deno 实例地址与服务端 token):

```bash
pytest --base-url http://localhost:8000 --token sk-xxx   # CLI 临时覆盖(本地 deno)
BASE_URL=http://localhost:8000 pytest                    # 进程环境变量覆盖
# 不传任何参数时, 自动读取 .env 的 BASE_URL / AUTH_TOKEN
```

## 报告

每次运行自动汇总到 `test/reports/pytest_report_<时间戳>.md`(含通过矩阵 + 性能表)。
如需 HTML: `pytest -m smoke --html=test/reports/report.html --self-contained-html`。

## 配置

代表模型、超时、性能阈值见 [config.py](config.py),均可经环境变量覆盖。

## 扩展(路线图)

把 `deno_pro.ts` 扩展为多格式/多能力时,新增 `test_gemini_format.py` /
`test_anthropic_format.py` / `test_tools.py` / `test_vision.py`,复用已注册的
`gemini` / `anthropic` / `tools` / `vision` marker。按 TDD: 先写红灯,再实现。
