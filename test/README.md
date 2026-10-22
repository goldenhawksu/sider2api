# sider2api 测试框架

针对 `deno_pro.ts` 部署实例的 pytest 回归测试框架。覆盖当前已实现能力:
OpenAI Chat / Anthropic Messages / Gemini generateContent / OpenAI Responses /
多轮会话 / think 模式 / 图像生成 / 门控与租约生命周期 / Function Calling 拒绝 /
Vision 门控 / 错误处理 / 官方 SDK 契约 / 性能度量。

## 安装

```bash
conda activate python310     # 激活 anaconda3 的 python310 虚拟环境
python -m pip install -r requirements-test.txt
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

## 测试文件索引

| 文件 | marker | 覆盖能力 |
|---|---|---|
| `test_meta.py` | `smoke` | 主页 / 模型清单契约 / CORS / 404 |
| `test_chat.py` | `chat` | 非流式 6 模型 / 流式 / system 消息 / content 数组 |
| `test_errors.py` | `smoke`/`cost` | 缺参 400 / 鉴权 401 / 未知模型 404 / 并发 429 |
| `test_multiturn.py` | `multiturn` | X-Session-ID 多轮记忆 |
| `test_think.py` | `think` | -think 后缀推理 (非流式+流式) |
| `test_image.py` | `image` | 图像生成端点 + 对话触发图像 |
| `test_anthropic_format.py` | `anthropic` | Anthropic Messages API (7 条) |
| `test_gemini_format.py` | `gemini` | Gemini generateContent (6 条) |
| `test_openai_responses.py` | `openai` | OpenAI Responses API (7 条) |
| `test_tools.py` | `tools` | 自定义 tools → not_supported (4 端点) + tool_choice=none 放行 |
| `test_vision.py` | `vision` | Vision 输入 → not_supported (4 端点) |
| `test_performance.py` | `perf` | 非流式延迟 + 流式 TTFT/吞吐 |
| `test_deno_pro_mock_regression.py` | `smoke` | **mock 上游驱动的门控/协议契约回归** (零额度): 三段超时、排队后二次准入、半开探测、成功判定、四协议错误出口矩阵、Context 预算、会话复用、官方 SDK 契约 (openai / anthropic / google-genai) |
| `test_deno_pro_reliability.py` | `smoke` | 四协议输入校验、特殊模型与窗口别名、最终上下文预算及裁剪通知、请求总期限、会话检查点与并发、早期拒绝统计和日志 |
| `test_stream_contract.py` | `stream` | 流式事件契约 (Anthropic content-block 状态机) |
| `test_rate_limit.py` | `cost`/`rate_limit` | 熔断语义 (603 不熔断) |
| `test_stats.py` | `smoke`/`chat` | `/stats` 页面与 `/stats.json` 契约 |
| `test_sdk_auth.py` | `smoke`/`cost` | 三家官方 SDK 的鉴权头兼容 |

> **mock 回归是改动门控/协议时的第一道闸门**: 它自带 mock 上游与独立 deno 实例,
> 不触达 sider.ai、零额度, 且能精确断言"排队是否复检""超时后槽位是否释放"这类
> 真实上游无法稳定复现的行为。改 `deno_pro.ts` 的门控、超时或协议事件后请先跑它:

```bash
python -m pytest test/test_deno_pro_mock_regression.py test/test_deno_pro_reliability.py -q
```
