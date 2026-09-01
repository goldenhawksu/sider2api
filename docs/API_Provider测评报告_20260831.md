# sider2api Deno 部署实例 · API Provider 系统性测评报告

- **测评日期**：2026-08-31
- **被测实例**：生产 Deno Deploy 实例（地址见 `.env` 的 `BASE_URL`，本文一律以占位 `deno-sider2api.spdt.work` 指代）
- **被测代码**：`deno_pro.ts`（工作区 HEAD = `2fd6cb8`，与生产部署一致）
- **测评视角**：把该实例当作一个**对外提供服务的 API Provider** 来评，而不只是当作自家代码跑回归。核心问题是「一个不了解本项目的第三方开发者，能否把官方 SDK 的 `base_url` 一改就接入并稳定使用」。
- **工具**：pytest 回归框架（87 用例）+ 新增 `test/probe_sdk_compat.py`（官方 SDK 兼容性探针）+ 新增 `test/bench_models.py`（多模型性能横评）+ raw HTTP 抓包

---

## 一、总评

| 维度 | 评级 | 一句话结论 |
|---|---|---|
| 协议实现（raw HTTP） | **优** | 四协议端点 78/78 功能用例通过，格式翻译、流式状态机、能力门控、错误标准化都扎实 |
| 模型覆盖 | **优** | 59 个模型（34 base + 25 think）横跨 10 个厂商系列，横评 15/15 全部可用 |
| **官方 SDK 开箱兼容** | **差** | **三家官方 SDK 只有 OpenAI 能开箱用；Anthropic 与 Gemini SDK 直接 401** |
| 性能 | **良** | TTFT 中位数 2.12s、吞吐中位数 48.2 字符/秒；但流式分块粒度在模型间严重不一致 |
| 并发容量 | **受限（上游硬顶）** | 上游账号**只允许单并发**，10 并发仅 1 个成功——这是该 Provider 最硬的容量天花板 |
| 错误处理与可观测 | **良** | 错误翻译规范、`/stats` 观测面完善；但 429 的 `Retry-After` 头不一致 |

**一句话**：作为**内部/单人使用的 OpenAI 兼容网关**，它已经相当成熟可用；但要作为**对外的多协议 API Provider**，当前有 1 个 P0 和 2 个 P1 缺陷会让第三方开发者在第一步就接不通，且单并发上游决定了它无法承载多用户。

---

## 二、能力盘面

### 2.1 端点矩阵

| 端点 | 协议 | 鉴权 | 状态 |
|---|---|---|---|
| `POST /v1/chat/completions` | OpenAI Chat Completions | Bearer | ✅ 流式 + 非流式 |
| `POST /v1/responses` | OpenAI Responses | Bearer | ✅ 非流式；⚠️ 流式事件序列不完整（P1-2）|
| `POST /v1/messages` | Anthropic Messages | Bearer | ✅ 流式 + 非流式；⚠️ 不认 `x-api-key`（P0）|
| `POST /v1beta/models/{m}:generateContent` | Gemini | Bearer | ✅；⚠️ 不认 `x-goog-api-key`（P0）|
| `POST /v1beta/models/{m}:streamGenerateContent` | Gemini 流式 | Bearer | ⚠️ 尾部多发 `[DONE]`（P1-1）|
| `POST /v1/images/generations` | OpenAI Images | Bearer | ✅ |
| `GET /v1/models` | OpenAI Models | 公开 | ✅ 59 条 |
| `GET /stats`、`/stats.json` | 自有观测面 | 公开 | ✅ 含 Deno KV 持久化 |
| `GET /admin`、`GET /` | 管理/信息页 | 公开 | ✅ |

### 2.2 模型清单（59）

| 系列 | 数量 | 代表 |
|---|---|---|
| gpt | 10 | `gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-5.6-luna` / `gpt-5.5` / `gpt-4.1` |
| claude | 9 | `claude-opus-5` / `claude-fable-5` / `claude-sonnet-5` / `claude-haiku-4.5` |
| gemini | 6 | `gemini-3.7-flash` / `gemini-2.5-pro` |
| deepseek / grok | 各 2 | `deepseek-v4-pro` / `grok-4.6` |
| glm / qwen / kimi / llama / sider | 各 1 | `glm-5` / `qwen3.8-max` / `kimi-k3` / `llama-3.1-405b` / `sider`（智能路由）|

另有 25 个 `-think` 后缀推理变体。

### 2.3 能力门控（验证符合 CLAUDE.md「不 fake 上游没有的能力」铁律）

- **Vision 输入** → 四个端点一致返回标准化 `not_supported`，不伪造 ✅
- **Function Calling** → 优雅降级，`tool_choice=none` 行为正确 ✅
- **图像生成** → 专用端点 + 对话内自动触发均可用 ✅
- **think 模式** → `-think` 后缀流式/非流式均正确 ✅
- **多轮记忆** → `X-Session-ID` 生效，且会话 ID 按调用方指纹隔离 ✅

---

## 三、缺陷清单

### 🔴 P0-1：鉴权门只认 `Authorization: Bearer`，两家官方 SDK 开箱即 401

> **已于 2026-09-01 修复并上线**（commit `9c1f7f8`）。修复方式与生产验证见
> [门控优化与P0修复验证报告_20260901.md](门控优化与P0修复验证报告_20260901.md)。以下保留问题原貌。

**位置**：[deno_pro.ts:1394](../deno_pro.ts#L1394) `authMiddleware`

```ts
const authHeader = req.headers.get("Authorization");
if (!authHeader || !authHeader.startsWith("Bearer ")) { /* 401 */ }
```

实例实现了 Anthropic 与 Gemini 的**协议格式**，却没实现它们的**鉴权约定**：

| SDK | 官方发送的鉴权头 | 实例行为 |
|---|---|---|
| `openai` 3.6.0 | `Authorization: Bearer` | ✅ 通过 |
| `anthropic` 1.2.0 | `x-api-key` | ❌ 401 |
| `google-genai` 2.20.0 | `x-goog-api-key`（或 `?key=`）| ❌ 401 |

**实测证据**（`test/probe_sdk_compat.py`）：

```
openai.models.list                          PASS   59 models
openai.chat.completions (non-stream)        PASS   finish=stop text='OK' usage=True
openai.chat.completions (stream)            PASS   7 chunks, 6 chars
openai.responses.create                     PASS   status=completed output_text='OK'
anthropic.messages.create                   FAIL   401 Missing or invalid Authorization header
anthropic.messages.stream                   FAIL   401 ...
genai.generate_content                      FAIL   401 ...
genai.generate_content_stream               FAIL   401 ...
--- 对照组: 手动注入 Authorization 头 ---
anthropic.messages.create   [注入]           PASS   stop=end_turn text='OK' usage_in=4
anthropic.messages system   [注入]           PASS   text='喵'
anthropic.messages.stream   [注入]           PASS   2 deltas, 12 chars, final_stop=end_turn
genai.generate_content      [注入]           PASS   text='OK'
```

**关键判定**：注入 `Authorization` 后 Anthropic/Gemini 端点**全部正常工作**。所以这**不是协议实现问题，纯粹是鉴权门的问题**——协议做对了，门没开。

**为什么现有测试没发现**：pytest 套件用 `requests` 手工构造 `Authorization` 头，从未走过官方 SDK 的鉴权路径。这是测试盲区。

**修复建议**（低风险、高收益）：`authMiddleware` 额外接受 `x-api-key`、`x-goog-api-key` 头及 `?key=` query，任一匹配 `AUTH_TOKEN` 即放行。约 10 行改动，即可让两家官方 SDK 开箱可用。

---

### 🟠 P1-1：Gemini 流式尾部多发 `data: [DONE]`，google-genai SDK 解析崩溃

**位置**：[deno_pro.ts:2985](../deno_pro.ts#L2985)、[deno_pro.ts:3015](../deno_pro.ts#L3015)（`handleGeminiGenerate` 流式路径）

`data: [DONE]` 是 **OpenAI 的 SSE 约定**，Gemini 官方 SSE 协议里**没有**这个终止哨兵。google-genai SDK 会把它当作一个正常事件去 `json.loads`：

```
genai.generate_content_stream [注入Authorization]  FAIL
  UnknownApiResponseError: Failed to parse response as JSON. Raw response: [DONE]
```

raw 抓包确认尾部结构：

```
data: {"candidates":[{"content":{"role":"model","parts":[]},"finishReason":"STOP","index":0}]}

data: [DONE]
```

**影响**：即使修好 P0-1，Gemini **流式**仍然对官方 SDK 不可用（非流式可用）。
**修复建议**：Gemini 流式路径不发 `[DONE]`，以 `finishReason` 事件收尾即可。注意只改 Gemini 分支——OpenAI Chat 与 Responses 路径需要保留 `[DONE]`。

---

### 🟠 P1-2：Responses 流式事件序列不完整，openai SDK `.responses.stream()` 抛 TypeError

实测事件序列只有 3 种类型：

```
response.created → response.output_text.delta × N → response.completed
```

且**首个 delta 事件缺字段**：

```
[0] type=response.created            keys=['response','type']
[1] type=response.output_text.delta  keys=['delta','type']            ← 缺 item_id/output_index/content_index
[2] type=response.output_text.delta  keys=['content_index','delta','item_id','output_index','type']
```

官方 Responses SSE 规范要求的中间事件全部缺失：`response.in_progress`、`response.output_item.added`、`response.content_part.added`、`response.output_text.done`、`response.content_part.done`、`response.output_item.done`。

SDK 的 accumulator 拿 `output_index=None` 去索引 list，直接报错：

```
openai.responses.stream   FAIL   TypeError: list indices must be integers or slices, not NoneType
```

**影响**：`client.responses.stream()` 完全不可用（`responses.create()` 非流式可用）。
**修复建议**：至少补齐 `output_item.added` + `content_part.added`，并给首个 delta 补上三个索引字段。

---

### 🟡 P2-1：429 的 `Retry-After` 头不一致

10 并发实测：

| 429 来源 | 响应体 | `Retry-After` |
|---|---|---|
| 本地限速门（每模型 60s/6 次）| `model_rate_limited` + 中文提示 | ✅ 有（59/60）|
| 上游透传（并发限制）| `Your account has an active request...` | ❌ 无 |
| 上游透传（额度耗尽 `upstream_code:1135`）| `usage limit... after 117 minutes` | ❌ 无 |

客户端 SDK 普遍依赖 `Retry-After` 做退避重试。上游 429 缺这个头，会让 SDK 退化成固定间隔盲重试。
**修复建议**：上游 429 也补 `Retry-After`（并发限制给个小值如 5s；`1135` 额度错误可从提示文本的分钟数换算）。

---

### 🟡 P2-2：回归套件与生产限速配置不兼容，产生 13 个假失败

首轮 `pytest -m "not perf"` 打生产实例：**65 passed / 13 failed**。13 个失败**全部**是 `model_rate_limited` 429——套件在 60 秒窗口里对 `gpt-5.5` / `sider` 连打远超 6 次，自己把自己限流了。

分批重跑（组间等窗口重置）后：**13/13 全部通过**。

```
批1 gpt-5.5 组 A（4 项）  → 4 passed
批2 gpt-5.5 组 B（4 项）  → 4 passed
批3 gpt-5.5 组 C + sider 组（5 项）→ 5 passed
```

**影响**：`docs/集成回归测试门禁.md` 的 pre-push 门禁若指向启用了限速的实例，会**稳定误报**并拦截正常推送。
**修复建议**：套件加节流（每模型请求间隔或 429 自动退避重试），或让门禁实例以 `RATE_LIMIT_ENABLED=false` 启动。

---

## 四、性能测评

### 4.1 多模型横评（`test/bench_models.py`，串行，统一 200 字中文写作 prompt，流式）

| 模型 | TTFT(s) | 总耗时(s) | 字符 | 块数 | 字符/秒 |
|---|---|---|---|---|---|
| gpt-5.6-sol | 1.90 | 3.23 | 201 | 196 | 62.2 |
| gpt-5.5 | 1.94 | 3.19 | 191 | 189 | 59.9 |
| qwen3.8-max | 1.96 | 3.28 | 201 | 198 | 61.4 |
| gemini-2.5-flash | 2.01 | 4.04 | 247 | 8 | 61.2 |
| llama-3.1-405b | 2.01 | 3.17 | 193 | 189 | 60.9 |
| gpt-4.1 | 2.02 | 3.18 | 181 | 177 | 56.9 |
| claude-sonnet-5 | 2.06 | 5.15 | 248 | 10 | 48.2 |
| gemini-3.7-flash | 2.12 | 3.86 | 251 | 8 | 65.1 |
| claude-haiku-4.5 | 2.38 | 6.47 | 264 | 13 | 40.8 |
| claude-opus-4.5 | 2.39 | 5.15 | 231 | 9 | 44.9 |
| glm-5 | 2.41 | 5.32 | 200 | 93 | 37.6 |
| sider | 2.50 | 4.41 | 189 | 154 | 42.9 |
| kimi-k3 | 2.63 | 4.32 | 199 | 197 | 46.1 |
| deepseek-v4-pro | 2.97 | 4.42 | 141 | 112 | 31.9 |
| grok-4 | 3.32 | 3.82 | 158 | 156 | 41.4 |

**成功 15/15**，TTFT 中位数 **2.12s**，吞吐中位数 **48.2 字符/秒**。

### 4.2 关键观察：流式分块粒度在模型间严重不一致

| 分组 | 块数（约 200 字输出）| 体感 |
|---|---|---|
| gpt / qwen / llama / kimi / grok | 156–198 块 | 逐字流出，顺滑 |
| glm / sider | 93–154 块 | 中等 |
| **claude / gemini** | **8–13 块** | **一顿一大段，接近伪流式** |

同样输出 200+ 字，claude 系列只有 9 块、gemini 只有 8 块。TTFT 差不多，但吐字体验差异极大。这**大概率是上游 sider 对不同模型的分块策略差异**（非本实例引入），但作为 Provider 对外承诺「流式」时，这个体验落差值得在文档中说明。

### 4.3 标准 perf 套件

6/7 通过。唯一失败是 `claude-opus-4.8` 命中**上游账号额度上限**：

```
HTTP 429 {"error":{"message":"You've reached the current usage limit...
          Please try again after 117 minutes.",
          "type":"rate_limit_error","upstream_code":1135}}
```

错误翻译**正确**（上游业务码 → 标准 `rate_limit_error` + 保留 `upstream_code`），属于上游额度而非实例缺陷。

---

## 五、并发与容量（最硬的天花板）

10 并发打同一模型的实测分布：

```
200: 1    429: 9
  ├─ 5 个: 本地限速门 model_rate_limited（每模型 60s/6 次）
  └─ 4 个: 上游透传 "Your account has an active request - only one request at a time"
```

**结论**：上游 sider 账号是**单并发**的——同一时刻只允许一个在途请求。这意味着：

- 该实例**无法承载多用户并发**，本质是「单人/单客户端的个人网关」；
- 本地的「每模型 60s/6 次」限速门其实是在**保护上游账号不被封**（CLAUDE.md 记录过高频直连触发 IP 级封禁的教训），设计合理；
- 任何「对外开放」的设想，都要先解决上游单并发这个硬约束（多账号池化 / 请求排队）。

---

## 六、测试执行汇总

| 阶段 | 结果 |
|---|---|
| 冒烟（零额度，含 mock 回归 12 项） | **27 / 27 通过** |
| 完整功能回归 `-m "not perf"` 首轮 | 65 通过 / 13 失败（**全部为限速误伤**）/ 2 默认跳过 |
| 13 个失败项分批重跑 | **13 / 13 通过** |
| **功能矩阵合计** | **78 / 78 通过**，2 项默认跳过（并发图像 429、SSE 心跳断言）|
| 官方 SDK 兼容性（14 项）| 8 通过 / 6 失败 → 见 P0-1、P1-1 |
| 多模型横评（15 模型）| **15 / 15 通过** |
| 标准 perf 套件 | 6 通过 / 1 上游额度 429 |
| 并发探测（10 并发）| 1 成功 / 9 限流 |

---

## 七、优先级建议

| 优先级 | 事项 | 收益 | 成本 |
|---|---|---|---|
| **P0** | `authMiddleware` 兼容 `x-api-key` / `x-goog-api-key` / `?key=` | 两家官方 SDK 从「完全不可用」变「开箱可用」 | ~10 行 |
| **P1** | Gemini 流式去掉 `data: [DONE]` | google-genai 流式可用 | ~2 行（注意只改 Gemini 分支）|
| **P1** | Responses 流式补齐事件序列与首 delta 索引字段 | `openai.responses.stream()` 可用 | 中等 |
| **P1** | 回归套件加节流/429 退避 | 消除门禁假失败 | 小 |
| **P2** | 上游 429 补 `Retry-After` | SDK 退避行为正确 | 小 |
| **P2** | 新增「官方 SDK 兼容性」为常驻回归项 | 防止此类盲区复发 | 已产出探针脚本，接入即可 |

---

## 八、本次测评产出的资产

| 文件 | 说明 |
|---|---|
| `test/probe_sdk_compat.py` | 官方 SDK 兼容性探针（openai / anthropic / google-genai，含「注入 Authorization」对照组，用于区分鉴权门缺陷与协议缺陷）|
| `test/bench_models.py` | 多模型性能横评（串行，输出 TTFT / 吞吐 / 分块粒度 markdown 表）|

两者均为独立脚本（非 pytest 用例），不影响现有门禁；建议后续将 SDK 探针改造为 pytest 用例纳入常驻回归。

---

## 九、环境副作用备注

为做 SDK 兼容性实测，在 `python310` 环境安装了 `openai` 3.6.0 / `anthropic` 1.2.0 / `google-genai` 2.20.0。这**连带把 `httpx` 升级到 0.28.1**，pip 报告与已装的 `mootdx` 0.11.7（要求 `httpx<0.26.0`）存在依赖冲突。若 `mootdx` 有实际使用需求，需要处理这个冲突（建议给 SDK 测试单独建环境）。
