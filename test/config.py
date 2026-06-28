"""sider2api 测试框架配置.

配置来源优先级: CLI 参数(--base-url/--token 等) > 进程环境变量 > 仓库根 .env > 内置默认。
.env 中用 BASE_URL / AUTH_TOKEN 配置被测 deno 实例地址与服务端 token。
"""
import os

from dotenv import load_dotenv

# 从仓库根 .env 读取 (override=False: 不覆盖已有进程环境变量)
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
load_dotenv(os.path.join(_REPO_ROOT, ".env"))

# 被测实例 (代码仅含占位值; 真实地址/Token 在 .env; 本地开发可用 --base-url http://localhost:8000)
DEFAULT_BASE_URL = os.getenv("BASE_URL", "https://deno-sider2api.spdt.work")
DEFAULT_TOKEN = os.getenv("AUTH_TOKEN", "sk-deno-free-key-123456")

# 超时 (秒). 上游 think / 图像生成较慢, 读超时给足余量
CONNECT_TIMEOUT = float(os.environ.get("SIDER2API_CONNECT_TIMEOUT", "15"))
READ_TIMEOUT = float(os.environ.get("SIDER2API_READ_TIMEOUT", "120"))

# 代表性模型预设 (按系列各取代表). 运行时与 live /v1/models 取交集, 不存在则自动跳过.
# 与 test/local_test.py 选型保持一致, 另加 sider 智能路由作兜底基线.
REPRESENTATIVE_MODELS = [
    "gpt-5.5",
    "claude-opus-4.8",
    "gemini-2.5-pro",
    "deepseek-v4-pro",
    "grok-4",
    "sider",
]

# think 模式代表模型 (需 -think 后缀且在 live 列表中)
REPRESENTATIVE_THINK_MODEL = "gpt-5.5-think"

# 单点能力 (流式 / system / 多轮 / 图像触发) 统一用的代表模型, 控制额度消耗
STREAM_MODEL = "gpt-5.5"
SINGLE_MODEL = "gpt-5.5"

# 性能阈值 (宽松上限, 仅作冒烟门槛, 不做严格 SLA)
PERF_TTFT_MAX_S = float(os.environ.get("SIDER2API_PERF_TTFT_MAX", "60"))
PERF_TOTAL_MAX_S = float(os.environ.get("SIDER2API_PERF_TOTAL_MAX", "120"))
