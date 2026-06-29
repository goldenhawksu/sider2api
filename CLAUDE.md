# sider2api 项目约定（长期）

> 本文件是项目的长期开发"宪法"。`deno_pro.ts` 的所有功能开发、测试、发布均遵循此约定。
> 操作细节见 [test/README.md](test/README.md)（测试框架）与 [docs/开发测试发布SOP.md](docs/开发测试发布SOP.md)（发布流程）。

## 一、项目本质与架构定位

`deno_pro.ts` 本质是一个 **API 翻译中间件（middleware）**：它**模拟 sider 浏览器插件的行为**，在「终端用户请求」与「上游 sider.ai」之间做双向翻译。因此请求需伪装成插件形态（携带 `app_name`/`from`/`tz` 等模板字段），且上游协议会随 sider 插件升级而变化。

三层职责（每个功能都应归位到某一层）：
1. **入站适配层 (inbound)**：把 OpenAI / Gemini / Anthropic 的**最新**消息格式归一为内部统一表示。
2. **翻译核心 (core)**：内部表示 ↔ sider 上游协议（伪装插件、会话管理、上下文拼接、流式转换）。
3. **上游能力层 (upstream)**：sider.ai 的真实能力 = **能力天花板**。

**能力门控原则（铁律）**：终端 endpoint 能提供的能力，由上游 sider **经 probe 证实**支持的能力决定。
- 上游没有的能力（如视频）**绝不 fake、不硬凑**；明确不提供，并返回标准化的 `not_supported` 错误。
- 新能力上线前，必须先 probe 上游确认其存在与协议形状（见第三节 probe-first）。

## 二、环境矩阵

| 环境 | 运行什么 | 地址 | 用途 |
|---|---|---|---|
| 本地开发/单测 | deno 跑 `deno_pro.ts` | `http://localhost:8000` | 功能开发、单元测试、集成回归 |
| 生产 | 推送→deno.com 自动部署(~30s) | `.env` 的 `BASE_URL`(占位 `deno-sider2api.spdt.work`) | 功能测试、性能测试 |
| 上游 | sider.ai（`SIDER_AUTH_TOKEN`） | `https://sider.ai/api/chat/v1/...` | 能力来源 |

- **安全**：真实生产地址与服务端 `AUTH_TOKEN` 只存于 `.env`(已 gitignored)；**代码库与文档一律只用占位值** `deno-sider2api.spdt.work` / `sk-deno-free-key-123456`。代码读取优先级见第六节。

- 本地与生产跑的是**同一份 `deno_pro.ts`**，仅环境不同（`--base-url` 切换被测目标）。
- **本地与生产共用同一真实上游 sider**：任何涉及上游能力的调用都**消耗真实额度、依赖上游可用性**。涉及上游的"本地单测"并非零成本/离线；真正的纯单元测试需对上游做 mock。

## 三、能力开发原则

- **probe-first**：上游能力会随插件协议演进而变。开发前先主动 probe 上游，确认能力边界与协议形状，再实现/暴露。
- **多格式兼容**：终端 endpoint 在消息格式上兼容 OpenAI / Gemini / Anthropic 的**最新**规范，以三家**官方 spec** 为准。
- **纠错/容错是一等公民**：参数校正、格式降级、上游错误→标准化错误翻译、能力不支持时优雅返回而非崩溃或伪造。
- **不重复造轮子**：参考官方 spec 与成熟开源适配器（LiteLLM、one-api/new-api 等）的最佳实践与经验教训，避免坐井观天。
- **总目标**：面向终端的 api provider endpoint 要**多才多艺、稳定可靠、尽可能 exploit 上游 sider 的能力**。

## 四、测试框架（TDD，位于 [test/](test/)）

两类测试目标，缺一不可：
1. **转换层回归**：对 deno 实例（`--base-url` 切本地/生产）测 `deno_pro.ts` 的格式翻译与能力是否正确、稳定。
2. **上游能力探针 (upstream probe)**：`test/probe_upstream.py`(+`test/upstream_client.py`) 直连 sider.ai, 系统化发现上游真实能力(模型/对话/think reasoning/图像/搜索/参数边界/错误码), 产出 `test/reports/upstream_capabilities_*.md`。**探针结果反过来定义 `deno_pro.ts` 该实现什么、测试该断言什么。**

约定：
- pytest，marker 分层：`smoke`/`cost`/`chat`/`stream`/`multiturn`/`think`/`image`/`perf`/`openai`/`gemini`/`anthropic`/`tools`/`vision`（全部已有对应测试覆盖）。命令见 [test/README.md](test/README.md)。
- **额度意识**：`cost` 类用例消耗真实 sider 额度；默认跑代表子集，快速验证用 `-m smoke`（零额度）。
- **上游限频(铁律)**：探针直连 sider.ai 内置全局节流（`--min-interval`，默认5s）。**严禁短时间高频直连上游**——会触发 sider.ai 的 IP 级封禁（实测连续高频探测后本地直连被阻断 `WinError 10051`，而 deno 部署实例仍正常，印证 middleware/分布式出口的价值）。优先通过 deno 实例间接测试，仅在必须发现上游真实能力时才低频直连。
- 路线图扩展按 **TDD**：先写红灯（基于 probe 确认的上游能力），再实现，再转绿。上游确实不支持的，写成断言"返回标准 not_supported"。
- 报告产物在 `test/reports/`（不入库）。

## 五、开发流程

参考 [docs/开发测试发布SOP.md](docs/开发测试发布SOP.md)：
1. 用户给出功能指令 → 2. 本地开发 + 单元测试 → 3. 本地集成回归（必要时先 probe 上游）→ 4. 用户 review 同意 → 5. 推送远端（**即触发生产部署**）→ 6. 生产功能/性能验证 → 7. 出报告。

## 六、工程约束

- Python 一律用 anaconda3 管理的 `python310` 虚拟环境运行（`conda activate python310` 后用 `python`）。
- **推送主分支/远端必须经用户明确同意**（推送即上线生产）。
- Windows 注意：跑 python 测试设 `PYTHONIOENCODING=utf-8`；`requirements*.txt` 注释保持 ASCII（pip 用 GBK 解码会报错）；联网用 `requests`（verify=True 正常），anaconda 自带 `urllib` 因 certifi 过期会证书校验失败。
