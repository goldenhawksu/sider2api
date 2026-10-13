// 迁移到console.deno.com以后用原生deno.serve -- Weihong 2026/06/28
// import { serve } from "https://deno.land/std@0.200.0/http/server.ts";

// ==================== 配置常量 ====================

const SIDER_API_ENDPOINT = Deno.env.get("SIDER_API_ENDPOINT") ||
  Deno.env.get("SIDER_API_URL") ||
  "https://sider.ai/api/chat/v1/completions";

// 从环境变量获取 Token,如果没有则使用默认值(仅用于测试)
const SIDER_AUTH_TOKEN = Deno.env.get("SIDER_AUTH_TOKEN")
// 服务端 API 认证 Token(可选)
const AUTH_TOKEN = Deno.env.get("AUTH_TOKEN");

// ==================== 性能/兼容性开关 ====================
// 上游请求【三段超时】(毫秒)。单个定时器只能约束到"响应头到达"为止 —— 上游回了 200
// 之后不再发字节时, 旧实现在收到响应头就 clearTimeout, 客户端会一直挂着, 并发槽位
// 也不释放。拆成三段后, 每个阶段都有各自的 watchdog:
//   header: fetch 到响应头; 超时说明上游根本没接单。
//   idle  : 相邻两个响应体分片之间的最大间隔; 覆盖"头到了但正文卡死"。
//   total : 整个调用生命周期(排队之后的 fetch + 流式传输)的硬上限。
// 三者统一 abort + cancel + release, 并映射为 504 gateway_timeout。
const UPSTREAM_HEADER_TIMEOUT_MS = parseInt(Deno.env.get("UPSTREAM_HEADER_TIMEOUT_MS") || "30000", 10);
const UPSTREAM_STREAM_IDLE_TIMEOUT_MS = parseInt(Deno.env.get("UPSTREAM_STREAM_IDLE_TIMEOUT_MS") || "60000", 10);
// 兼容旧变量名 UPSTREAM_TIMEOUT_MS (历史上是"总超时"语义, 保留作为回退)
const UPSTREAM_TOTAL_TIMEOUT_MS = parseInt(
  Deno.env.get("UPSTREAM_TOTAL_TIMEOUT_MS") || Deno.env.get("UPSTREAM_TIMEOUT_MS") || "180000",
  10,
);
// 是否默认启用自动搜索(会显著影响 TTFT/长尾)
const ENABLE_AUTO_SEARCH = (Deno.env.get("ENABLE_AUTO_SEARCH") || "true").toLowerCase() === "true";
// Sider API 对 text/user_input_text 字段的字符上限，预留 500 字节安全余量
const SIDER_MAX_CHARS = 49500;
// Sider API 词数上限（实测 code:603 触发于长对话），保守估计设为 6000 词
const SIDER_MAX_WORDS = 6000;
// SSE 心跳间隔(毫秒)：流式空闲(如 think 长思考、上游首字延迟)时定期发送 ping 帧，
// 防止 nginx / 负载均衡 / 客户端在无字节间隔时掐断连接。0 关闭心跳。
// 默认 15s，小于常见 30~60s 代理空闲超时。
const SSE_PING_INTERVAL_MS = parseInt(Deno.env.get("SSE_PING_INTERVAL_MS") || "15000", 10);

// ==================== 上游调用限速门控 ====================
// 对 sider 上游的每次调用做模型级限速，防止单模型突发流量打爆上游额度/触发 IP 级限流。
// - 并发闸门: 上游账号实测为【单并发】(并发请求会被拒 "only one request at a time")，
//   故超出并发数的请求排队等待而非直接失败，把并发冲突从"失败"变成"排队"。
// - 滑动窗口: 每模型每 60s 最多 quota 次调用；quota 随上游反馈自适应 (AIMD)。
// - 熔断: 1135 优先按上游消息中告知的时间熔断 (上游会明说 "try again after N minutes")，
//   解析不出才回退到固定时长。
// - 超限/熔断直接返回标准化 429 rate_limit_error，不消耗上游额度。
const RATE_LIMIT_WINDOW_MS = parseInt(Deno.env.get("RATE_LIMIT_WINDOW_MS") || "60000", 10); // 窗口 60s
const RATE_LIMIT_MAX_CALLS = parseInt(Deno.env.get("RATE_LIMIT_MAX_CALLS") || "6", 10);      // 每窗口初始配额
const RATE_LIMIT_BREAKER_MS = parseInt(Deno.env.get("RATE_LIMIT_BREAKER_MS") || "60000", 10); // 普通模型熔断 1 分钟
const RATE_LIMIT_BREAKER_OPUS_MS = parseInt(Deno.env.get("RATE_LIMIT_BREAKER_OPUS_MS") || "3600000", 10); // opus 熔断 1 小时
// 是否启用限速 (默认开; 测试/调试可关)
const RATE_LIMIT_ENABLED = (Deno.env.get("RATE_LIMIT_ENABLED") || "true").toLowerCase() === "true";

// --- 自适应配额 (AIMD): 上游健康就逐步放宽以用足额度, 撞墙就减半快速避让 ---
const RATE_LIMIT_QUOTA_MAX = parseInt(Deno.env.get("RATE_LIMIT_QUOTA_MAX") || "30", 10);   // 配额上限
const RATE_LIMIT_QUOTA_MIN = parseInt(Deno.env.get("RATE_LIMIT_QUOTA_MIN") || "2", 10);    // 配额下限
const RATE_LIMIT_QUOTA_STEP_AFTER = parseInt(Deno.env.get("RATE_LIMIT_QUOTA_STEP_AFTER") || "3", 10); // 连续成功多少次 +1

// --- 上游并发闸门 (默认单并发) ---
// 上游账号实测为单并发 ("Your account has an active request - only one request at a time"),
// 并发请求注定只能成功一个。默认 1 = 超出即排队, 把并发冲突从"失败"变成"排队"。
// 已知局限: 进程内队列不跨 Deno Deploy 实例 (与 rateLimitMap 同样的局限)。低流量个人
// 网关场景通常只有一个活跃实例; 跨实例协调需 KV/多账号池, 见 docs 讨论。
// 此处【与 RATE_LIMIT_ENABLED 解耦】: 限速开关关掉时并发保护仍应生效 —— 它保护的是
// 上游"同一时刻只能有一个请求"这一物理约束, 与配额策略无关。
const UPSTREAM_MAX_CONCURRENCY = parseInt(Deno.env.get("UPSTREAM_MAX_CONCURRENCY") || "1", 10);
const UPSTREAM_QUEUE_MAX = parseInt(Deno.env.get("UPSTREAM_QUEUE_MAX") || "8", 10);          // 最大排队数, 超出直接 429
const UPSTREAM_QUEUE_WAIT_MS = parseInt(Deno.env.get("UPSTREAM_QUEUE_WAIT_MS") || "30000", 10); // 最长排队等待
// 槽位最长持有时间兜底: 防止流悬挂导致槽位永不释放。取三段超时之和再留余量,
// 保证正常的三段超时永远先于兜底触发 (兜底只兜"连超时都没兜住"的意外)。
const UPSTREAM_SLOT_MAX_HOLD_MS = parseInt(
  Deno.env.get("UPSTREAM_SLOT_MAX_HOLD_MS") ||
    String(UPSTREAM_HEADER_TIMEOUT_MS + UPSTREAM_TOTAL_TIMEOUT_MS + 30_000),
  10,
);

// --- 账号级额度耗尽判定: 短时间内多个不同模型都 1135, 说明不是单模型而是账号额度枯竭 ---
const ACCOUNT_QUOTA_MODELS_THRESHOLD = parseInt(Deno.env.get("ACCOUNT_QUOTA_MODELS_THRESHOLD") || "3", 10);
const ACCOUNT_QUOTA_WINDOW_MS = parseInt(Deno.env.get("ACCOUNT_QUOTA_WINDOW_MS") || "120000", 10);
// 半开探测: 账号冷却期内每隔这么久放行一个请求去试探上游是否已恢复。
// 没有它, 冷却期内所有请求都被拦, 就永远等不到"上游已恢复"的证据, 只能干等到期 ——
// 那就把"惩罚过度"的毛病从模型级搬到了账号级。
const ACCOUNT_PROBE_INTERVAL_MS = parseInt(Deno.env.get("ACCOUNT_PROBE_INTERVAL_MS") || "30000", 10);
// 账号级鉴权故障停投时长: Token 失效不会自己好, 但也不能永久锁死 (运维可能刚换了 Token),
// 故给一个较长但有限的窗口, 期内只放半开探测。
const ACCOUNT_AUTH_FAULT_MS = parseInt(Deno.env.get("ACCOUNT_AUTH_FAULT_MS") || "300000", 10);

// 默认请求模板(基于真实成功的抓包数据)
const DEFAULT_REQUEST_TEMPLATE = {
  "stream": true,
  "cid": "",
  "model": "sider",
  "filter_search_history": false,
  "from": "chat",
  "chat_models": [],
  "think_mode": {"enable": false},
  "quote": null,
  "prompt_templates": [
    {"key": "artifacts", "attributes": {"lang": "original"}}
  ],
  "extra_info": {
    "origin_url": "chrome-extension://dhoenijjpgpeimemopealfcbiecgceod/standalone.html?from=sidebar",
    "origin_title": "Sider"
  },
  "customize_instructions": {"enable": true}
};

// 模型映射配置(扩展版 - 包含更多模型)
const MODEL_MAPPING: Record<string, string> = {
  // GPT 系列
  "gpt-5.4-mini": "gpt-5.4-mini",
  "gpt-5.4-think": "gpt-5.4-think",
  "gpt-5.5": "gpt-5.5",
  "gpt-5.5-think": "gpt-5.5-think",
  "gpt-5.6-sol": "gpt-5.6-sol",
  "gpt-5.6-sol-think": "gpt-5.6-sol-think",
  "gpt-5.6-terra": "gpt-5.6-terra",
  "gpt-5.6-terra-think": "gpt-5.6-terra-think",
  "gpt-5.6-luna": "gpt-5.6-luna",
  "gpt-5.6-luna-think": "gpt-5.6-luna-think",
  "gpt-6-astra": "gpt-6-astra",
  "gpt-6-sol-think": "gpt-6-sol-think",
  "gpt-6-luna-think": "gpt-6-luna-think",
  "gpt-4.1-mini": "gpt-4.1-mini",
  "gpt-6-luna": "gpt-6-luna",
  "gpt-6.1-sol": "gpt-6.1-sol",

  // Claude 系列
  "claude-opus-4.8": "claude-opus-4.8",
  "claude-opus-4.8-think": "claude-opus-4.8-think",
  "claude-opus-5": "claude-opus-5",
  "claude-opus-5-think": "claude-opus-5-think",
  "claude-fable-5.1": "claude-fable-5.1",
  "claude-fable-5.1-think": "claude-fable-5.1-think",
  "claude-sonnet-4.6": "claude-sonnet-4.6",
  "claude-sonnet-4.6-think": "claude-sonnet-4.6-think",
  "claude-sonnet-5": "claude-sonnet-5",
  "claude-sonnet-5-think": "claude-sonnet-5-think",
  "claude-haiku-4.5": "claude-haiku-4.5",
  "claude-haiku-4.5-think": "claude-haiku-4.5-think",
  "claude-haiku-5.5": "claude-haiku-5.5",
  "claude-opus-5.5": "claude-opus-5.5",
  "claude-sonnet-5.5": "claude-sonnet-5.5",

  // Gemini 系列
  "gemini-2.5-pro": "gemini-2.5-pro",
  "gemini-2.5-pro-think": "gemini-2.5-pro-think",
  "gemini-2.5-flash-think": "gemini-2.5-flash-think",
  "gemini-3.0-flash": "gemini-3.0-flash",
  "gemini-3.0-flash-think": "gemini-3.0-flash-think",
  "gemini-3.5-flash": "gemini-3.5-flash",
  "gemini-3.5-flash-think": "gemini-3.5-flash-think",
  "gemini-3.6-flash": "gemini-3.6-flash",
  "gemini-3.6-flash-think": "gemini-3.6-flash-think",
  "gemini-3.8-flash": "gemini-3.8-flash",
  "gemini-3.8-flash-think": "gemini-3.8-flash-think",
  "gemini-3.5-flash-lite": "gemini-3.5-flash-lite",
  "gemini-3.5-flash-lite-think": "gemini-3.5-flash-lite-think",
  "gemini-3.0-pro": "gemini-3.0-pro",
  "gemini-3.1-pro": "gemini-3.1-pro",
  "gemini-3.0-pro-think": "gemini-3.0-pro-think",
  "gemini-3.1-pro-think": "gemini-3.1-pro-think",

  // DeepSeek 系列
  "deepseek-v4-flash": "deepseek-v4-flash",
  "deepseek-v4-flash-think": "deepseek-v4-flash-think",
  "deepseek-v4-pro": "deepseek-v4-pro",
  "deepseek-v4-pro-think": "deepseek-v4-pro-think",
  "deepseek-v3.1": "deepseek-v3.1",
  "deepseek-v3.1-think": "deepseek-v3.1-think",
  "deepseek-reasoner": "deepseek-reasoner",
  "deepseek-v3.2": "deepseek-v3.2",
  "deepseek-v3.2-think": "deepseek-v3.2-think",
  "deepseek-r1-distill-llama-70b": "deepseek-r1-distill-llama-70b",

  // 其他模型
  "grok-4": "grok-4",
  "grok-4.6": "grok-4.6",
  "glm-5": "glm-5",
  "glm-5-think": "glm-5-think",
  "qwen3.8-max": "qwen3.8-max",
  "kimi-k3": "kimi-k3",
  "llama-3.1-405b": "llama-3.1-405b",
  "glm-5.3-flash": "glm-5.3-flash",
  "qwen3.8-max-think": "qwen3.8-max-think",
  "llama-3.3-70b": "llama-3.3-70b",
  "llama-3": "llama-3",

  // 默认智能路由
  "sider": "sider"
};

// 模型创建时间 (Unix 时间戳 - 使用 2024-01-01 作为基准)
const MODEL_CREATED_TIMESTAMP = 1704067200;

// 支持的模型列表 (完全兼容 OpenAI API 格式)
const MODELS = Object.keys(MODEL_MAPPING).map(modelId => ({
  id: modelId,
  object: "model",
  created: MODEL_CREATED_TIMESTAMP,
  owned_by: "sider",
  permission: [
    {
      id: `modelperm-${modelId}`,
      object: "model_permission",
      created: MODEL_CREATED_TIMESTAMP,
      allow_create_engine: false,
      allow_sampling: true,
      allow_logprobs: true,
      allow_search_indices: false,
      allow_view: true,
      allow_fine_tuning: false,
      organization: "*",
      group: null,
      is_blocking: false
    }
  ],
  root: modelId,
  parent: null
}));

// 会话存储(用于多轮对话)
interface ConversationSession {
  cid: string;
  parent_message_id: string;
  created_at: number;
  last_used: number;
}

const conversationSessions = new Map<string, ConversationSession>();

// 会话清理(保留1小时内的会话)
function cleanupOldSessions() {
  const now = Date.now();
  const oneHour = 3600000;

  for (const [sessionId, session] of conversationSessions.entries()) {
    if (now - session.last_used > oneHour) {
      conversationSessions.delete(sessionId);
      console.log(`🗑️ 清理过期会话: ${sessionId}`);
    }
  }
}

// 定期清理(每30分钟)
setInterval(cleanupOldSessions, 1800000);

// ==================== 自定义模型映射存储 ====================

interface CustomModel {
  id: string;
  model: string;
  description?: string;
}

// 自定义模型存储(内存中,重启后丢失)
const customModels = new Map<string, CustomModel>();

// 从文件加载自定义模型(如果存在) - 仅在本地环境可用
async function loadCustomModels() {
  try {
    // 检查是否在 Deno Deploy 环境
    const isDeployEnv = Deno.env.get("DENO_DEPLOYMENT_ID") !== undefined;

    if (isDeployEnv) {
      console.log("☁️ 运行在 Deno Deploy 环境，跳过文件加载");
      // 可以从环境变量加载预配置的模型
      loadModelsFromEnv();
      return;
    }

    const data = await Deno.readTextFile("./custom_models.json");
    const models: CustomModel[] = JSON.parse(data);
    models.forEach(model => {
      customModels.set(model.id, model);
      // 也添加到 MODEL_MAPPING 中
      MODEL_MAPPING[model.id] = model.model;
    });
    console.log(`📦 加载了 ${models.length} 个自定义模型`);
  } catch (error) {
    // 文件不存在或读取失败,忽略
    console.log("ℹ️ 未找到自定义模型配置文件");
  }
}

// 从环境变量加载预配置的模型
function loadModelsFromEnv() {
  const customModelsEnv = Deno.env.get("CUSTOM_MODELS");
  if (!customModelsEnv) return;

  try {
    const models: CustomModel[] = JSON.parse(customModelsEnv);
    models.forEach(model => {
      customModels.set(model.id, model);
      MODEL_MAPPING[model.id] = model.model;
    });
    console.log(`📦 从环境变量加载了 ${models.length} 个自定义模型`);
  } catch (error) {
    console.error("❌ 解析 CUSTOM_MODELS 环境变量失败:", error);
  }
}

// 保存自定义模型到文件 - 仅在本地环境可用
async function saveCustomModels() {
  try {
    // 检查是否在 Deno Deploy 环境
    const isDeployEnv = Deno.env.get("DENO_DEPLOYMENT_ID") !== undefined;

    if (isDeployEnv) {
      console.log("☁️ Deno Deploy 环境：自定义模型仅存储在内存中");
      return;
    }

    const models = Array.from(customModels.values());
    await Deno.writeTextFile("./custom_models.json", JSON.stringify(models, null, 2));
    console.log(`💾 保存了 ${models.length} 个自定义模型`);
  } catch (error) {
    console.error("❌ 保存自定义模型失败:", error);
  }
}

// 获取所有模型(内置+自定义)
function getAllModels() {
  const builtInModels = Object.keys(MODEL_MAPPING)
    .filter(id => !customModels.has(id))
    .map(id => ({
      id,
      model: MODEL_MAPPING[id],
      name: MODEL_MAPPING[id]
    }));

  const customModelsList = Array.from(customModels.values());

  return {
    builtIn: builtInModels,
    custom: customModelsList
  };
}

// 添加自定义模型
function addCustomModel(model: CustomModel): void {
  customModels.set(model.id, model);
  MODEL_MAPPING[model.id] = model.model;
  saveCustomModels();
}

// 更新自定义模型
function updateCustomModel(model: CustomModel): void {
  if (!customModels.has(model.id)) {
    throw new Error(`模型 ${model.id} 不存在`);
  }
  customModels.set(model.id, model);
  MODEL_MAPPING[model.id] = model.model;
  saveCustomModels();
}

// 删除自定义模型
function deleteCustomModel(modelId: string): void {
  if (!customModels.has(modelId)) {
    throw new Error(`模型 ${modelId} 不存在`);
  }
  customModels.delete(modelId);
  delete MODEL_MAPPING[modelId];
  saveCustomModels();
}

// ==================== 工具函数 ====================

// 估算文本词数：中日韩字符各计 1 词，其余按空白分词。
// 用于防止触发 Sider code:603 "Too many words" 限制。
function estimateWordCount(text: string): number {
  const cjkChars = (text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  const otherWords = text.replace(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, " ")
    .trim().split(/\s+/).filter(Boolean).length;
  return cjkChars + otherWords;
}

// 估算 token 数：CJK 每字约 1 token，其余按 4 字符约 1 token。
function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  const rest = text.replace(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, "").length;
  return cjk + Math.ceil(rest / 4);
}

type OutputStopReason = "end_turn" | "max_tokens" | "stop_sequence";

interface OutputLimitOptions {
  maxTokens?: number;
  stopSequences?: string[];
}

interface OutputLimitResult {
  text: string;
  stopReason: OutputStopReason;
  stopSequence?: string;
}

function normalizePositiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

function normalizeStopSequences(value: unknown): string[] | undefined {
  const list = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  const normalized = list.filter((s): s is string => typeof s === "string" && s.length > 0);
  return normalized.length > 0 ? normalized : undefined;
}

function openAIOutputLimits(body: any): OutputLimitOptions {
  return {
    maxTokens: normalizePositiveInt(body?.max_tokens ?? body?.max_completion_tokens),
    stopSequences: normalizeStopSequences(body?.stop),
  };
}

function anthropicOutputLimits(body: any): OutputLimitOptions {
  return {
    maxTokens: normalizePositiveInt(body?.max_tokens),
    stopSequences: normalizeStopSequences(body?.stop_sequences),
  };
}

function geminiOutputLimits(body: any): OutputLimitOptions {
  return {
    maxTokens: normalizePositiveInt(body?.generationConfig?.maxOutputTokens),
    stopSequences: normalizeStopSequences(body?.generationConfig?.stopSequences),
  };
}

function responsesOutputLimits(body: any): OutputLimitOptions {
  return {
    maxTokens: normalizePositiveInt(body?.max_output_tokens),
    stopSequences: normalizeStopSequences(body?.stop),
  };
}

function truncateToTokenLimit(text: string, maxTokens?: number): { text: string; truncated: boolean } {
  if (!maxTokens || estimateTokens(text) <= maxTokens) {
    return { text, truncated: false };
  }

  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTokens(text.slice(0, mid)) <= maxTokens) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return { text: text.slice(0, lo), truncated: true };
}

function applyOutputLimits(text: string, opts: OutputLimitOptions): OutputLimitResult {
  let cut = -1;
  let matched: string | undefined;
  for (const seq of opts.stopSequences ?? []) {
    const i = text.indexOf(seq);
    if (i !== -1 && (cut === -1 || i < cut)) {
      cut = i;
      matched = seq;
    }
  }

  const beforeStop = cut === -1 ? text : text.slice(0, cut);
  const limited = truncateToTokenLimit(beforeStop, opts.maxTokens);
  if (limited.truncated) {
    return { text: limited.text, stopReason: "max_tokens" };
  }
  if (matched !== undefined) {
    return { text: beforeStop, stopReason: "stop_sequence", stopSequence: matched };
  }
  return { text, stopReason: "end_turn" };
}

function createStreamingOutputLimiter(opts: OutputLimitOptions) {
  const stopSequences = opts.stopSequences ?? [];
  const holdback = Math.max(0, ...stopSequences.map(s => s.length - 1));
  let emitted = "";
  let buffer = "";
  let done = false;

  const emitWithMax = (candidate: string): { text: string; done: boolean; stopReason?: OutputStopReason } => {
    const limited = truncateToTokenLimit(emitted + candidate, opts.maxTokens);
    if (limited.truncated) {
      const text = limited.text.slice(emitted.length);
      emitted = limited.text;
      done = true;
      buffer = "";
      return { text, done: true, stopReason: "max_tokens" };
    }
    emitted += candidate;
    return { text: candidate, done: false };
  };

  const push = (chunk: string): { text: string; done: boolean; stopReason?: OutputStopReason; stopSequence?: string } => {
    if (done || !chunk) return { text: "", done };
    buffer += chunk;

    let cut = -1;
    let matched: string | undefined;
    for (const seq of stopSequences) {
      const i = buffer.indexOf(seq);
      if (i !== -1 && (cut === -1 || i < cut)) {
        cut = i;
        matched = seq;
      }
    }

    if (cut !== -1) {
      const limited = emitWithMax(buffer.slice(0, cut));
      if (limited.done) return limited;
      done = true;
      buffer = "";
      return { text: limited.text, done: true, stopReason: "stop_sequence", stopSequence: matched };
    }

    const safeLength = Math.max(0, buffer.length - holdback);
    if (safeLength === 0) return { text: "", done: false };
    const safe = buffer.slice(0, safeLength);
    buffer = buffer.slice(safeLength);
    return emitWithMax(safe);
  };

  const flush = (): { text: string; stopReason: OutputStopReason } => {
    if (done) return { text: "", stopReason: "end_turn" };
    const limited = emitWithMax(buffer);
    buffer = "";
    if (limited.done) return { text: limited.text, stopReason: "max_tokens" };
    done = true;
    return { text: limited.text, stopReason: "end_turn" };
  };

  return { push, flush, get done() { return done; } };
}

function openAIFinishReason(reason: OutputStopReason): "stop" | "length" {
  return reason === "max_tokens" ? "length" : "stop";
}

function geminiFinishReason(reason: OutputStopReason): "STOP" | "MAX_TOKENS" {
  return reason === "max_tokens" ? "MAX_TOKENS" : "STOP";
}

// ==================== 统一上游错误分类与协议化渲染 ====================
// 上游错误有两条来源: ① HTTP 非 2xx; ② HTTP 200 但 SSE 顶层 code 非 0。
// 此前这两条路径各写一套翻译, 同一个 code 在不同端点落到不同 HTTP 状态与不同结构,
// 且 429 常常没有 Retry-After。这里收口为两步:
//   classifyXxx()            -> UpstreamErrorDetail (与协议无关)
//   protocolErrorResponse()  -> 各协议原生错误结构 (+ 所有 429/503 都带 Retry-After)
type ApiProtocol = "openai" | "responses" | "anthropic" | "gemini";

interface UpstreamErrorDetail {
  statusCode: number;
  /** 统一错误类型 (与协议无关), 由 renderer 决定落到各协议的哪个字段。 */
  type: string;
  message: string;
  /** 建议等待秒数; 429/503 出口必须据此回填 Retry-After 响应头。 */
  retryAfterSec?: number;
  /** 上游业务码 (来自 SSE 顶层 code 或 HTTP body 里的 code)。 */
  upstreamCode?: number;
  /** 机器可读的原因标记 (如 vision_not_supported / tools_not_supported)。 */
  reason?: string;
  /** 相关模型名; 本地门控拒绝时回填, 便于调用方定位是哪个模型撞了限额。 */
  model?: string;
  /** OpenAI 错误结构里的 param 字段 (指出是哪个入参有问题)。 */
  param?: string;
  /** 账号级鉴权故障 (1001/401/403): 影响全部模型, 需进入账号级故障态。 */
  accountAuthFault?: boolean;
}

/**
 * 由上游【业务码】分类。SSE 顶层 code 与 HTTP body 内的 code 共用这一条路径,
 * 保证同一 code 在四个端点上落到同一个语义。
 * @param fallbackMs 上游未告知时长时的兜底等待毫秒 (1135 用模型级兜底值)
 */
function classifyUpstreamError(code: number, msg = "", fallbackMs = RATE_LIMIT_BREAKER_MS): UpstreamErrorDetail {
  switch (code) {
    case 603:
      // 载荷过大 (词数超限): 是调用方的问题, 不该惩罚上游, 不触发熔断
      return {
        statusCode: 400,
        type: "context_length_exceeded",
        upstreamCode: code,
        message: msg || "请求内容超出上游词数上限, 请缩短 prompt 或缩减对话历史。",
      };
    case 1101: {
      // 瞬时并发冲突: 上游通常几秒内自愈, 只给短 Retry-After, 不做长熔断
      const parsed = parseUpstreamRetryMs(msg);
      const retryAfterSec = Math.min(5, Math.max(1, parsed !== null ? Math.round(parsed / 1000) : 2));
      return {
        statusCode: 429,
        type: "rate_limit_error",
        upstreamCode: code,
        retryAfterSec,
        message: msg || "上游并发/限流, 请稍后重试。",
      };
    }
    case 1135: {
      // 额度耗尽: 优先按上游消息里明说的时长 (如 "try again after 117 minutes")
      const parsed = parseUpstreamRetryMs(msg);
      return {
        statusCode: 429,
        type: "rate_limit_error",
        upstreamCode: code,
        retryAfterSec: Math.max(1, Math.round((parsed ?? fallbackMs) / 1000)),
        message: msg || "上游模型使用额度已达上限, 请稍后重试。",
      };
    }
    case 707:
      return {
        statusCode: 503,
        type: "upstream_unavailable",
        upstreamCode: code,
        retryAfterSec: 300,
        message: msg || "上游暂时不可用, 请稍后重试。",
      };
    case 1001:
      return {
        statusCode: 401,
        type: "auth_error",
        upstreamCode: code,
        accountAuthFault: true,
        message: msg || "上游 Token 无效或已过期。",
      };
    default:
      return {
        statusCode: 502,
        type: "upstream_error",
        upstreamCode: code,
        message: msg || `上游错误 code=${code}`,
      };
  }
}

/** 由 HTTP 状态码分类 (响应体里没有业务码时的兜底)。 */
function classifyUpstreamHttpStatus(status: number, msg = ""): UpstreamErrorDetail {
  if (status === 401 || status === 403) {
    return {
      statusCode: 401,
      type: "auth_error",
      accountAuthFault: true,
      message: msg || "上游鉴权失败 (Token 无效或已过期)。",
    };
  }
  if (status === 404) {
    return { statusCode: 404, type: "not_found_error", message: msg || "上游接口不存在。" };
  }
  if (status === 429) {
    return { statusCode: 429, type: "rate_limit_error", retryAfterSec: 5, message: msg || "上游限流, 请稍后重试。" };
  }
  if (status === 408) {
    return { statusCode: 504, type: "timeout_error", retryAfterSec: 1, message: msg || "上游请求超时。" };
  }
  if (status >= 500) {
    return { statusCode: 502, type: "upstream_error", message: msg || `上游服务错误 (HTTP ${status})。` };
  }
  return { statusCode: 502, type: "upstream_error", message: msg || `上游返回 HTTP ${status}。` };
}

/** 尽力从上游 HTTP 错误响应体里抽出业务码与消息 (JSON 优先, 纯文本截断兜底)。 */
function parseUpstreamErrorBody(raw: string): { code?: number; msg: string } {
  const text = (raw || "").trim();
  if (!text) return { msg: "" };
  if (!text.startsWith("{") && !text.startsWith("[")) {
    return { msg: text.slice(0, 200) };
  }
  try {
    const parsed = JSON.parse(text);
    const rawCode = parsed?.code ?? parsed?.error?.code;
    const code = typeof rawCode === "number" ? rawCode : Number(rawCode);
    return {
      code: Number.isFinite(code) ? code : undefined,
      msg: String(parsed?.msg ?? parsed?.message ?? parsed?.error?.message ?? "").slice(0, 400),
    };
  } catch {
    return { msg: text.slice(0, 200) };
  }
}

/** 由 HTTP 错误响应分类: 优先用响应体里的业务码, 否则回退到 HTTP 状态码。 */
function classifyUpstreamHttpError(status: number, raw: string): UpstreamErrorDetail {
  const { code, msg } = parseUpstreamErrorBody(raw);
  if (code !== undefined && code !== 0) return classifyUpstreamError(code, msg);
  return classifyUpstreamHttpStatus(status, msg);
}

// 统一类型 -> Anthropic 错误类型枚举 (Anthropic 只认这几个, 不能自造)
function anthropicErrorType(detail: UpstreamErrorDetail): string {
  switch (detail.type) {
    case "rate_limit_error": return "rate_limit_error";
    case "auth_error": return "authentication_error";
    case "invalid_request_error": return "invalid_request_error";
    case "context_length_exceeded": return "invalid_request_error";
    case "not_found_error": return "not_found_error";
    case "upstream_unavailable": return "overloaded_error";
    case "not_supported": return "invalid_request_error";
    default: return "api_error";
  }
}

// 统一类型 -> Gemini (google.rpc) 状态枚举
function geminiErrorStatus(detail: UpstreamErrorDetail): string {
  switch (detail.statusCode) {
    case 400: return "INVALID_ARGUMENT";
    case 401: return "UNAUTHENTICATED";
    case 403: return "PERMISSION_DENIED";
    case 404: return "NOT_FOUND";
    case 422: return "INVALID_ARGUMENT";
    case 429: return "RESOURCE_EXHAUSTED";
    case 500: return "INTERNAL";
    case 504: return "DEADLINE_EXCEEDED";
    default: return "UNAVAILABLE";
  }
}

/**
 * 把统一错误详情渲染成指定协议的原生错误响应。
 * 所有带 retryAfterSec 的出口都回填 Retry-After 头 —— 客户端要能知道"等多久再来"。
 */
/** 统一错误详情 -> 各协议原生错误【载荷】。流式路径需要把错误嵌进 SSE 事件, 故单独抽出。 */
function protocolErrorPayload(protocol: ApiProtocol, detail: UpstreamErrorDetail): unknown {
  if (protocol === "anthropic") {
    return {
      type: "error",
      error: {
        type: anthropicErrorType(detail),
        message: detail.message,
        code: detail.reason ?? detail.type,
        ...(detail.model !== undefined ? { model: detail.model } : {}),
        ...(detail.upstreamCode !== undefined ? { upstream_code: detail.upstreamCode } : {}),
      },
    };
  }
  if (protocol === "gemini") {
    return {
      error: {
        code: detail.statusCode,
        message: detail.message,
        status: geminiErrorStatus(detail),
        details: [{
          reason: detail.reason ?? detail.type,
          ...(detail.model !== undefined ? { model: detail.model } : {}),
          ...(detail.upstreamCode !== undefined ? { upstreamCode: detail.upstreamCode } : {}),
        }],
      },
    };
  }
  // OpenAI Chat Completions 与 Responses 共用 OpenAI 风格错误结构
  return {
    error: {
      message: detail.message,
      type: detail.type,
      ...(detail.param !== undefined ? { param: detail.param } : {}),
      ...(detail.reason !== undefined ? { code: detail.reason } : {}),
      ...(detail.model !== undefined ? { model: detail.model } : {}),
      ...(detail.upstreamCode !== undefined ? { upstream_code: detail.upstreamCode } : {}),
    },
  };
}

function protocolErrorResponse(
  protocol: ApiProtocol,
  detail: UpstreamErrorDetail,
  extraHeaders: Record<string, string> = {},
): Response {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    ...extraHeaders,
  };
  if (detail.retryAfterSec !== undefined) {
    headers["Retry-After"] = String(Math.max(1, Math.round(detail.retryAfterSec)));
  }

  return new Response(JSON.stringify(protocolErrorPayload(protocol, detail)), {
    status: detail.statusCode,
    headers,
  });
}

// 检测是否为图像生成请求
function isImageGenerationRequest(prompt: string): boolean {
  const imageKeywords = [
    /画|绘制|生成.*图|图片|图像/i,
    /draw|paint|generate.*image|create.*image|picture/i,
    /dall-e|midjourney|stable\s*diffusion/i
  ];
  return imageKeywords.some(pattern => pattern.test(prompt));
}

// 检测图像质量需求
// 合法枚举 (经上游探针确认): nano_banana / nano_banana_2 / nano_banana_pro
// 非法值 nano_banana_lite 已移除 (上游返回 code:1000 "QualityLevel must be one of [...]")
function detectImageQuality(prompt: string): string {
  if (/4k|高清|ultra|hd|高质量|pro/i.test(prompt)) return "nano_banana_pro";
  if (/快速|draft|sketch|草稿|lite|低质量/i.test(prompt)) return "nano_banana_2";
  return "nano_banana"; // 默认标准质量
}

// 检测请求是否包含视觉输入 (图像) 块。
// 能力门控 (CLAUDE.md): 经 test/probe_vision.py 探针确认上游不支持视觉输入,
// 收到图像应返回标准 not_supported, 不静默丢弃让上游幻觉。
// 兼容 OpenAI (image_url) / Anthropic (image source) / Gemini (inline_data/file_data)。
function detectVisionInput(messages: any[]): boolean {
  for (const m of (messages || [])) {
    const c = m?.content;
    if (!Array.isArray(c)) continue;
    for (const part of c) {
      if (!part || typeof part !== "object") continue;
      const t = part.type;
      if (t === "image_url" || t === "image" || t === "input_image") return true;
      // Anthropic: {type:"image", source:{...}}; Gemini: {inline_data}/{file_data}
      if (part.source && (part.source.type === "base64" || part.source.type === "url")) return true;
      if (part.inline_data || part.inlineData || part.file_data || part.fileData) return true;
    }
  }
  return false;
}

// 标准化 not_supported 错误响应 (能力门控统一出口): HTTP 422 + 该协议的原生错误结构。
// 机器可读标记放在 reason 里 (OpenAI/Responses/Anthropic -> error.code, Gemini ->
// error.details[0].reason), 调用方不必解析自然语言消息就能判别能力缺失。
function notSupportedResponse(protocol: ApiProtocol, message: string, reason = "not_supported"): Response {
  return protocolErrorResponse(protocol, {
    statusCode: 422,
    type: "not_supported",
    message,
    reason,
  });
}

// 检测是否启用 Think 模式
function shouldEnableThinkMode(modelName: string): boolean {
  return modelName.includes("-think");
}

// Decide whether to enable upstream auto-search for this prompt.
// Default is OFF (reduces TTFT/long-tail), but can be enabled globally or by keyword.
function shouldEnableAutoSearch(prompt: string): boolean {
  if (ENABLE_AUTO_SEARCH) return true;
  return /\b(search|查一下|查询|搜索|找一下|最新|新闻|link|citation|来源)\b/i.test(prompt);
}

// ==================== 用量统计 (stats, 参考 sider2claude usage-stats) ====================

// 用量统计: 进程内聚合 + 可选 Deno KV 持久层 (STATS_KV 门控)。
// 未设置 STATS_KV 时行为与纯进程内完全一致 (默认); 设 STATS_KV=kv 在 Deno Deploy
// 关联平台 KV 跨实例/跨重启累计, STATS_KV=memory 本地测试 (重启清零, 不落文件)。
// Token 以字符数估算 (上游 Sider 流式不回传真实 usage, 沿用现有字符估算口径)。
// 采集点覆盖: OpenAI chat / 图像生成 / Gemini / Anthropic / Responses 全部端点。

interface UsageRecord {
  model: string;
  stream: boolean;
  ms: number;
  toolUses: string[];
  inputChars: number;
  outputChars: number;
}

interface ModelStatRow {
  model: string;
  requests: number;
  /** 该模型的请求失败次数 (上游错误/能力门控/异常出口)。 */
  failures: number;
  inputChars: number;
  outputChars: number;
  totalChars: number;
}

interface TrendBucketRow {
  at: string;
  requests: number;
  streaming: number;
  toolCalls: number;
  /** 该桶内调用失败次数 (上游错误/能力门控/异常)。 */
  failures: number;
  inputChars: number;
  outputChars: number;
}

interface StatsSnapshot {
  since: string;
  totals: {
    requests: number;
    streaming: number;
    toolCalls: number;
    inputChars: number;
    outputChars: number;
  };
  models: ModelStatRow[];
  tools: Array<{ name: string; count: number }>;
  trend: TrendBucketRow[];
  recent: Array<{
    time: string;
    model: string;
    stream: boolean;
    tools: string[];
    ms: number;
    chars: number;
  }>;
  note: string;
  /** 聚合数据是否来自 KV 持久层 (跨实例); false 表示仅当前进程。 */
  persisted: boolean;
}

// 最近明细保留上限(每条约 200 字节); 对外展示条数; 滑动窗口与趋势分桶
const STATS_RECENT_LIMIT = 200;
const STATS_RECENT_DISPLAY = 10;
const STATS_BUCKET_MS = 60 * 60_000; // 1 小时桶 = 近 24 小时趋势
const STATS_BUCKET_COUNT = 24;

const statsRecent: Array<{ at: number; record: UsageRecord }> = [];
// 失败事件时间戳 (供 24h 模型分布的失败计数; 与 recent 同上限, 新在前)
const statsFailureRecent: Array<{ at: number; model: string }> = [];

// 每次请求完成时调用 (fire-and-forget 语义: 不抛错、不阻塞响应路径)
function recordUsage(record: UsageRecord): void {
  statsRecent.unshift({ at: Date.now(), record });
  if (statsRecent.length > STATS_RECENT_LIMIT) {
    statsRecent.length = STATS_RECENT_LIMIT;
  }

  persistUsage(record); // fire-and-forget; KV 未启用时内部直接返回
}

// 记录一次失败的请求 (上游错误/能力门控/异常出口)。
// 单独函数: 失败路径没有完整的 UsageRecord (无 token/工具信息), 只关心模型维度计数。
// 失败事件带时间戳入队, 供 24h 窗口的模型分布失败计数。
function recordFailure(model: string): void {
  statsFailureRecent.unshift({ at: Date.now(), model });
  if (statsFailureRecent.length > STATS_RECENT_LIMIT) {
    statsFailureRecent.length = STATS_RECENT_LIMIT;
  }

  persistFailure(model); // fire-and-forget; KV 未启用时内部直接返回
}

type StatsTotals = StatsSnapshot["totals"];

function emptyStatsTotals(): StatsTotals {
  return { requests: 0, streaming: 0, toolCalls: 0, inputChars: 0, outputChars: 0 };
}

function totalsFromTrend(trend: TrendBucketRow[]): StatsTotals {
  return trend.reduce((totals, bucket) => {
    totals.requests += bucket.requests;
    totals.streaming += bucket.streaming;
    totals.toolCalls += bucket.toolCalls;
    totals.inputChars += bucket.inputChars;
    totals.outputChars += bucket.outputChars;
    return totals;
  }, emptyStatsTotals());
}

// 近 24 小时按小时分桶; 空桶保留保证时间轴连续。
// 数据源是 recent(200 条上限), 高流量下早期桶会偏低; KV 模式用小时桶聚合保持跨实例一致。
function buildStatsTrend(now: number): TrendBucketRow[] {
  const currentBucket = Math.floor(now / STATS_BUCKET_MS) * STATS_BUCKET_MS;
  const buckets = new Map<number, TrendBucketRow>();
  for (let i = STATS_BUCKET_COUNT - 1; i >= 0; i -= 1) {
    const at = currentBucket - i * STATS_BUCKET_MS;
    buckets.set(at, {
      at: new Date(at).toISOString(),
      requests: 0,
      streaming: 0,
      toolCalls: 0,
      failures: 0,
      inputChars: 0,
      outputChars: 0,
    });
  }
  for (const { at, record } of statsRecent) {
    const key = Math.floor(at / STATS_BUCKET_MS) * STATS_BUCKET_MS;
    const bucket = buckets.get(key);
    if (!bucket) continue; // 落在 24 小时窗口外
    bucket.requests += 1;
    if (record.stream) bucket.streaming += 1;
    bucket.toolCalls += record.toolUses.length;
    bucket.inputChars += record.inputChars;
    bucket.outputChars += record.outputChars;
  }
  return [...buckets.values()];
}

// 近 24 小时窗口的模型分布聚合 (进程内)。
// 数据源: statsRecent (带时间戳的请求记录) + statsFailureRecent (带时间戳的失败事件)。
// 与 buildStatsTrend 同口径: 只统计 24 小时窗口内的记录, 窗口外忽略。
function buildStatsModels(now: number): ModelStatRow[] {
  const cutoff = now - STATS_BUCKET_MS * STATS_BUCKET_COUNT;
  const map = new Map<string, ModelStatRow>();

  // 请求记录 (成功路径: requests/inputChars/outputChars/totalChars)
  for (const { at, record } of statsRecent) {
    if (at < cutoff) continue; // 落在 24 小时窗口外
    let row = map.get(record.model);
    if (!row) {
      row = { model: record.model, requests: 0, failures: 0, inputChars: 0, outputChars: 0, totalChars: 0 };
      map.set(record.model, row);
    }
    row.requests += 1;
    row.inputChars += record.inputChars;
    row.outputChars += record.outputChars;
    row.totalChars += record.inputChars + record.outputChars;
  }

  // 失败事件 (失败路径: failures 计数)
  for (const { at, model } of statsFailureRecent) {
    if (at < cutoff) continue; // 落在 24 小时窗口外
    let row = map.get(model);
    if (!row) {
      row = { model, requests: 0, failures: 0, inputChars: 0, outputChars: 0, totalChars: 0 };
      map.set(model, row);
    }
    row.failures += 1;
  }

  return [...map.values()].sort((a, b) => b.requests - a.requests);
}

// 近 24 小时窗口的工具调用频次 (进程内)。历史累计工具名不直接展示,
// 避免旧的 create_image 记录被误读为当前仍在持续调用图像工具。
function buildStatsTools(now: number): Array<{ name: string; count: number }> {
  const cutoff = now - STATS_BUCKET_MS * STATS_BUCKET_COUNT;
  const map = new Map<string, number>();
  for (const { at, record } of statsRecent) {
    if (at < cutoff) continue;
    for (const name of record.toolUses) {
      map.set(name, (map.get(name) ?? 0) + 1);
    }
  }
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, count]) => ({ name, count }));
}

// 生成统计快照 (供 /stats 页面与 /stats.json 使用)
function getStatsSnapshot(now = Date.now()): StatsSnapshot {
  const models = buildStatsModels(now);
  const trend = buildStatsTrend(now);

  return {
    since: trend[0]?.at ?? new Date(now - STATS_BUCKET_MS * (STATS_BUCKET_COUNT - 1)).toISOString(),
    totals: totalsFromTrend(trend),
    models,
    tools: buildStatsTools(now),
    trend,
    recent: statsRecent.slice(0, STATS_RECENT_DISPLAY).map(({ at, record }) => ({
      time: new Date(at).toISOString(),
      model: record.model,
      stream: record.stream,
      tools: record.toolUses,
      ms: record.ms,
      chars: record.inputChars + record.outputChars,
    })),
    note: "所有统计指标均为近 24 小时窗口值。进程内模式仅代表当前实例; 实例重启后清零。Token 以字符数估算 (上游流式不回传真实 usage)。",
    persisted: false,
  };
}

// ==================== 用量统计 - Deno KV 持久层 (STATS_KV 门控) ====================

// 参考 sider2claude usage-stats-kv.ts: 只存聚合 (数值), 不存明细——recent 明细留在进程内。
// 每请求的全部增量编码成一次 atomic commit (多个 sum mutation), fire-and-forget 执行,
// 不阻塞响应路径; 任何失败静默降级为纯进程内统计。
//
// 模式选择 (STATS_KV 环境变量):
// - "kv": 默认 openKv()。在 Deno Deploy 上连接平台分配的数据库 (需先在后台 Provision 并关联本应用)。
// - "memory": openKv(":memory:"), 行为与纯进程内一致 (重启清零, 不落文件), 本地可测试全链路。
// - 未设置 / 其他: 完全跳过, 行为同纯进程内 (默认)。
//
// ⚠️ 命名空间解耦 (与 sider2claude 共用 KV 时的关键约束):
// sider2claude 的 usage-stats-kv 把所有键放在 ["stats", ...] 前缀下, 并用
// kv.list({ prefix: ["stats"] }) 全量扫描聚合。sider2pro 若也用 ["stats", ...],
// 两者共用同一 KV 库时会互相把对方的键当自己的统计解析、数据互相污染。
// 因此这里所有键都带顶层命名空间 [STATS_KV_ROOT, "stats", ...]:
//   - 默认 STATS_KV_ROOT = "sider2pro" → 键形如 ["sider2pro", "stats", ...],
//     与 sider2claude 的 ["stats", ...] 完全隔离, 可安全共用同一 KV 数据库;
//   - 可用环境变量 STATS_KV_ROOT 覆盖 (例如多实例部署时各自独立命名空间)。
//
// ⚠️ Deno 稳定版本地需 --unstable-kv 标志, 因此不用 import type 引用 Deno.Kv 类型,
// 统一用 (Deno as any) 动态调用, 保证 deno check / 普通 deno run 不因未启标志而报错。
// Deno Deploy 平台默认开放 unstable API。

const STATS_KV_BUCKET_MS = 60 * 60_000; // 1 小时桶
// 模型分布、工具频次、顶部总量与趋势图同窗口: 近 24 小时 (24 桶)。KV 里维度键挂在趋势桶下,
// 聚合模型分布时只统计此窗口内的桶 (与进程内 buildStatsModels 口径一致)。
const STATS_KV_MODEL_WINDOW_MS = STATS_BUCKET_COUNT * STATS_KV_BUCKET_MS; // 24h
// 趋势桶保留时长: 页面只展示近 24 小时 (24 桶), 25 小时前的旧桶回收,
// 防止 trend 桶键无限增长拖慢 kv.list 全量扫描。回收是双保险:
//   1) collectPersistentStats 读取时跳过并删除过期桶;
//   2) persistUsage 跨小时桶时触发一次 cleanupStaleTrendKeys (覆盖无人访问场景)。
const STATS_KV_TREND_RETENTION_MS = 25 * 60 * 60_000;
// 上次触发 KV 清理的小时桶 (进程级: 每小时最多清理一次, 多实例重复清理无害)
let lastKvCleanupBucket = 0;
// 顶层命名空间: 与 sider2claude 共用 KV 时保证键完全隔离 (见上注释)
const STATS_KV_ROOT = Deno.env.get("STATS_KV_ROOT") || "sider2pro";
// 统计前缀 = [root, "stats", ...]; 统一入口, 后续键变更只改这里
const statsKvPrefix = () => [STATS_KV_ROOT, "stats"] as const;

let statsKvPromise: Promise<any | null> | null = null;

/** 懒加载 KV。两种模式都走完整写读路径 (memory 与真 KV 代码路径一致)。失败永久降级 null。 */
function getStatsKv(): Promise<any | null> {
  if (!statsKvPromise) {
    statsKvPromise = (async () => {
      try {
        const mode = (Deno.env.get("STATS_KV") ?? "").toLowerCase();
        if (!mode) return null; // 未显式启用
        const kv = mode === "kv"
          ? await (Deno as any).openKv()
          : await (Deno as any).openKv(":memory:");
        // 首次写入时记下统计起点 (check 不存在才写, 重启后才会产生新值)
        const sinceKey = [...statsKvPrefix(), "since"];
        await kv.atomic()
          .check({ key: sinceKey, versionstamp: null })
          .set(sinceKey, Date.now())
          .commit()
          .catch(() => {});
        return kv;
      } catch (error) {
        console.warn("[stats] KV 不可用, 回退纯进程内统计:", {
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    })();
  }
  return statsKvPromise;
}

const statsKvNum = (value: unknown): number =>
  typeof value === "bigint" ? Number(value) : Number(value ?? 0);

/** 把一次请求的增量原子提交到 KV (fire-and-forget, 失败静默)。 */
function persistUsage(record: UsageRecord): void {
  void (async () => {
    const kv = await getStatsKv();
    if (!kv) return;

    const bucket = Math.floor(Date.now() / STATS_KV_BUCKET_MS) * STATS_KV_BUCKET_MS;
    const ops: any[] = [];
    const P = statsKvPrefix();

    const sum = (key: unknown[], n: number) => {
      if (n > 0) ops.push({ key, type: "sum", value: new (Deno as any).KvU64(BigInt(n)) });
    };

    const t = [...P, "trend", bucket];
    sum([...t, "requests"], 1);
    if (record.stream) sum([...t, "streaming"], 1);
    sum([...t, "toolCalls"], record.toolUses.length);
    sum([...t, "inputChars"], record.inputChars);
    sum([...t, "outputChars"], record.outputChars);
    for (const name of record.toolUses) sum([...t, "tool", name], 1);

    // 每小时每模型维度: 供近 24h 模型分布 (跨实例一致, 与趋势同窗口; 键会随趋势桶一起回收)
    const tm = [...P, "trend", bucket, "model", record.model];
    sum([...tm, "requests"], 1);
    sum([...tm, "inputChars"], record.inputChars);
    sum([...tm, "outputChars"], record.outputChars);

    await kv.atomic()
      .mutate(...ops)
      .commit()
      .catch(() => { /* 静默: KV 抖动不影响进程内统计 */ });

    // 双保险之一: 每次请求写入都顺带回收过期趋势桶 (lastKvCleanupBucket 去重为每小时一次,
    // 覆盖长时间无人访问 /stats 页面的场景)
    cleanupStaleTrendKeys(kv);
  })();
}

/** 把一次失败计数持久化到 KV (fire-and-forget, 失败静默)。
 * 键: [root, "stats", "trend", bucket, "model", model, "failures"] — 小时桶内模型维度,
 * 随趋势桶回收, 供近 24h 模型分布的失败计数。
 */
function persistFailure(model: string): void {
  void (async () => {
    const kv = await getStatsKv();
    if (!kv) return;
    const P = statsKvPrefix();
    const bucket = Math.floor(Date.now() / STATS_KV_BUCKET_MS) * STATS_KV_BUCKET_MS;
    // 注意: Deno KV 的 mutate() 接受可变参数, 不能传数组 (会抛 Invalid mutation type)
    const m1 = { key: [...P, "trend", bucket, "model", model, "failures"], type: "sum", value: new (Deno as any).KvU64(1n) };
    const m2 = { key: [...P, "trend", bucket, "failures"], type: "sum", value: new (Deno as any).KvU64(1n) };
    await kv.atomic()
      .mutate(m1, m2)
      .commit()
      .catch(() => { /* 静默 */ });
  })();
}

/**
 * 回收过期趋势桶: 删除保留期 (STATS_KV_TREND_RETENTION_MS) 之前的
 * [root, "stats", "trend", bucket, field] 键, 防止 KV 键无限增长。
 *
 * 触发时机 (双保险):
 *   - collectPersistentStats 读取时顺带清理;
 *   - persistUsage 检测到新小时桶时触发 (覆盖长时间无访问场景)。
 *
 * 进程级 lastKvCleanupBucket 保证每小时最多触发一次清理扫描;
 * Deno Deploy 多实例各自独立触发, 重复删除无害 (KV 删除幂等)。
 */
async function cleanupStaleTrendKeys(kv: any): Promise<void> {
  try {
    const nowBucket = Math.floor(Date.now() / STATS_KV_BUCKET_MS);
    if (lastKvCleanupBucket === nowBucket) return; // 本小时已清理过
    lastKvCleanupBucket = nowBucket;

    const P = statsKvPrefix();
    const cutoff = Date.now() - STATS_KV_TREND_RETENTION_MS;
    const stale: unknown[][] = [];
    for await (const entry of kv.list({ prefix: [...P, "trend"] })) {
      const k = entry.key;
      // 趋势总量键 [.., bucket, field] (len 5)、工具窗口键 [.., bucket, "tool", name] (len 6)
      // 或模型维度键 [.., bucket, "model", model, field] (len 7)
      if (k[1] === "stats" && k[2] === "trend" && (k.length === 5 || k.length === 6 || k.length === 7)) {
        const bucket = Number(k[3]);
        if (bucket < cutoff) stale.push(k);
      }
    }
    if (stale.length === 0) return;
    // 分批删除, 避免单次 atomic 超过 KV 事务上限 (通常 1000 键)
    for (let i = 0; i < stale.length; i += 900) {
      const batch = stale.slice(i, i + 900);
      const ops = batch.map((key) => ({ key, type: "delete" as const }));
      await kv.atomic().mutate(...ops).commit().catch(() => {});
    }
    console.log(`🧹 [stats] KV 清理 ${stale.length} 个过期趋势桶键`);
  } catch {
    // 静默: 清理失败不影响主流程
  }
}

/** KV 持久化的聚合视图; KV 未启用时返回 null (调用方回退进程内)。 */
interface PersistentStats {
  totals: {
    requests: number;
    streaming: number;
    toolCalls: number;
    inputChars: number;
    outputChars: number;
  };
  models: Array<{
    model: string;
    requests: number;
    failures: number;
    inputChars: number;
    outputChars: number;
  }>;
  tools: Array<{ name: string; count: number }>;
  trend: Array<{
    bucket: number;
    requests: number;
    streaming: number;
    toolCalls: number;
    failures: number;
    inputChars: number;
    outputChars: number;
  }>;
}

/** 读取持久化聚合; 带 2s 超时, KV 不可用或超时返回 null。 */
async function readPersistentStats(): Promise<PersistentStats | null> {
  const kv = await getStatsKv();
  if (!kv) return null;

  try {
    const result = await Promise.race([
      collectPersistentStats(kv),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 2_000)),
    ]);
    return result;
  } catch {
    return null;
  }
}

async function collectPersistentStats(kv: any): Promise<PersistentStats | null> {
  const P = statsKvPrefix();
  const totals = emptyStatsTotals();
  // 24h 窗口的模型分布 (从 trend 桶的模型维度键聚合; 与趋势图同窗口口径)
  const models: PersistentStats["models"] = [];
  const toolMap = new Map<string, number>();
  const trend: PersistentStats["trend"] = [];
  // 当前 24h 窗口起点 (ms) — 只聚合窗口内的模型维度桶 (与进程内 buildStatsModels 同口径)
  const modelCutoff = Date.now() - STATS_KV_MODEL_WINDOW_MS;

  // 只扫描本命名空间前缀, 不会读到 sider2claude 的 ["stats", ...] 键
  for await (const entry of kv.list({ prefix: P })) {
    const key = entry.key;
    const value = statsKvNum(entry.value);

    // 键形: [root, "stats", "trend", bucket, field] (趋势总量)
    //       [root, "stats", "trend", bucket, "model", model, field] (模型维度, 供 24h 模型分布)
    // 相对前缀的偏移: key[0]=root, key[1]="stats", key[2]="trend",
    //   bucket 在 key[3], 模型维度标志 "model" 在 key[4], 模型名在 key[5], 字段在 key[6]
    if (key[1] === "stats" && key[2] === "trend" && key[4] === "model" && key.length === 7) {
      // 模型维度键: 只聚合近 24h 窗口的桶 (旧桶随趋势清理已删除, 此处双保险跳过窗口外)
      const bucket = Number(key[3]);
      if (bucket < modelCutoff) continue;
      const model = key[5] as string;
      const field = key[6] as string;
      let row = models.find((m) => m.model === model);
      if (!row) {
        row = { model, requests: 0, failures: 0, inputChars: 0, outputChars: 0 };
        models.push(row);
      }
      if (field === "requests" || field === "failures" || field === "inputChars" || field === "outputChars") {
        (row as unknown as Record<string, number>)[field] += value;
      }
      continue;
    }

    if (key[1] === "stats" && key[2] === "trend" && key.length === 5) {
      const bucket = Number(key[3]);
      if (bucket < modelCutoff) continue;
      const field = key[4] as string;
      let row = trend.find((t) => t.bucket === bucket);
      if (!row) {
        row = { bucket, requests: 0, streaming: 0, toolCalls: 0, failures: 0, inputChars: 0, outputChars: 0 };
        trend.push(row);
      }
      if (field === "requests" || field === "streaming" || field === "toolCalls" ||
          field === "failures" || field === "inputChars" || field === "outputChars") {
        (row as unknown as Record<string, number>)[field] += value;
        if (field in totals) {
          (totals as unknown as Record<string, number>)[field] += value;
        }
      }
      continue;
    }

    if (key[1] === "stats" && key[2] === "trend" && key[4] === "tool" && key.length === 6) {
      // 工具频次与模型分布/趋势同口径: 只聚合近 24h 窗口。
      const bucket = Number(key[3]);
      if (bucket < modelCutoff) continue;
      const name = key[5] as string;
      toolMap.set(name, (toolMap.get(name) ?? 0) + value);
      continue;
    }

    if (key[1] === "stats" && key[2] === "tool" && key.length === 4) {
      // 旧版累计工具名保留在 KV 中, 但页面不再直接展示它,
      // 避免历史 create_image 记录被误读为近 24 小时仍在调用。
      continue;
    }

    if (key[1] === "stats" && key.length === 3 && key[2] !== "since") {
      // 旧版累计总量键保留在 KV 中, 但 /stats 统一展示近 24 小时窗口值。
      continue;
    }
  }

  models.sort((a, b) => b.requests - a.requests);
  const tools = [...toolMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, count]) => ({ name, count }));
  tools.sort((a, b) => b.count - a.count);
  trend.sort((a, b) => a.bucket - b.bucket);

  return {
    totals,
    models,
    tools,
    trend,
  };
}

/**
 * 合并快照: 聚合取 KV 持久层 (跨实例、跨重启), 明细与最近窗口取进程内。
 * KV 未启用 / 不可用 / 读取超时 (内部 2s) 时退回纯进程内快照。
 * `/stats`、`/stats.json` 都应使用本函数。
 */
async function getStatsSnapshotMerged(now = Date.now()): Promise<StatsSnapshot> {
  const local = getStatsSnapshot(now);
  const persistent = await readPersistentStats();
  if (!persistent) {
    return local;
  }

  // 近 24 个小时桶, 空桶保留 (KV 里可能还没有这些桶的 key)
  const currentBucket = Math.floor(now / STATS_KV_BUCKET_MS) * STATS_KV_BUCKET_MS;
  const byBucket = new Map(persistent.trend.map((t) => [t.bucket, t]));
  const trend: TrendBucketRow[] = [];
  for (let i = STATS_BUCKET_COUNT - 1; i >= 0; i -= 1) {
    const at = currentBucket - i * STATS_KV_BUCKET_MS;
    const row = byBucket.get(at);
    trend.push({
      at: new Date(at).toISOString(),
      requests: row?.requests ?? 0,
      streaming: row?.streaming ?? 0,
      toolCalls: row?.toolCalls ?? 0,
      failures: row?.failures ?? 0,
      inputChars: row?.inputChars ?? 0,
      outputChars: row?.outputChars ?? 0,
    });
  }

  return {
    ...local,
    since: trend[0]?.at ?? new Date(now - STATS_KV_BUCKET_MS * (STATS_BUCKET_COUNT - 1)).toISOString(),
    totals: totalsFromTrend(trend),
    models: persistent.models
      .map((m) => ({
        ...m,
        totalChars: m.inputChars + m.outputChars,
      }))
      .sort((a, b) => b.requests - a.requests),
    tools: persistent.tools.slice(0, 8),
    trend,
    note: "所有统计指标均为近 24 小时窗口值。聚合数据持久化于 Deno KV, 跨实例一致; 最近请求明细仅当前实例。Token 以字符数估算 (上游流式不回传真实 usage)。",
    persisted: true,
  };
}

// ==================== 上游调用限速门控 ====================

// 每模型限速状态: 滑动窗口计数 + 熔断截止时间 + 自适应配额。
// 窗口按 WINDOW_MS 对齐到整段 (与统计趋势桶同思路), 每窗口最多 quota 次。
interface RateLimitState {
  windowStart: number;  // 当前窗口起始 (毫秒时间戳)
  count: number;        // 当前窗口已调用次数
  breakerUntil: number; // 熔断截止时间; 0 = 未熔断
  quota: number;        // 当前窗口配额 (AIMD 自适应, 初始 RATE_LIMIT_MAX_CALLS)
  consecutiveOk: number; // 连续成功次数, 用于加性放宽
}

// 模型 → 限速状态 (内存 Map, 实例重启后重置; 与会话存储同生命周期)
const rateLimitMap = new Map<string, RateLimitState>();

// 账号级额度耗尽: 记录各模型最近一次 1135 的时间; 短时多模型命中即判定账号枯竭。
const quotaHitAt = new Map<string, number>();
let accountCooldownUntil = 0;
let accountProbeAt = 0; // 下次允许放行半开探测的时间
// 半开探测在途标记: 上一个探测还没出结果前不许再放第二个 (否则"探测"自己就成了并发轰炸)。
// accountProbeDeadline 是安全阀 —— 探测若因任何原因没回报结果, 到点自动失活, 不会永久锁死。
let accountProbeInFlight = false;
let accountProbeDeadline = 0;
// 账号级鉴权故障 (1001 / HTTP 401 / 403): Token 失效时所有模型都会失败, 逐个上游试探
// 只是在烧并发槽, 统一进入账号级停投, 靠半开探测自愈。
let accountAuthFaultUntil = 0;

/** opus 模型判定: 名字含 "opus" (claude-opus-*) 的旗舰级, 熔断兜底时长更长。 */
function isOpusModel(model: string): boolean {
  return model.includes("opus");
}

/** 1135 熔断兜底时长 (仅在上游未告知恢复时间时才用)。 */
function modelBreakerMs(model: string): number {
  return isOpusModel(model) ? RATE_LIMIT_BREAKER_OPUS_MS : RATE_LIMIT_BREAKER_MS;
}

/**
 * 从上游错误消息中解析出建议的重试时长 (毫秒)。
 * sider 的 1135 会明说 "Please try again after 117 minutes." —— 这个信息此前被丢弃,
 * 导致 opus 撞到 1 分钟的短时节流却被罚 1 小时, 或 272 分钟的额度枯竭只罚 1 分钟后反复撞墙。
 */
function parseUpstreamRetryMs(msg?: string): number | null {
  if (!msg) return null;
  const m = msg.match(/after\s+(\d+)\s*(hours?|minutes?|mins?|seconds?|secs?)/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2].toLowerCase();
  if (unit.startsWith("hour")) return n * 3600_000;
  if (unit.startsWith("min")) return n * 60_000;
  return n * 1000;
}

/** 获取或初始化某模型的限速状态。 */
function getRateLimitState(model: string): RateLimitState {
  let st = rateLimitMap.get(model);
  if (!st) {
    st = {
      windowStart: 0, count: 0, breakerUntil: 0,
      quota: RATE_LIMIT_MAX_CALLS, consecutiveOk: 0,
    };
    rateLimitMap.set(model, st);
  }
  return st;
}

interface GateDecision {
  allowed: boolean;
  /** allowed=false 时建议的重试秒数 */
  retryAfterSec: number;
  /** 拒绝时的 HTTP 状态与错误类型; 缺省为本地限速策略的 429 rate_limit_error */
  statusCode?: number;
  errorType?: string;
  reason?: string;
  /** 本次放行是否认领了账号级半开探测名额 (租约结束时需要归还, 否则闸门会一直以为探测在途)。 */
  probeClaimed?: boolean;
}

/**
 * 检查某模型当前是否允许调用上游。
 *
 * @param claimProbe 是否允许认领"账号级闸门的半开探测名额"。
 *   预检传 false: 只判定能不能走 —— 一次预检不该把探测机会用掉;
 *   真正要发请求时 (admitUpstreamCall) 传 true。
 */
function checkRateLimit(model: string, claimProbe = false): GateDecision {
  if (!RATE_LIMIT_ENABLED) return { allowed: true, retryAfterSec: 0 };

  const now = Date.now();

  // 0. 账号级闸门: 额度枯竭冷却 / 鉴权故障。两者共享同一个半开探测名额 ——
  //    闸门期内每隔 ACCOUNT_PROBE_INTERVAL_MS 放行一个请求去试探上游是否已恢复。
  //    没有它, 闸门期内所有请求都被拦, 就永远等不到"上游已恢复"的证据, 只能干等到期 ——
  //    那就把"惩罚过度"的毛病从模型级搬到了账号级。
  let wantProbe = false;
  const accountBlockedUntil = Math.max(accountCooldownUntil, accountAuthFaultUntil);
  if (accountBlockedUntil > now) {
    const probeInFlight = accountProbeInFlight && now < accountProbeDeadline;
    if (now < accountProbeAt || probeInFlight) {
      const authFault = accountAuthFaultUntil > accountCooldownUntil;
      return {
        allowed: false,
        retryAfterSec: Math.max(1, Math.ceil((accountBlockedUntil - now) / 1000)),
        statusCode: authFault ? 401 : 429,
        errorType: authFault ? "auth_error" : "rate_limit_error",
        reason: authFault
          ? "上游账号鉴权故障 (Token 无效或已过期), 已暂停放行以避免反复无效触达上游。"
          : "上游账号级额度枯竭冷却中。",
      };
    }
    wantProbe = true;
  }

  const st = getRateLimitState(model);

  // 1. 熔断检查: 熔断中且未到期 -> 拒绝
  if (st.breakerUntil > now) {
    return {
      allowed: false,
      retryAfterSec: Math.max(1, Math.ceil((st.breakerUntil - now) / 1000)),
      reason: "模型熔断冷却中 (上游额度耗尽/鉴权故障)。",
    };
  }

  // 2. 窗口滑动: 若已超出当前窗口, 重置计数
  if (now - st.windowStart >= RATE_LIMIT_WINDOW_MS) {
    st.windowStart = now;
    st.count = 0;
  }

  // 3. 配额检查: 达到上限 -> 拒绝, 建议等窗口剩余时间
  if (st.count >= st.quota) {
    const windowRemain = RATE_LIMIT_WINDOW_MS - (now - st.windowStart);
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil(windowRemain / 1000)) };
  }

  // 4. 模型级检查都过了: 这时才正式认领探测名额 (模型级被拦时不该浪费掉探测机会)
  let probeClaimed = false;
  if (wantProbe && claimProbe) {
    accountProbeInFlight = true;
    accountProbeDeadline = now + UPSTREAM_TOTAL_TIMEOUT_MS + 5_000;
    accountProbeAt = now + ACCOUNT_PROBE_INTERVAL_MS;
    probeClaimed = true;
    console.log(`🔍 [限速] 账号级闸门中, 放行一个半开探测请求 (${model})`);
  }

  return { allowed: true, retryAfterSec: 0, probeClaimed };
}

/**
 * 【二次准入】: 检查通过时同步扣减窗口配额。
 *
 * 检查与扣减之间没有 await, 在 JS 单线程下构成一次原子操作。这一步存在的意义是:
 * 排队等待期间上游可能已经撞墙 (前序请求触发了 1135 熔断), 只在入队前检查的话,
 * 已排队的请求醒来后会直接穿透熔断去消耗额度。
 */
function admitUpstreamCall(model: string): GateDecision {
  const decision = checkRateLimit(model, true);
  if (!decision.allowed || !RATE_LIMIT_ENABLED) return decision;

  const st = getRateLimitState(model);
  const now = Date.now();
  // 窗口滑动 (与 check 相同的对齐逻辑; 若跨窗口则重置)
  if (now - st.windowStart >= RATE_LIMIT_WINDOW_MS) {
    st.windowStart = now;
    st.count = 0;
  }
  st.count += 1;
  return decision;
}

/**
 * 调用上游成功: 熔断复位, 并按 AIMD 加性放宽配额。
 * 上游持续健康时逐步提高每窗口配额, 避免固定保守值闲置上游额度。
 *
 * ⚠️ 只有【读到有效数据且无致命业务码】的调用才允许走到这里 (见 UpstreamLease 的结算)。
 * 按"HTTP 200 到达"记成功会让 SSE 里回 1135 的半开探测先把账号冷却清空 ——
 * 等于用一次失败去证明"账号已恢复"。
 */
function recordUpstreamSuccess(model: string): void {
  const st = getRateLimitState(model);
  st.breakerUntil = 0;
  quotaHitAt.delete(model);
  accountProbeInFlight = false;
  accountProbeDeadline = 0;
  // 任何一次真正成功都证明账号仍可用 —— 半开探测成功即解除账号级闸门
  if (accountCooldownUntil > 0 || accountAuthFaultUntil > 0) {
    accountCooldownUntil = 0;
    accountAuthFaultUntil = 0;
    accountProbeAt = 0;
    quotaHitAt.clear();
    console.log("✅ [限速] 上游调用成功, 解除账号级闸门 (冷却/鉴权故障)");
  }
  st.consecutiveOk += 1;
  if (st.consecutiveOk >= RATE_LIMIT_QUOTA_STEP_AFTER && st.quota < RATE_LIMIT_QUOTA_MAX) {
    st.quota = Math.min(st.quota + 1, RATE_LIMIT_QUOTA_MAX);
    st.consecutiveOk = 0;
  }
}

/** AIMD 乘性收紧: 撞到额度/并发类错误时配额减半, 快速避让。 */
function shrinkQuota(model: string): void {
  const st = getRateLimitState(model);
  st.quota = Math.max(RATE_LIMIT_QUOTA_MIN, Math.floor(st.quota / 2));
  st.consecutiveOk = 0;
}

/**
 * 调用上游失败 (鉴权类): 触发熔断。opus 模型熔断 1 小时, 其他 1 分钟。
 * 仅作为解析不出上游建议时长时的兜底。
 */
function recordUpstreamFailure(model: string): void {
  const st = getRateLimitState(model);
  const breakerMs = modelBreakerMs(model);
  st.breakerUntil = Date.now() + breakerMs;
  accountProbeInFlight = false;
  accountProbeDeadline = 0;
  console.warn(`⛔ [限速] ${model} 上游调用失败, 熔断 ${Math.round(breakerMs / 1000)} 秒`);
}

/**
 * 记录一次账号级鉴权故障 (1001 / HTTP 401 / 403)。
 * Token 失效时所有模型都会失败, 逐个上游试探只是在烧并发槽 —— 统一停投, 靠半开探测自愈。
 */
function noteAccountAuthFault(reason: string): void {
  const now = Date.now();
  accountAuthFaultUntil = now + ACCOUNT_AUTH_FAULT_MS;
  accountProbeInFlight = false;
  accountProbeAt = now + Math.min(ACCOUNT_PROBE_INTERVAL_MS, ACCOUNT_AUTH_FAULT_MS);
  console.error(
    `🚫 [限速] 上游账号鉴权故障 (${reason}), 账号级停投 ${Math.round(ACCOUNT_AUTH_FAULT_MS / 1000)}s ` +
    `至 ${new Date(accountAuthFaultUntil).toISOString()}`
  );
}

/**
 * 记录一次 1135, 并判断是否已是【账号级】额度枯竭。
 * 单模型 1135 只锁该模型 (实测 opus 锁死时其他模型仍可用); 但短时间内多个不同模型
 * 都 1135, 说明是账号额度池枯竭 —— 此时让请求继续逐个模型试探纯属浪费。
 */
function noteQuotaHit(model: string, cooldownMs: number): void {
  const now = Date.now();
  quotaHitAt.set(model, now);
  // 清理窗口外的旧记录
  for (const [m, t] of quotaHitAt) {
    if (now - t > ACCOUNT_QUOTA_WINDOW_MS) quotaHitAt.delete(m);
  }
  if (quotaHitAt.size >= ACCOUNT_QUOTA_MODELS_THRESHOLD) {
    // 用本次告知的时长覆盖 (最新的上游反馈最准确), 而不是取历史最大值 ——
    // 取最大值会让一次长冷却把后续更乐观的信息压住, 又回到"惩罚过度"。
    accountCooldownUntil = now + cooldownMs;
    accountProbeInFlight = false;
    accountProbeAt = now + Math.min(ACCOUNT_PROBE_INTERVAL_MS, cooldownMs);
    console.warn(
      `🚫 [限速] ${ACCOUNT_QUOTA_WINDOW_MS / 1000}s 内 ${quotaHitAt.size} 个模型额度耗尽, ` +
      `判定账号级枯竭, 全局冷却至 ${new Date(accountCooldownUntil).toISOString()}`
    );
  }
}

/**
 * 按 Sider SSE 业务错误码回写限速状态。
 * 1135 = 额度耗尽 (优先按上游告知的时间熔断)；1101 = 瞬时并发；707 = 上游不可用；
 * 1001 = Token 失效 (账号级)；603 = 载荷过大 (是调用方的问题, 不惩罚上游)。
 *
 * 与"是否已经把正文吐给客户端"无关: 正文之后才到的 1135/1101/707/1001 同样必须学习,
 * 否则一次"先给正文再报错"的流会让门控完全看不到上游已经撞墙。
 */
function noteUpstreamOutcome(model: string, code: number, msg?: string): void {
  const st = getRateLimitState(model);
  switch (code) {
    case 1135: {
      const parsed = parseUpstreamRetryMs(msg);
      const cooldownMs = parsed ?? modelBreakerMs(model);
      st.breakerUntil = Date.now() + cooldownMs;
      shrinkQuota(model);
      console.warn(
        `⛔ [限速] ${model} 上游额度耗尽(1135), 熔断 ${Math.round(cooldownMs / 1000)} 秒` +
        (parsed !== null ? " (按上游告知)" : " (上游未告知时长, 用兜底值)")
      );
      noteQuotaHit(model, cooldownMs);
      break;
    }
    case 1101:
      // 瞬时并发: 不熔断, 但收紧配额并占用额外窗口计数
      st.count = Math.min(st.count + 2, st.quota);
      shrinkQuota(model);
      break;
    case 707:
      st.breakerUntil = Date.now() + 5 * 60_000;
      console.warn(`⏸️ [限速] ${model} 上游返回 707, 短暂停投 5 分钟`);
      break;
    case 1001:
      noteAccountAuthFault(`上游业务码 1001${msg ? `: ${msg}` : ""}`);
      break;
    default:
      break;
  }
}

/**
 * 本地门控拒绝的标准化响应: 渲染成【调用方所用的协议】的原生错误结构 + Retry-After。
 * 此前无论从哪个端点进来都返回 OpenAI 结构, anthropic / google-genai 官方 SDK
 * 拿到后会解析失败, 只能看到一个笼统的错误。
 */
function gateRejectionResponse(protocol: ApiProtocol, model: string, decision: GateDecision): Response {
  const retryAfter = Math.max(1, decision.retryAfterSec);
  const st = rateLimitMap.get(model);
  const quota = st?.quota ?? RATE_LIMIT_MAX_CALLS;
  const authFault = decision.errorType === "auth_error";
  const detail = decision.reason ??
    `限速策略: 每 ${RATE_LIMIT_WINDOW_MS / 1000} 秒最多 ${quota} 次调用。`;
  const lead = authFault ? "上游账号鉴权故障" : `模型 ${model} 的调用过于频繁`;

  return protocolErrorResponse(protocol, {
    statusCode: decision.statusCode ?? 429,
    type: decision.errorType ?? "rate_limit_error",
    reason: authFault ? "upstream_auth_fault" : "model_rate_limited",
    model,
    message: `${lead}, 请 ${retryAfter} 秒后重试。${detail}`,
    retryAfterSec: retryAfter,
    // 标记头: 各端点 !ok 分支据此识别并透传本响应, 不重新包装为上游错误
  }, { "X-Model-Rate-Limited": "1" });
}

// ==================== 上游并发租约 (UpstreamLease) ====================
// 上游账号实测为单并发 ("Your account has an active request - only one request at a time"),
// 并发请求注定只能成功一个。与其让其余请求失败, 不如排队 —— 它们通常只要等几秒。
//
// 一个"租约"覆盖上游调用的【完整生命周期】:
//   预检 -> FIFO 排队 -> 二次复检并原子扣配额 -> fetch -> 三段超时 -> 消费事件
//   -> 结算成功/失败 -> finally: cancel + release
// 它统一收口四件此前散落各处、且各自都不完整的事:
//   1) 排队后的二次准入 (否则排队期间上游已撞墙, 醒来的请求照样穿透熔断);
//   2) 三段超时 (响应头 / 流空闲 / 总时长), 超时 abort + cancel + release;
//   3) 成功判定延迟到"读到有效数据且无致命业务码", 而不是 HTTP 200 到达就记成功;
//   4) 幂等释放 (流结束 / 取消 / 异常 / 兜底定时器 都只释放一次)。
//
// 注意: 进程内队列不跨 Deno Deploy 实例 (与 rateLimitMap 同样的局限)。低流量个人网关
// 场景通常只有一个活跃实例, 够用; 跨实例协调需 KV/多账号池, KV 延迟不适合做并发锁。

class UpstreamQueueFullError extends Error {}
class UpstreamQueueTimeoutError extends Error {}

/** 三段超时里被触发的那一段 (用于日志与错误细节)。 */
type UpstreamTimeoutStage = "header" | "stream_idle" | "total";

class UpstreamTimeoutError extends Error {
  constructor(public stage: UpstreamTimeoutStage) {
    super(`upstream ${stage} timeout`);
  }
}

let upstreamActive = 0;
interface QueueWaiter {
  wake: () => void;
  fail: (e: Error) => void;
  timer: number;
}
const upstreamQueue: QueueWaiter[] = [];

/** 造一个幂等的 release: 释放槽位并唤醒队首。 */
function makeSlotRelease(): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    upstreamActive -= 1;
    const next = upstreamQueue.shift();
    if (next) {
      clearTimeout(next.timer);
      upstreamActive += 1;
      next.wake();
    }
  };
}

/** 取上游并发槽位; 满则排队。队列满或等待超时会抛出对应错误。 */
function acquireUpstreamSlot(): Promise<() => void> {
  // 与 RATE_LIMIT_ENABLED 解耦: 这里保护的是上游"同一时刻只能有一个请求"这一物理约束,
  // 与配额策略无关 —— 关掉限速也不该把并发保护一起关掉。
  if (UPSTREAM_MAX_CONCURRENCY <= 0) {
    return Promise.resolve(() => {});
  }
  if (upstreamActive < UPSTREAM_MAX_CONCURRENCY) {
    upstreamActive += 1;
    return Promise.resolve(makeSlotRelease());
  }
  if (upstreamQueue.length >= UPSTREAM_QUEUE_MAX) {
    return Promise.reject(new UpstreamQueueFullError());
  }
  return new Promise<() => void>((resolve, reject) => {
    const waiter: QueueWaiter = {
      wake: () => resolve(makeSlotRelease()),
      fail: reject,
      timer: setTimeout(() => {
        const i = upstreamQueue.indexOf(waiter);
        if (i >= 0) upstreamQueue.splice(i, 1);
        reject(new UpstreamQueueTimeoutError());
      }, UPSTREAM_QUEUE_WAIT_MS),
    };
    upstreamQueue.push(waiter);
  });
}

/**
 * 一次上游调用的句柄。消费方通过它把"我读到了什么"回报给门控 ——
 * 门控的结论只能来自真实消费到的事件, 不能来自 HTTP 状态码。
 */
interface UpstreamCall {
  response: Response;
  /** 消费方解析出有效数据 (text/file/tool_call...) 时申报。 */
  reportSuccess(): void;
  /** 消费方发现上游业务码时申报; 门控学习与"是否已吐出正文"无关。 */
  reportBusinessError(code: number, msg?: string): void;
  /** 把上游业务码按统一分类器翻译成错误详情 (已带该模型专属的 1135 兜底时长)。 */
  describeBusinessError(code: number, msg?: string): UpstreamErrorDetail;
  /** 消费方正常消费完响应体后调用: 结算成功/失败并释放槽位。 */
  complete(): void;
  /** 幂等释放 (取消/异常路径); 同样会结算。 */
  release(): void;
}

/** 没有租约的响应 (预检拒绝 / 排队失败 / 超时): 申报与释放都是空操作。 */
function detachedCall(response: Response): UpstreamCall {
  return {
    response,
    reportSuccess() {},
    reportBusinessError() {},
    describeBusinessError(code: number, msg = "") {
      return classifyUpstreamError(code, msg);
    },
    complete() {},
    release() {},
  };
}

/**
 * 已经读到有效数据之前, 这些业务码就足以判定"这次调用不算成功"。
 * 它们的出现会阻止本次调用给门控记一次成功 —— 尤其是 1135:
 * 旧实现按 HTTP 200 记成功, 于是半开探测里回 1135 的请求会先把账号冷却清空,
 * 等于用一次失败去证明"账号已恢复", 下一个请求立刻又撞墙。
 */
const FATAL_GATE_CODES = new Set([1135, 1101, 707, 1001]);

// 流已经读完、但消费方还没来得及调用 complete() 时的宽限期。
// 消费方的 for-await 循环退出与响应体读到末尾之间隔着一小段, 不能因此把槽位挂住。
const UPSTREAM_STREAM_END_GRACE_MS = 5000;

function timeoutDetail(stage: UpstreamTimeoutStage): UpstreamErrorDetail {
  const limitMs = stage === "header"
    ? UPSTREAM_HEADER_TIMEOUT_MS
    : stage === "stream_idle"
    ? UPSTREAM_STREAM_IDLE_TIMEOUT_MS
    : UPSTREAM_TOTAL_TIMEOUT_MS;
  const label = stage === "header"
    ? "等待上游响应头"
    : stage === "stream_idle"
    ? "上游响应流空闲"
    : "上游请求总时长";
  return {
    statusCode: 504,
    type: "timeout_error",
    reason: `upstream_${stage}_timeout`,
    retryAfterSec: 1,
    message: `${label}超过 ${Math.round(limitMs / 1000)} 秒, 已中止本次上游调用。`,
  };
}

/**
 * 把租约抛出的异常翻译成错误详情; 返回 null 表示"不是可识别的上游错误"。
 * 响应体卡死时, 超时会在【响应流内部】爆发 (而不是 fetch 阶段), 各端点需要据此把
 * 500 改成 504 / 发一条协议原生错误事件。
 */
function upstreamErrorFromException(err: unknown): UpstreamErrorDetail | null {
  if (err instanceof UpstreamTimeoutError) return timeoutDetail(err.stage);
  return null;
}

/**
 * 端点级兜底异常出口: 可识别的上游超时映射为 504, 其余保持 500 server_error。
 * 响应体卡死的超时会从响应流内部冒出来, 若各端点各自写 catch, 就会退化成 500,
 * 客户端无法区分"上游挂了"和"我们自己写错了"。
 */
function handlerFailureResponse(protocol: ApiProtocol, err: unknown): Response {
  const detail = upstreamErrorFromException(err);
  if (detail) return protocolErrorResponse(protocol, detail);
  const message = err instanceof Error ? err.message : String(err);
  return protocolErrorResponse(protocol, {
    statusCode: 500,
    type: "server_error",
    message: `处理请求失败: ${message}`,
  });
}

/**
 * 带限速门控 + 并发租约的上游请求封装。所有 sider 上游 fetch 统一走这里。
 *
 * 执行顺序 (与审计建议一致):
 *   预检 -> FIFO 排队 -> 二次检查并扣配额 -> fetch -> 三段超时 -> 错误分类
 *   -> 交给消费方迭代事件 -> 消费方 complete() -> 结算 -> finally release
 *
 * 限速按【上游实际模型】统计 (siderModel, 即 MODEL_MAPPING 映射后的值),
 * 这样 gpt-4.1 与 claude-opus-4.8 等不同模型各自独立计数。
 */
async function fetchSiderRateLimited(
  model: string,
  url: string,
  init: RequestInit,
  protocol: ApiProtocol,
): Promise<UpstreamCall> {
  // 1. 预检 (不认领半开探测名额): 账号闸门/熔断/超配额 -> 直接拒, 不触达上游
  const pre = checkRateLimit(model);
  if (!pre.allowed) {
    return detachedCall(gateRejectionResponse(protocol, model, pre));
  }

  // 2. 并发闸门: 上游单并发, 满则 FIFO 排队而非直接失败
  let releaseSlot: () => void;
  try {
    releaseSlot = await acquireUpstreamSlot();
  } catch (err) {
    const waitSec = Math.ceil(UPSTREAM_QUEUE_WAIT_MS / 1000);
    const reason = err instanceof UpstreamQueueFullError
      ? `上游为单并发, 排队已满 (${UPSTREAM_QUEUE_MAX} 个等待中)。`
      : `上游为单并发, 排队等待超过 ${waitSec} 秒。`;
    return detachedCall(gateRejectionResponse(protocol, model, {
      allowed: false,
      retryAfterSec: Math.max(1, Math.ceil(waitSec / 2)),
      reason,
    }));
  }

  // 3. 二次准入: 排队期间前序请求可能已经触发 1135 熔断或鉴权故障。
  //    复检与扣配额之间没有 await, 构成原子操作 —— 排队的请求不会再穿透熔断去烧额度。
  const admitted = admitUpstreamCall(model);
  if (!admitted.allowed) {
    releaseSlot();
    return detachedCall(gateRejectionResponse(protocol, model, admitted));
  }

  // 4. 租约: 三段超时 + 结果申报 + 幂等释放
  const controller = new AbortController();
  let released = false;
  let settled = false;
  let timedOut: UpstreamTimeoutStage | null = null;
  let sawValidData = false;
  let fatalCode = 0;
  let idleTimer: number | undefined;
  const timers: number[] = [];

  const clearTimers = () => {
    for (const t of timers) clearTimeout(t);
    timers.length = 0;
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  };
  const releaseLease = () => {
    if (released) return;
    released = true;
    clearTimers();
    // 归还半开探测名额: 探测已经结束 (无论成败), 不该继续以"探测在途"为由挡住后续请求。
    // 注意只归还名额, 不动 accountCooldownUntil —— 探测失败时冷却必须继续保持。
    if (admitted.probeClaimed) {
      accountProbeInFlight = false;
      accountProbeDeadline = 0;
    }
    releaseSlot();
  };
  /** 结算: creditSuccess=true 时 (消费方正常读完) 才可能记一次成功。 */
  const settle = (creditSuccess: boolean) => {
    if (settled) return;
    settled = true;
    if (creditSuccess && fatalCode === 0 && sawValidData && timedOut === null) {
      recordUpstreamSuccess(model);
    }
    releaseLease();
  };
  const armIdleWatchdog = () => {
    if (released) return;
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      timedOut = "stream_idle";
      try {
        controller.abort(new UpstreamTimeoutError("stream_idle"));
      } catch { /* 已中止 */ }
    }, UPSTREAM_STREAM_IDLE_TIMEOUT_MS);
  };

  const headerTimer = setTimeout(() => {
    timedOut = "header";
    controller.abort(new UpstreamTimeoutError("header"));
  }, UPSTREAM_HEADER_TIMEOUT_MS);
  const totalTimer = setTimeout(() => {
    timedOut = "total";
    controller.abort(new UpstreamTimeoutError("total"));
  }, UPSTREAM_TOTAL_TIMEOUT_MS);
  // 兜底: 任何路径都没释放时, 到点强制释放 (正常路径永远先于它释放)
  timers.push(headerTimer, totalTimer, setTimeout(releaseLease, UPSTREAM_SLOT_MAX_HOLD_MS));

  const call: UpstreamCall = {
    response: new Response(null, { status: 502 }),
    reportSuccess() {
      sawValidData = true;
    },
    reportBusinessError(code: number, msg?: string) {
      if (FATAL_GATE_CODES.has(code)) fatalCode = code;
      noteUpstreamOutcome(model, code, msg);
    },
    describeBusinessError(code: number, msg = "") {
      return classifyUpstreamError(code, msg, modelBreakerMs(model));
    },
    complete() {
      settle(true);
    },
    release() {
      settle(false);
    },
  };

  // 5. fetch 上游 (signal 由租约持有, 调用方不再自建定时器)
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    const stage = timedOut;
    settle(false);
    if (stage !== null) {
      console.warn(`⏱️ [上游超时] ${model} 阶段=${stage}`);
      return detachedCall(protocolErrorResponse(protocol, timeoutDetail(stage)));
    }
    console.error("❌ 上游 fetch 失败:", err);
    return detachedCall(protocolErrorResponse(protocol, {
      statusCode: 502,
      type: "upstream_error",
      message: `上游连接失败: ${err instanceof Error ? err.message : String(err)}`,
    }));
  }
  clearTimeout(headerTimer);

  // 6. HTTP 非 2xx: 与 SSE 业务码走【同一套分类器】, 再按调用方协议渲染
  if (!res.ok) {
    const rawBody = await res.text().catch(() => "");
    try {
      await res.body?.cancel();
    } catch { /* 已消费/已关闭 */ }
    const detail = classifyUpstreamHttpError(res.status, rawBody);
    if (detail.upstreamCode !== undefined && detail.upstreamCode !== 0) {
      call.reportBusinessError(detail.upstreamCode, detail.message);
    } else if (detail.accountAuthFault) {
      noteAccountAuthFault(`HTTP ${res.status}`);
      recordUpstreamFailure(model);
    } else if (res.status === 429) {
      shrinkQuota(model);
    }
    settle(false);
    console.error(`❌ 上游 HTTP ${res.status}:`, rawBody.slice(0, 200));
    return detachedCall(protocolErrorResponse(protocol, detail));
  }

  // 7. 无响应体: 拿不到任何数据, 不记成功
  if (!res.body) {
    settle(false);
    return detachedCall(new Response(null, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    }));
  }

  // 8. 包装响应体: 流空闲看门狗 + 结束结算 + 取消即释放
  const upstreamReader = res.body.getReader();
  const wrapped = new ReadableStream<Uint8Array>({
    async pull(out) {
      armIdleWatchdog();
      try {
        const { done, value } = await upstreamReader.read();
        if (done) {
          if (idleTimer !== undefined) {
            clearTimeout(idleTimer);
            idleTimer = undefined;
          }
          try {
            out.close();
          } catch { /* 已关闭 */ }
          // 流读完了, 但消费方还没申报; 给一小段宽限期, 逾期强制结算
          if (!released) {
            timers.push(setTimeout(() => settle(false), UPSTREAM_STREAM_END_GRACE_MS));
          }
          return;
        }
        out.enqueue(value);
      } catch (err) {
        if (idleTimer !== undefined) {
          clearTimeout(idleTimer);
          idleTimer = undefined;
        }
        // 超时/异常: abort 之后还要显式 cancel 上游 reader, 别把连接挂着
        try {
          await upstreamReader.cancel(err);
        } catch { /* 已关闭 */ }
        settle(false);
        // 超时必须在响应流内部暴露成可识别的错误类型, 否则消费方只能报 500
        const failure = timedOut !== null ? new UpstreamTimeoutError(timedOut) : err;
        try {
          out.error(failure);
        } catch { /* 已关闭 */ }
      }
    },
    cancel(reason) {
      if (idleTimer !== undefined) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
      }
      settle(false);
      return upstreamReader.cancel(reason);
    },
  });

  call.response = new Response(wrapped, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
  return call;
}

// ==================== 认证中间件 ====================

// 从请求中提取调用方 token。三家官方 SDK 的鉴权约定各不相同, 都要认:
//   OpenAI SDK    -> Authorization: Bearer <token>
//   Anthropic SDK -> x-api-key: <token>
//   Gemini SDK    -> x-goog-api-key: <token>, 或 URL query ?key=<token>
// 只认 Authorization 会让 anthropic / google-genai 官方 SDK 开箱即 401。
function extractAuthToken(req: Request): string | null {
  const authHeader = req.headers.get("Authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authHeader.slice("Bearer ".length).trim() || null;
  }

  const apiKey = req.headers.get("x-api-key") || req.headers.get("x-goog-api-key");
  if (apiKey) return apiKey.trim() || null;

  const queryKey = new URL(req.url).searchParams.get("key");
  if (queryKey) return queryKey.trim() || null;

  return null;
}

function authMiddleware(handler: (req: Request) => Promise<Response>): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    // 如果未配置 AUTH_TOKEN,允许所有请求
    if (!AUTH_TOKEN) {
      return handler(req);
    }

    const token = extractAuthToken(req);

    if (!token) {
      return new Response(JSON.stringify({
        error: {
          message: "Unauthorized: Missing or invalid credentials. Provide one of: " +
            "Authorization: Bearer <token>, x-api-key, x-goog-api-key, or ?key=",
          type: "invalid_request_error"
        }
      }), {
        status: 401,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }

    if (token !== AUTH_TOKEN) {
      return new Response(JSON.stringify({
        error: {
          message: "Unauthorized: Invalid token",
          type: "invalid_request_error"
        }
      }), {
        status: 401,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }

    return handler(req);
  };
}

// ==================== SSE 处理 ====================

class SSELineReader {
  private buffer = '';
  private decoder = new TextDecoder();

  async *readLines(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<string, void, unknown> {
    // 用 try/finally 兜住所有退出路径: 调用方在 for await 里 break / return / throw 时,
    // JS 会调用本 generator 的 .return(), finally 必定执行 —— 从而保证上游流一定被 cancel。
    //
    // 这很重要: 各流式路径普遍存在"提前 return 但不 cancel"(实测四个流式 start() 每个都是
    // 1 处 cancel 对 5~6 处 return), 图像生成的成功路径也是收够图就 break。不 cancel 会让
    // 上游连接一直挂着, 上游很可能仍把该请求算作"进行中" —— 对单并发的 sider 账号尤其不利。
    // 在 generator 这一处收口, 比在每个调用点补 cancel 更不容易遗漏。
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        this.buffer += this.decoder.decode(value, { stream: true });

        const lines = this.buffer.split('\n');
        this.buffer = lines.pop() || '';

        for (const line of lines) {
          yield line;
        }
      }

      if (this.buffer) {
        yield this.buffer;
      }
    } finally {
      try { await reader.cancel(); } catch { /* 流已读完/已取消时忽略 */ }
    }
  }
}

// ==================== 统一上游 SSE 事件迭代 ====================
// 四个端点此前各写一份"逐行取 data -> JSON.parse -> 看 code 非 0"的循环: 业务码识别口径
// 不一 (有的只在"还没输出正文"时才回写门控), 提前 return 是否 cancel 也各凭自觉。
// 这里收口成一个异步生成器, 消费方只关心 data 内容。
//
// 生命周期: 调用方 break / return / throw 时 JS 会调用本生成器的 .return(), finally 必定
// 执行, 从而保证上游 reader 一定被 cancel —— 对单并发的 sider 账号尤其重要。

type SiderEvent =
  | { kind: "data"; data: any }
  | { kind: "business_error"; code: number; msg: string }
  | { kind: "done" };

/** 会被记作"上游确实产出了内容"的事件类型 (用于成功判定)。 */
const SIDER_CONTENT_EVENT_TYPES = new Set(["text", "file", "reasoning_content", "tool_call"]);

interface SiderEventOptions {
  /**
   * 每个 code !== 0 的顶层事件都会回调一次 —— 与消费方是否已经向客户端吐过正文无关。
   * 门控必须看到"正文之后才到的 1135/1101/707/1001", 否则一次"先给正文再报错"的流
   * 会让门控完全不知道上游已经撞墙。
   */
  onBusinessError?: (code: number, msg: string) => void;
  /** 读到内容型事件 (text/file/reasoning_content/tool_call) 时回调, 供成功判定。 */
  onValidData?: () => void;
}

async function* iterateSiderEvents(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  options: SiderEventOptions = {},
): AsyncGenerator<SiderEvent, void, unknown> {
  const lineReader = new SSELineReader();
  try {
    for await (const line of lineReader.readLines(reader)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const payload = trimmed.startsWith("data:") ? trimmed.substring(5).trim() : trimmed;
      if (!payload) continue;

      if (payload === "[DONE]") {
        yield { kind: "done" };
        continue;
      }

      let parsed: any;
      try {
        parsed = JSON.parse(payload);
      } catch {
        // 心跳注释行 / 非 JSON 行 (如 ": ping") —— 忽略, 不打日志避免刷屏
        continue;
      }

      const code = Number(parsed?.code ?? 0);
      if (code !== 0) {
        const msg = String(parsed?.msg ?? "");
        options.onBusinessError?.(code, msg);
        yield { kind: "business_error", code, msg };
        continue;
      }

      const data = parsed?.data;
      if (!data) continue;
      if (SIDER_CONTENT_EVENT_TYPES.has(data.type)) options.onValidData?.();
      yield { kind: "data", data };
    }
  } finally {
    // 兜底取消 (SSELineReader 的 finally 已做一次, 重复 cancel 是幂等的)
    try {
      await reader.cancel();
    } catch { /* 已读完 / 已取消 */ }
  }
}

// SSE 流安全写入 + 心跳辅助。
// 统一维护 closed 守卫(避免 close 后再 enqueue / 二次 close 抛错)与定时 ping。
// pingFrame 由各协议决定:
//   - OpenAI / Gemini / Responses 用 SSE 注释行 ": ping\n\n"(所有兼容解析器忽略);
//   - Anthropic 用官方 "event: ping\ndata: {\"type\":\"ping\"}\n\n"。
function createSSEHeartbeat(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  pingFrame: string,
) {
  let closed = false;
  const timer = SSE_PING_INTERVAL_MS > 0
    ? setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(pingFrame));
        } catch {
          closed = true;
        }
      }, SSE_PING_INTERVAL_MS)
    : undefined;

  return {
    get closed() {
      return closed;
    },
    close() {
      if (closed) return;
      closed = true;
      if (timer) clearInterval(timer);
      try {
        controller.close();
      } catch { /* 已关闭 */ }
    },
    fail(err: unknown) {
      if (closed) return;
      closed = true;
      if (timer) clearInterval(timer);
      try {
        controller.error(err);
      } catch { /* 已关闭 */ }
    },
  };
}

const ANTHROPIC_PING_FRAME = `event: ping\ndata: ${JSON.stringify({ type: "ping" })}\n\n`;
const COMMENT_PING_FRAME = ": ping\n\n";

// ==================== 共享上下文预算 / 模型解析 / 会话解析 ====================

/**
 * 把 OpenAI 风格的 content (string 或内容块数组) 拍平成纯文本。
 * 四个协议入站适配后都会走到这里, 因此放在模块级共享。
 */
function flattenMessageContent(content: any): string {
  if (typeof content === "string") return content;
  if (!content) return "";

  // If content is an array of blocks, concatenate all text blocks.
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part) return "";
        if (typeof part === "string") return part;
        if (part.type === "text" && typeof part.text === "string") return part.text;
        // Some clients may use {type:"input_text", text:"..."}
        if ((part.type === "input_text" || part.type === "inputText") && typeof part.text === "string") return part.text;
        // Unknown block types (images/tool calls/etc.) are ignored for prompt flattening.
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  // Fallback: common shapes
  if (typeof content.text === "string") return content.text;
  return String(content);
}

interface BoundedContext {
  text: string;
  /** 历史被裁剪过 (从最旧端丢弃) */
  truncated: boolean;
  /** 固定部分 (system + 当前问题) 自身已超限: 必须在本地拒绝, 不能拿去烧上游额度 */
  overflow: boolean;
}

/**
 * 把完整 messages[] 拼成受预算约束的上游上下文。
 * 四个端点共用同一份实现 —— 此前只有 OpenAI Chat 端点做了预算保护, Gemini /
 * Anthropic / Responses 直接拼接全部历史, 长对话会一路撞到上游 603 (词数超限)。
 *
 * 优先级: system/developer > 当前问题 > 历史 (从最新往最旧填充), 严守字符/词数预算。
 * 固定部分自身超限时返回 overflow=true, 由调用方在本地返回 context_length_exceeded。
 */
function buildBoundedContext(msgs: any[]): BoundedContext {
  if (!msgs || msgs.length === 0) return { text: "", truncated: false, overflow: false };

  const SEP = "\n\n---\n\n";
  const HISTORY_LABEL = "[Conversation History]\n";
  const HISTORY_LABEL_PARTIAL = "[Conversation History (partial, oldest trimmed)]\n";
  // 按更长的那个标签预留, 避免"裁剪后标签变长"反而挤爆预算
  const LABEL_RESERVE = Math.max(HISTORY_LABEL.length, HISTORY_LABEL_PARTIAL.length);

  const instructionMsgs = msgs.filter((m) => m.role === "system" || m.role === "developer");
  const conversationMsgs = msgs.filter((m) => m.role !== "system" && m.role !== "developer");
  const currentMsg = conversationMsgs[conversationMsgs.length - 1];
  const currentText = flattenMessageContent(currentMsg?.content);

  // 仅有一条对话消息且无固定指令时直接返回原文
  if (conversationMsgs.length <= 1 && instructionMsgs.length === 0) {
    const overflow = currentText.length > SIDER_MAX_CHARS || estimateWordCount(currentText) > SIDER_MAX_WORDS;
    return { text: overflow ? "" : currentText, truncated: false, overflow };
  }

  const instructionParts = instructionMsgs.map((m) => {
    const label = m.role === "developer" ? "Developer" : "System";
    return `[${label}]\n${flattenMessageContent(m.content)}`;
  });
  const currentRole = currentMsg?.role === "assistant" ? "Assistant" : "User";
  const currentPart = `[Current ${currentRole}]\n${currentText}`;
  const fixedText = [...instructionParts, currentPart].join(SEP);
  const fixedChars = fixedText.length;
  const fixedWords = estimateWordCount(fixedText);

  // 固定部分自身超限: 丢掉 system 或当前问题都会让回答失去意义, 只能本地拒绝
  if (fixedChars > SIDER_MAX_CHARS || fixedWords > SIDER_MAX_WORDS) {
    return { text: "", truncated: false, overflow: true };
  }

  const historyBudget = SIDER_MAX_CHARS - fixedChars - SEP.length - LABEL_RESERVE;
  const historyMsgs = conversationMsgs.slice(0, -1);
  const selectedLines: string[] = [];
  let usedChars = 0;
  let usedWords = fixedWords;
  let truncated = false;

  for (let i = historyMsgs.length - 1; i >= 0; i--) {
    const m = historyMsgs[i];
    const role = m.role === "assistant" ? "Assistant" : "User";
    const line = `${role}: ${flattenMessageContent(m.content)}`;
    const lineChars = line.length + (selectedLines.length > 0 ? "\n\n".length : 0);
    const lineWords = estimateWordCount(line);
    if (historyBudget <= 0 || usedChars + lineChars > historyBudget || usedWords + lineWords > SIDER_MAX_WORDS) {
      truncated = true;
      break;
    }
    selectedLines.unshift(line);
    usedChars += lineChars;
    usedWords += lineWords;
  }

  const parts: string[] = [];
  parts.push(...instructionParts);
  if (selectedLines.length > 0) {
    const label = truncated ? HISTORY_LABEL_PARTIAL : HISTORY_LABEL;
    parts.push(label + selectedLines.join("\n\n"));
  }
  parts.push(currentPart);

  return { text: parts.join(SEP), truncated, overflow: false };
}

function logContextTruncation(protocol: ApiProtocol, model: string, ctx: BoundedContext): void {
  if (ctx.truncated) {
    console.warn("✂️ [上下文裁剪]", { protocol, model, maxChars: SIDER_MAX_CHARS, maxWords: SIDER_MAX_WORDS });
  }
}

/** 能力门控: 上下文预算溢出时在本地拒绝, 不消耗上游额度。 */
function contextOverflowResponse(protocol: ApiProtocol): Response {
  return protocolErrorResponse(protocol, {
    statusCode: 400,
    type: "context_length_exceeded",
    reason: "context_length_exceeded",
    message: `请求内容本身已超出上游上限 (${SIDER_MAX_CHARS} 字符 / ${SIDER_MAX_WORDS} 词), ` +
      "请缩短 system 提示或当前问题。",
  });
}

/**
 * 客户端模型名 -> 上游 sider 模型名。
 * 只有显式 "sider" (智能路由) 与 MODEL_MAPPING 里登记过的名字会被接受。
 * 未知名字一律判为笔误: 静默回退到 sider 会让一次拼写错误变成一次真实的额度消耗,
 * 且调用方会以为自己用的是另一个模型 —— 后果比"报错"严重得多。
 * @returns null 表示未知模型
 */
function resolveSiderModel(modelName?: string): string | null {
  if (!modelName) return "sider";
  return MODEL_MAPPING[modelName] ?? null;
}

function modelNotFoundResponse(protocol: ApiProtocol, modelName: string): Response {
  return protocolErrorResponse(protocol, {
    statusCode: 404,
    type: "invalid_request_error",
    reason: "model_not_found",
    message: `未知模型 "${modelName}"。请用 GET /v1/models 查看可用模型; ` +
      `不传 model 或传 "sider" 则走智能路由。`,
  });
}

/**
 * 解析本次请求的会话标识。
 * 只有调用方【显式回传 X-Session-ID】时才复用它读写上游会话; 否则生成一次性随机 ID,
 * 在响应头回传供调用方下一轮带上, 但本次按【无状态】处理。
 *
 * 原因: 用"系统消息 + 首问"指纹推导会话 ID 时, 同一调用方的两个不同对话只要开头相同
 * 就会撞进同一个上游 cid, 出现串话。上下文本身不会因此丢失 —— 每次请求都注入了完整历史。
 */
interface SessionInfo {
  /** 响应头回传的会话 ID: 显式传入的原样回传, 否则是本次生成的一次性 ID。 */
  id: string;
  /** true = 调用方显式回传, 允许读写上游会话; false = 本次按无状态处理。 */
  reusable: boolean;
}

function resolveSessionId(req: Request): SessionInfo {
  const explicit = req.headers.get("X-Session-ID")?.trim();
  if (explicit) return { id: explicit, reusable: true };
  return { id: `anon-${crypto.randomUUID()}`, reusable: false };
}

// ==================== 请求处理器 ====================

// 处理文本对话请求
async function handleChatCompletion(req: Request): Promise<Response> {
  let modelName = "sider"; // 函数级: catch 出口的失败统计也要用
  try {
    const requestBody = await req.json();
    console.log("📥 收到聊天请求:", {
      model: requestBody.model,
      stream: requestBody.stream,
      messageCount: requestBody.messages?.length
    });

    modelName = requestBody.model || "sider";
    // 未知模型一律拒绝 (P2): 除显式 "sider" 智能路由外, MODEL_MAPPING 里没有的名字都是笔误。
    // 静默回退会让调用方以为在用另一个模型, 同时白白消耗一次真实上游额度。
    const siderModel = resolveSiderModel(modelName);
    if (siderModel === null) {
      console.warn(`⛔ 未知模型: ${modelName}`);
      recordFailure(modelName); // 失败统计: 模型门控拒绝
      return modelNotFoundResponse("openai", modelName);
    }

    const isStreaming = requestBody.stream ?? false;
    const outputLimits = openAIOutputLimits(requestBody);
    const messages = requestBody.messages || [];
    const lastMessage = messages[messages.length - 1];

    // 能力门控 (CLAUDE.md 铁律): 上游 sider 不支持视觉输入。
    // 经 test/probe_vision.py 决定性判别确认 (读不出图中文字, 仅幻觉)。
    // 收到图像块直接返回标准 not_supported, 绝不静默丢给上游让其幻觉。
    if (detectVisionInput(messages)) {
      console.warn("⛔ 收到视觉输入(图像), 但上游 sider 不支持视觉理解; 返回 not_supported。");
      recordFailure(modelName); // 失败统计: 能力门控拒绝
      return notSupportedResponse(
        "openai",
        "上游 sider 不支持视觉输入 (图像理解)。请仅发送文本内容。" +
        "如需图像生成, 请用绘图关键词描述 (如'画一只猫') 或调用 /v1/images/generations。",
        "vision_not_supported",
      );
    }

    // 能力门控 (CLAUDE.md 铁律): 上游 sider 不支持自定义 function calling。
    // 经 test/probe_tools.py 探针确认: 顶层 tools=[{type:function}] 报 code:1000,
    // functions[] 被静默忽略。上游只支持内置工具 (search/data_analysis/create_image)。
    // 处理策略: 不 fake (绝不伪造 tool_calls), 统一返回协议原生 not_supported。
    //   - tool_choice="none" 是调用方明确"不要调用工具", tools[] 只是声明, 正常放行;
    //   - 其余情况一律拒绝 —— 此前"有时报错、有时静默降级"两种相反契约并存,
    //     调用方无法写出稳定的处理逻辑。
    const hasCustomTools = Array.isArray(requestBody.tools) &&
      requestBody.tools.some((t: any) => t && t.type === "function");
    const hasLegacyFunctions = Array.isArray(requestBody.functions) && requestBody.functions.length > 0;
    const customToolsRequested = hasCustomTools || hasLegacyFunctions;
    const toolChoiceNone = requestBody.tool_choice === "none";
    if (customToolsRequested && !toolChoiceNone) {
      console.warn("⛔ 收到自定义 function tools, 上游 sider 不支持自定义函数调用; 返回 not_supported。");
      recordFailure(modelName); // 失败统计: 能力门控拒绝
      return notSupportedResponse(
        "openai",
        "上游 sider 不支持自定义 function calling (tools / functions)。" +
        "内置工具 (联网搜索 / 图像生成) 由模型自主触发, 无需显式传 tools; " +
        "若确实不需要工具, 请传 tool_choice=\"none\"。",
        "tools_not_supported",
      );
    }

    const userPrompt = flattenMessageContent(lastMessage?.content);

    // 上下文预算: 与 Gemini / Anthropic / Responses 共用 buildBoundedContext。
    // 固定部分 (system + 当前问题) 自身超限时在本地拒绝, 不消耗上游额度。
    const ctx = buildBoundedContext(messages);
    if (ctx.overflow) {
      console.warn("⛔ 上下文固定部分自身超限, 本地拒绝 (不消耗上游额度)");
      recordFailure(modelName);
      return contextOverflowResponse("openai");
    }
    logContextTruncation("openai", modelName, ctx);
    const fullContext = ctx.text;

    // 会话复用只在调用方【显式回传 X-Session-ID】时发生 (见 resolveSessionId)
    const sessionInfo = resolveSessionId(req);
    const sessionId = sessionInfo.id;
    const session = sessionInfo.reusable ? conversationSessions.get(sessionId) : undefined;

    // 构建 Sider 请求
    const siderRequest = JSON.parse(JSON.stringify(DEFAULT_REQUEST_TEMPLATE));

    // 判断是否为图像生成请求（基于原始用户输入，不含历史上下文）
    const isImageGen = isImageGenerationRequest(userPrompt);

    // 检查是否启用 Think 模式
    const enableThink = shouldEnableThinkMode(modelName);

    // 设置 multi_content：注入完整上下文确保多轮对话连贯性
    siderRequest.multi_content = [{
      type: "text",
      text: fullContext,
      user_input_text: fullContext
    }];

    // 设置模型
    siderRequest.model = siderModel;
    siderRequest.stream = isStreaming;

    // 设置 Think 模式
    siderRequest.think_mode = { enable: enableThink };

    // 多轮对话支持
    if (session) {
      siderRequest.cid = session.cid;
      siderRequest.parent_message_id = session.parent_message_id;
      session.last_used = Date.now();
      console.log(`♻️ 使用现有会话: ${sessionId} (cid: ${session.cid})`);
    } else {
      console.log(`🆕 无状态会话: ${sessionId} (未回传 X-Session-ID, 本次不读写上游会话)`);
    }

    if (isImageGen) {
      console.log("🎨 检测到图像生成请求");
      siderRequest.tools = {
        image: {
          quality_level: detectImageQuality(userPrompt)
        },
        auto: ["create_image", "data_analysis", "search"]
      };
    } else {
      const enableSearch = shouldEnableAutoSearch(userPrompt);
      siderRequest.tools = {
        auto: enableSearch ? ["search", "data_analysis"] : ["data_analysis"]
      };
    }

    console.log("🚀 发送到 Sider:", {
      model: siderRequest.model,
      isImage: isImageGen,
      thinkMode: enableThink,
      sessionId: sessionId,
      hasCid: !!siderRequest.cid
    });

    // 发送请求: 三段超时/排队/配额/错误分类统一由 UpstreamLease 负责
    const call = await fetchSiderRateLimited(siderModel, SIDER_API_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SIDER_AUTH_TOKEN}`,
        "Accept": "*/*",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Origin": "chrome-extension://dhoenijjpgpeimemopealfcbiecgceod",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "X-App-Name": "ChitChat_Edge_Ext",
        "X-App-Version": "5.21.2"
      },
      body: JSON.stringify(siderRequest)
    }, "openai");
    const siderResponse = call.response;

    if (!siderResponse.ok) {
      // 统一错误出口: 门控响应与上游错误都已由租约按本协议渲染好, 这里只补失败统计
      recordFailure(modelName);
      return siderResponse;
    }

    console.log("✅ Sider 响应状态:", siderResponse.status);

    // 非流式响应
    if (!isStreaming) {
      return await handleNonStreamingResponse(call, modelName, fullContext, isImageGen, sessionInfo, outputLimits);
    }

    // 流式响应
    return handleStreamingResponse(call, modelName, isImageGen, sessionInfo, outputLimits, fullContext);

  } catch (error: any) {
    console.error("❌ 处理请求异常:", error);
    recordFailure(modelName); // 失败统计: 异常出口
    return handlerFailureResponse("openai", error);
  }
}

// 处理非流式响应
async function handleNonStreamingResponse(
  call: UpstreamCall,
  modelName: string,
  userPrompt: string,
  isImageGen: boolean,
  session: SessionInfo,
  outputLimits: OutputLimitOptions = {},
): Promise<Response> {
  const siderResponse = call.response;
  let fullText = "";
  let reasoningContentAcc = "";
  let imageUrl = "";
  let imageData: any = null;
  let conversationId = "";
  let messageId = "";
  let parentMessageId = "";
  let upstreamErrCode = 0;
  let upstreamErrMsg = "";

  const reader = siderResponse.body?.getReader();
  if (!reader) {
    throw new Error("无法获取响应流");
  }

  for await (const ev of iterateSiderEvents(reader, {
    onBusinessError: (code, msg) => call.reportBusinessError(code, msg),
    onValidData: () => call.reportSuccess(),
  })) {
    if (ev.kind === "business_error") {
      upstreamErrCode = ev.code;
      upstreamErrMsg = ev.msg || upstreamErrMsg;
      continue;
    }
    if (ev.kind !== "data") continue;
    const data = ev.data;

    switch (data.type) {
      case "message_start":
        conversationId = data.message_start.cid || "";
        messageId = data.message_start.assistant_message_id || "";
        parentMessageId = data.message_start.parent_message_id || "";
        console.log("📝 会话信息:", { conversationId, messageId, parentMessageId });

        // 只有调用方显式回传 X-Session-ID 时才把会话写进存储
        if (session.reusable) {
          conversationSessions.set(session.id, {
            cid: conversationId,
            parent_message_id: messageId, // 下一轮使用当前 assistant 消息作为 parent
            created_at: conversationSessions.get(session.id)?.created_at || Date.now(),
            last_used: Date.now()
          });
        }
        break;

      case "text":
        fullText += data.text || "";
        break;

      case "file":
        if (data.file.type === "image") {
          imageUrl = data.file.url;
          imageData = data.file;
          console.log("🖼️ 收到图像:", imageUrl);
        }
        break;

      case "reasoning_content":
        // Think 模式: 收集上游思考流 (经探针确认 SUPPORTED)
        const rc2 = data.reasoning_content;
        if (typeof rc2 === "object" && rc2 !== null && "text" in rc2) {
          reasoningContentAcc += (rc2 as Record<string,unknown>).text as string || "";
        }
        break;

      case "tool_call":
        console.log("🔧 工具调用:", data.tool_call);
        break;
    }
  }
  // 响应体已消费完: 结算租约 (成功/失败判定 + 释放槽位)
  call.complete();

  // 构建 OpenAI 格式响应
  if (upstreamErrCode !== 0 && !fullText && !imageUrl) {
    recordFailure(modelName);
    // 门控学习已在消费事件时完成 (与是否输出过正文无关), 这里只负责渲染给客户端
    return protocolErrorResponse("openai", call.describeBusinessError(upstreamErrCode, upstreamErrMsg));
  }

  if (!fullText && !imageUrl) {
    recordFailure(modelName);
    return new Response(JSON.stringify({
      error: {
        message: "上游响应没有生成任何文本内容。",
        type: "upstream_error",
      },
    }), {
      status: 502,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }

  const limited = applyOutputLimits(fullText, outputLimits);
  let content = limited.text;

  // 图像生成优化: 在文本中添加Markdown格式的图片URL (双保险)
  if (isImageGen && imageUrl) {
    content = `${limited.text || "我已为您生成了图像"}\n\n![图片](${imageUrl})`;
  }

  const openAIResponse: any = {
    id: messageId || `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: modelName,
    choices: [{
      message: {
        role: "assistant",
        content: content
      },
      finish_reason: openAIFinishReason(limited.stopReason),
      index: 0
    }],
    usage: {
      prompt_tokens: estimateTokens(userPrompt),
      completion_tokens: estimateTokens(content),
      total_tokens: estimateTokens(userPrompt) + estimateTokens(content)
    }
  };

  if (limited.stopSequence) {
    openAIResponse.choices[0].stop_sequence = limited.stopSequence;
  }

  // 携带推理内容 (think 模式非流式), 兼容 Anthropic/Ollama 风格
  if (reasoningContentAcc) {
    openAIResponse.choices[0].message.reasoning_content = reasoningContentAcc;
  }

  // 如果是图像生成,添加结构化图像数据
  if (isImageGen && imageUrl) {
    // 添加图像URL数组到message中
    openAIResponse.choices[0].message.image_urls = [imageUrl];

    // 添加访问指引
    openAIResponse.choices[0].message.image_access_guide = {
      method: "browser_required",
      reason: "Sider CDN使用CloudFront签名Cookie认证,服务器无法访问",
      how_to_access: [
        "1. 复制下方的图像URL",
        "2. 在浏览器新标签页中打开URL",
        "3. 如已登录Sider插件,图像将正常显示",
        "4. 也可访问 sider.ai 查看生成历史"
      ],
      test_result: "已测试6种认证方式,全部返回403",
      technical_details: "CDN需要: CloudFront-Key-Pair-Id, CloudFront-Policy, CloudFront-Signature"
    };

    // 添加CDN限制说明
    openAIResponse.cdn_limitation = {
      can_server_download: false,
      authentication_type: "CloudFront-Signed-Cookies",
      missing_credentials: [
        "CloudFront-Key-Pair-Id",
        "CloudFront-Policy",
        "CloudFront-Signature"
      ],
      alternative_methods: [
        "在浏览器中直接访问URL(需登录Sider插件)",
        "访问Sider官网查看生成历史",
        "使用Sider官方客户端"
      ]
    };
  }

  // 保留原有的image_data字段(兼容性)
  if (imageData) {
    openAIResponse.image_data = imageData;
  }

  // 用量统计: 非流式 OpenAI chat 请求
  recordUsage({
    model: modelName,
    stream: false,
    ms: 0, // 非流式耗时未单独计时; 以时间戳近似
    toolUses: [], // 非流式路径上游工具调用仅打日志, 不解析工具名
    inputChars: userPrompt.length,
    outputChars: content.length,
  });

  return new Response(JSON.stringify(openAIResponse), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "X-Session-ID": session.id,
      "X-Conversation-ID": conversationId
    }
  });
}

// 处理流式响应
function handleStreamingResponse(
  call: UpstreamCall,
  modelName: string,
  isImageGen: boolean,
  session: SessionInfo,
  outputLimits: OutputLimitOptions = {},
  inputText = "",
): Response {
  const siderResponse = call.response;
  let conversationId = "";

  const stream = new ReadableStream({
    async start(controller) {
      const reader = siderResponse.body?.getReader();
      if (!reader) {
        controller.error(new Error("无法获取响应流"));
        call.release();
        return;
      }

      const encoder = new TextEncoder();
      const hb = createSSEHeartbeat(controller, encoder, COMMENT_PING_FRAME);
      let hasStarted = false;
      let firstChunkAt: number | null = null;
      const streamT0 = Date.now();
      let imageUrls: string[] = [];  // 收集图像URL
      let imageDataList: any[] = [];  // 收集图像数据
      // 用量统计累积: 输出字符数 + 触发的内置工具名 (Set 去重)
      let streamOutputChars = 0;
      const streamToolNames = new Set<string>();
      const textLimiter = createStreamingOutputLimiter(outputLimits);

      // 流式请求完成时统一采集 (正常出口调用)
      const finishStreamStats = () => {
        recordUsage({
          model: modelName,
          stream: true,
          ms: Date.now() - streamT0,
          toolUses: [...streamToolNames],
          inputChars: inputText.length,
          outputChars: streamOutputChars,
        });
      };

      const enqueueTextChunk = (text: string, finishReason: "stop" | "length" | null = null) => {
        if (!text && finishReason === null) return;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          id: `chatcmpl-${Date.now()}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: modelName,
          choices: [{
            delta: text ? { content: text } : {},
            finish_reason: finishReason,
            index: 0
          }]
        })}\n\n`));
      };

      const finishOpenAIStream = async (reason: OutputStopReason = "end_turn") => {
        enqueueTextChunk("", openAIFinishReason(reason));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        await new Promise(resolve => setTimeout(resolve, 50));
        finishStreamStats();
        hb.close();
      };

      try {
        for await (const ev of iterateSiderEvents(reader, {
          onBusinessError: (code, msg) => call.reportBusinessError(code, msg),
          onValidData: () => call.reportSuccess(),
        })) {
          if (ev.kind === "done") {
            const flushed = textLimiter.flush();
            if (flushed.text) {
              streamOutputChars += flushed.text.length;
              enqueueTextChunk(flushed.text);
            }

            // 如果是图像生成且收集到了图像,在DONE前发送元数据chunk
            if (isImageGen && imageUrls.length > 0) {
              const metadataChunk = {
                id: `chatcmpl-${Date.now()}`,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model: modelName,
                choices: [{
                  delta: {
                    // 不添加content,仅添加元数据
                  },
                  finish_reason: null,
                  index: 0
                }],
                // 添加图像元数据
                image_urls: imageUrls,
                image_access_guide: {
                  method: "browser_required",
                  reason: "Sider CDN使用CloudFront签名Cookie认证,服务器无法访问",
                  how_to_access: [
                    "1. 复制下方的图像URL",
                    "2. 在浏览器新标签页中打开URL",
                    "3. 如已登录Sider插件,图像将正常显示",
                    "4. 也可访问 sider.ai 查看生成历史"
                  ],
                  test_result: "已测试6种认证方式,全部返回403",
                  technical_details: "CDN需要: CloudFront-Key-Pair-Id, CloudFront-Policy, CloudFront-Signature"
                },
                cdn_limitation: {
                  can_server_download: false,
                  authentication_type: "CloudFront-Signed-Cookies",
                  missing_credentials: [
                    "CloudFront-Key-Pair-Id",
                    "CloudFront-Policy",
                    "CloudFront-Signature"
                  ],
                  alternative_methods: [
                    "在浏览器中直接访问URL(需登录Sider插件)",
                    "访问Sider官网查看生成历史",
                    "使用Sider官方客户端"
                  ]
                },
                image_data: imageDataList.length > 0 ? imageDataList : undefined
              };

              const metaChunk = `data: ${JSON.stringify(metadataChunk)}\n\n`;
              controller.enqueue(encoder.encode(metaChunk));

              // 等待一小段时间确保数据被flush到网络
              await new Promise(resolve => setTimeout(resolve, 100));
            }

            await finishOpenAIStream(flushed.stopReason);
            call.complete();
            return;
          }

          if (ev.kind === "business_error") {
            console.error(`❌ 上游流内错误: code=${ev.code} msg=${ev.msg}`);
            if (streamOutputChars === 0 && imageUrls.length === 0) {
              const detail = call.describeBusinessError(ev.code, ev.msg);
              const errChunk = {
                id: `chatcmpl-${Date.now()}`,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model: modelName,
                choices: [{
                  delta: {},
                  finish_reason: "error",
                  index: 0
                }],
                error: { code: ev.code, message: detail.message, type: detail.type }
              };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(errChunk)}\n\n`));
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              finishStreamStats();
              hb.close();
              call.complete();
              return;
            }
            continue;
          }

          const data = ev.data;
          let openAIChunk: any = null;

          switch (data.type) {
            case "message_start":
              conversationId = data.message_start.cid || "";
              const messageId = data.message_start.assistant_message_id || "";
              console.log("📝 流式会话开始:", conversationId);

              // 只有调用方显式回传 X-Session-ID 时才把会话写进存储
              if (session.reusable) {
                conversationSessions.set(session.id, {
                  cid: conversationId,
                  parent_message_id: messageId,
                  created_at: conversationSessions.get(session.id)?.created_at || Date.now(),
                  last_used: Date.now()
                });
              }
              break;

            case "text":
              if (!hasStarted) {
                hasStarted = true;
              }
              if (firstChunkAt === null) {
                firstChunkAt = Date.now();
                console.log("⏱️ TTFT(ms):", firstChunkAt - streamT0);
              }
              const textResult = textLimiter.push(data.text || "");
              if (textResult.text) {
                streamOutputChars += textResult.text.length;
                enqueueTextChunk(textResult.text);
              }
              if (textResult.done) {
                await finishOpenAIStream(textResult.stopReason || "end_turn");
                call.complete();
                return;
              }
              break;

            case "file":
              if (data.file.type === "image") {
                const imageUrl = data.file.url;

                // 收集图像URL和数据
                imageUrls.push(imageUrl);
                imageDataList.push(data.file);

                if (firstChunkAt === null) {
                  firstChunkAt = Date.now();
                  console.log("⏱️ TTFT(ms):", firstChunkAt - streamT0);
                }
                // 发送文本提示 + Markdown格式的图片URL (双保险)
                openAIChunk = {
                  id: `chatcmpl-${Date.now()}`,
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model: modelName,
                  choices: [{
                    delta: {
                      content: `\n我已为您生成了图像\n\n![图片](${imageUrl})\n`
                    },
                    finish_reason: null,
                    index: 0
                  }]
                };
              }
              break;

            case "tool_call":
              console.log("🔧 工具调用状态:", data.tool_call.status);
              // 用量统计: 收集触发的内置工具名 (tool_call.name, 经探针确认存在)
              const tcName = data.tool_call?.name;
              if (tcName) streamToolNames.add(tcName);
              break;

            case "reasoning_content":
              // Think 模式: 上游独立流式返回思考过程 (经探针确认 SUPPORTED)
              if (firstChunkAt === null) {
                firstChunkAt = Date.now();
                console.log("⏱️ TTFT(ms) (reasoning):", firstChunkAt - streamT0);
              }
              const rc = data.reasoning_content;
              const reasoningText = (typeof rc === "object" && rc !== null && "text" in rc)
                ? (rc as Record<string,unknown>).text as string
                : "";
              if (reasoningText) {
                openAIChunk = {
                  id: `chatcmpl-${Date.now()}`,
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model: modelName,
                  choices: [{
                    delta: {
                      // 使用 OpenAI 兼容字段 (非标准扩展): reasoning_content
                      // 上游 reasoning_content 结构与 text 事件类似,
                      // 在 delta 中暴露 reasoning_content 字符串供前端使用
                      reasoning_content: reasoningText
                    },
                    finish_reason: null,
                    index: 0
                  }]
                };
              }
              break;

            case "pulse":
              // 心跳,忽略
              break;

            case "credit_info":
              console.log("💳 额度信息:", data.credit_info);
              break;
          }

          if (openAIChunk) {
            const chunk = `data: ${JSON.stringify(openAIChunk)}\n\n`;
            controller.enqueue(encoder.encode(chunk));
          }
        }

        const flushed = textLimiter.flush();
        if (flushed.text) {
          streamOutputChars += flushed.text.length;
          enqueueTextChunk(flushed.text);
        }
        await finishOpenAIStream(flushed.stopReason);
        call.complete();

      } catch (error) {
        console.error("❌ 流式处理错误:", error);
        call.release();
        const detail = upstreamErrorFromException(error);
        if (detail && !hb.closed) {
          // 头已经发出去了, 改不了 HTTP 状态码; 至少把超时如实告诉客户端
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({
              id: `chatcmpl-${Date.now()}`,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: modelName,
              choices: [{ delta: {}, finish_reason: "error", index: 0 }],
              error: { code: detail.statusCode, message: detail.message, type: detail.type },
            })}\n\n`));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          } catch { /* 已关闭 */ }
          hb.close();
          return;
        }
        hb.fail(error);
      }
    },
    cancel() {
      // 客户端提前断开: 立即结算并释放上游并发槽位
      call.release();
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
      "X-Session-ID": session.id,
      "X-Conversation-ID": conversationId
    }
  });
}

// 处理图像生成请求(专用端点)
async function handleImageGeneration(req: Request): Promise<Response> {
  let model = "dall-e-3"; // 函数级: catch 出口的失败统计也要用
  try {
    const requestBody = await req.json();
    console.log("🎨 收到图像生成请求:", requestBody);

    // ==================== 参数验证和标准化 (OpenAI API 兼容) ====================

    // 必需参数
    const prompt = requestBody.prompt;
    if (!prompt || typeof prompt !== "string" || prompt.trim() === "") {
      return new Response(JSON.stringify({
        error: {
          message: "参数 'prompt' 是必需的,且必须是非空字符串",
          type: "invalid_request_error",
          param: "prompt"
        }
      }), {
        status: 400,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }

    // 可选参数 - 完全符合 OpenAI 标准
    model = requestBody.model || "dall-e-3";  // 默认模型
    const n = Math.min(Math.max(parseInt(requestBody.n) || 1, 1), 10);  // 1-10 之间
    const size = requestBody.size || "1024x1024";  // 支持: 256x256, 512x512, 1024x1024, 1024x1792, 1792x1024
    const quality = requestBody.quality || "standard";  // standard 或 hd

    // response_format 验证
    const responseFormat = requestBody.response_format || "url";

    // ⚠️ 暂时禁用 b64_json 格式
    // Sider CDN 需要特殊的认证机制,标准的 Bearer Token 无法访问
    // 详见: docs/HTTP403下载错误修复报告_20251205.md
    if (responseFormat === "b64_json") {
      return new Response(JSON.stringify({
        error: {
          message: "参数 'response_format' 不支持 'b64_json' 格式。Sider CDN 认证机制限制,暂时只支持 'url' 格式。",
          type: "invalid_request_error",
          param: "response_format",
          code: "b64_json_not_supported"
        }
      }), {
        status: 400,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }

    if (responseFormat !== "url") {
      return new Response(JSON.stringify({
        error: {
          message: `参数 'response_format' 必须是 'url',收到: '${responseFormat}'`,
          type: "invalid_request_error",
          param: "response_format"
        }
      }), {
        status: 400,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }

    console.log("✅ 参数验证通过:", {
      model, n, size, quality, responseFormat,
      promptLength: prompt.length
    });

    // ==================== 构建 Sider 请求 ====================

    const siderRequest = JSON.parse(JSON.stringify(DEFAULT_REQUEST_TEMPLATE));

    // 构建图像生成提示词
    const imagePrompt = `请使用图像生成工具创建图片。图片内容: ${prompt}`;

    siderRequest.multi_content = [{
      type: "text",
      text: imagePrompt,
      user_input_text: imagePrompt
    }];

    // 设置工具配置
    // OpenAI quality → Sider 映射:
    //   standard → nano_banana, hd → nano_banana_pro
    //   非标扩展: quality="fast" → nano_banana_2 (低质量/快速出图)
    // 上游合法枚举: nano_banana / nano_banana_2 / nano_banana_pro (经探针确认)
    let qualityLevel = "nano_banana";
    if (quality === "hd") {
      qualityLevel = "nano_banana_pro";
    } else if (quality === "fast") {
      qualityLevel = "nano_banana_2";
    }
    siderRequest.tools = {
      image: {
        quality_level: qualityLevel
      },
      auto: ["create_image", "data_analysis", "search"]
    };

    // 图像端点【不套用】文本端点的"未知模型即拒绝"策略: 这里的 model 走的是 OpenAI 图像
    // 模型命名空间 (dall-e-2/3、gpt-image-1 等), 它们本来就不在 MODEL_MAPPING 里,
    // 上游 sider 也没有对应条目。故仍回退到智能路由, 由 sider 自己决定用哪个出图模型。
    siderRequest.model = MODEL_MAPPING[model] || "sider";
    siderRequest.stream = true; // 图像生成必须使用流式以接收图像

    console.log("🚀 发送图像生成请求到 Sider");
    console.log("📋 请求配置:", {
      tools: siderRequest.tools,
      model: siderRequest.model,
      stream: siderRequest.stream,
      promptLength: imagePrompt.length
    });

    // 图像生成必须用流式接收图像; 三段超时/排队/配额/错误分类统一由 UpstreamLease 负责
    const call = await fetchSiderRateLimited(siderRequest.model, SIDER_API_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SIDER_AUTH_TOKEN}`,
        "Accept": "*/*",
        "Origin": "chrome-extension://dhoenijjpgpeimemopealfcbiecgceod",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "X-App-Name": "ChitChat_Edge_Ext",
        "X-App-Version": "5.21.2"
      },
      body: JSON.stringify(siderRequest)
    }, "openai");
    const siderResponse = call.response;

    if (!siderResponse.ok) {
      // 统一错误出口: 门控响应与上游错误都已由租约按本协议渲染好
      recordFailure(MODEL_MAPPING[model] || "sider");
      return siderResponse;
    }

    // 收集图像 URL (改进的流处理逻辑)
    const imageUrls: string[] = [];
    const reader = siderResponse.body?.getReader();
    if (!reader) {
      call.release();
      throw new Error("无法获取响应流");
    }

    let lineCount = 0;
    let hasToolCall = false;
    let hasDoneMarker = false;
    const maxWaitTime = 60000; // 最多等待60秒
    const startTime = Date.now();
    let upstreamErrCode = 0;
    let upstreamErrMsg = "";

    console.log("📡 开始读取 SSE 流...");

    for await (const ev of iterateSiderEvents(reader, {
      onBusinessError: (code, msg) => call.reportBusinessError(code, msg),
      onValidData: () => call.reportSuccess(),
    })) {
      lineCount++;

      // 超时检查
      if (Date.now() - startTime > maxWaitTime) {
        console.warn("⚠️ 等待超时,停止读取");
        break;
      }

      if (ev.kind === "business_error") {
        upstreamErrCode = ev.code;
        upstreamErrMsg = ev.msg;
        console.error(`❌ Sider API 错误 [行${lineCount}]:`, { code: ev.code, msg: ev.msg });
        if (imageUrls.length === 0) {
          recordFailure(MODEL_MAPPING[model] || "sider");
          call.complete();
          return protocolErrorResponse("openai", call.describeBusinessError(ev.code, ev.msg));
        }
        continue;
      }

      if (ev.kind === "done") {
        console.log(`📊 收到 [DONE] 标记 (行 ${lineCount})`);
        hasDoneMarker = true;

        // 如果已经有图像了,可以退出
        if (imageUrls.length > 0) {
          console.log(`✅ 已收集到 ${imageUrls.length} 个图像,准备结束`);
          break;
        }

        // 如果还没有图像,继续等待一小段时间
        if (hasToolCall) {
          console.log("⚠️ 已看到工具调用但未收到图像,继续等待...");
          continue;
        }
        console.warn("⚠️ 收到 [DONE] 但未看到工具调用,可能图像生成失败");
        break;
      }

      const data = ev.data;

      // 🐛 调试: 打印前若干条事件结构
      if (lineCount <= 10) {
        console.log(`🔍 [行${lineCount}] 事件数据:`, JSON.stringify(data).substring(0, 200));
      }

      const dataType = data.type;
      console.log(`📦 [行${lineCount}] 收到数据类型: ${dataType}`);

      switch (dataType) {
        case "message_start":
          console.log("🚀 会话开始");
          break;

        case "tool_call":
          hasToolCall = true;
          console.log(`🔧 工具调用: ${data.tool_call.status} (hasToolCall 已设置为 true)`);
          if (data.tool_call.status === "processing") {
            console.log("⏳ 图像生成中...");
          } else if (data.tool_call.status === "start") {
            console.log("🎬 工具调用已启动");
          } else if (data.tool_call.status === "finish") {
            console.log("✅ 工具调用已完成");
          }
          break;

        case "file":
          if (data.file.type === "image") {
            imageUrls.push(data.file.url);
            console.log(`✅ 图像生成成功 (${imageUrls.length}/${n}):`, data.file.url);
            console.log(`📏 图像尺寸: ${data.file.width}x${data.file.height}`);
          }
          break;

        case "pulse":
          // 心跳信号,表示还在处理中
          console.log("💓 心跳信号 (处理中...)");
          break;

        case "credit_info":
          console.log("💳 额度信息");
          break;

        case "text":
          // 某些情况下可能有文本响应
          if (data.text) {
            console.log("💬 文本内容:", data.text.substring(0, 50));
          }
          break;

        default:
          console.log(`ℹ️ 未处理的数据类型: ${dataType}`);
      }

      // 如果已经收集到足够的图像,退出
      if (imageUrls.length >= n) {
        console.log(`🎯 目标达成: 收集到 ${imageUrls.length} 个图像`);
        break;
      }
    }

    // 提前 break 时, iterateSiderEvents 的 finally 会 cancel 上游 reader, 槽位及时释放
    call.complete();

    console.log(`\n📊 流处理完成统计:`);
    console.log(`   - 总行数: ${lineCount}`);
    console.log(`   - 是否有工具调用: ${hasToolCall ? "是" : "否"}`);
    console.log(`   - 是否收到 [DONE]: ${hasDoneMarker ? "是" : "否"}`);
    console.log(`   - 收集到的图像数: ${imageUrls.length}`);
    if (upstreamErrCode !== 0) {
      console.warn(`   - 上游业务码: ${upstreamErrCode} (${upstreamErrMsg})`);
    }

    // 增强的错误处理
    if (imageUrls.length === 0) {
      // 提供更详细的错误信息
      let errorMessage = "未能获取生成的图像";
      const debugInfo = {
        totalLines: lineCount,
        hadToolCall: hasToolCall,
        hadDone: hasDoneMarker,
        timeElapsed: Date.now() - startTime
      };

      if (!hasToolCall) {
        errorMessage += " - 未检测到图像生成工具调用";
      } else if (hasDoneMarker) {
        errorMessage += " - 流已正常结束但未收到图像数据";
      } else {
        errorMessage += " - 流异常结束";
      }

      console.error(`❌ ${errorMessage}`);
      console.error("🔍 调试信息:", debugInfo);

      throw new Error(`${errorMessage}。调试信息: ${JSON.stringify(debugInfo)}`);
    }

    console.log(`✅ 成功收集到 ${imageUrls.length} 个图像`);

    // 用量统计: 图像生成请求
    recordUsage({
      model: MODEL_MAPPING[model] || "sider",
      stream: true,
      ms: 0,
      toolUses: ["create_image"],
      inputChars: prompt.length,
      outputChars: 0,
    });

    // 返回 URL 格式 (b64_json 已禁用)
    const responseData = {
      created: Math.floor(Date.now() / 1000),
      data: imageUrls.slice(0, n).map(url => ({
        url: url,
        revised_prompt: prompt
      }))
    };

    return new Response(JSON.stringify(responseData), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      }
    });

  } catch (error: any) {
    console.error("❌ 处理请求异常:", error);
    recordFailure(MODEL_MAPPING[model] || "sider"); // 失败统计: 异常/上游错误出口
    return handlerFailureResponse("openai", error);
  }
}

// ==================== Gemini 格式处理 ====================

// Gemini 格式: contents[] → messages[] 入站适配
function geminiToMessages(body: any): { messages: any[] } {
  const messages: any[] = [];

  // systemInstruction
  if (body.systemInstruction && body.systemInstruction.parts) {
    const text = body.systemInstruction.parts.map((p: any) => p.text || "").join("\n");
    if (text) {
      messages.push({ role: "system", content: text });
    }
  }

  // contents[]
  for (const c of (body.contents || [])) {
    const role = c.role === "model" ? "assistant" : (c.role || "user");
    const parts = c.parts || [];
    const textParts: string[] = [];
    for (const p of parts) {
      if (p.text !== undefined) {
        textParts.push(p.text);
      }
    }
    messages.push({ role, content: textParts.join("\n") });
  }

  return { messages };
}

// Gemini 非流式响应构建
function buildGeminiResponse(
  content: string, reasoning: string, modelName: string,
  finishReason = "STOP",
  inputText = "",
): any {
  const parts: any[] = [];
  if (content) {
    parts.push({ text: content });
  } else {
    parts.push({ text: "" });
  }

  const resp: any = {
    candidates: [{
      content: { role: "model", parts },
      finishReason,
      index: 0,
    }],
    usageMetadata: {
      promptTokenCount: estimateTokens(inputText),
      candidatesTokenCount: estimateTokens(content),
      totalTokenCount: estimateTokens(inputText) + estimateTokens(content),
    },
  };
  // Gemini 扩展: thought (思考内容)
  if (reasoning) {
    resp.candidates[0].thought = reasoning;
  }
  return resp;
}

// 处理 Gemini 请求 (非流式 + 流式)
async function handleGeminiGenerate(
  req: Request, geminiModel: string, isStream: boolean
): Promise<Response> {
  try {
    const body = await req.json();
    console.log(`📥 Gemini ${isStream ? "stream" : "generate"}: model=${geminiModel}`);
    const outputLimits = geminiOutputLimits(body);

    // 入站适配: Gemini → messages[]
    const { messages } = geminiToMessages(body);

    // 能力门控: Gemini contents.parts 内含 inline_data/file_data (图像) => not_supported
    const geminiHasVision = (body.contents || []).some((c: any) =>
      Array.isArray(c?.parts) && c.parts.some((p: any) =>
        p && (p.inline_data || p.inlineData || p.file_data || p.fileData)));
    if (geminiHasVision) {
      console.warn("⛔ Gemini 收到视觉输入, 上游不支持; 返回 not_supported。");
      recordFailure(geminiModel); // 失败统计: 能力门控拒绝
      return notSupportedResponse(
        "gemini",
        "上游 sider 不支持视觉输入 (图像理解)。请仅发送文本。",
        "vision_not_supported",
      );
    }

    if (!messages.length) {
      return protocolErrorResponse("gemini", {
        statusCode: 400,
        type: "invalid_request_error",
        message: "contents array is empty or invalid",
      });
    }

    // 能力门控: Gemini 的 tools[].functionDeclarations 是自定义函数声明 -> 上游不支持。
    // 与 Chat 端点同契约: toolConfig.functionCallingConfig.mode="NONE" 视为"明确不要工具",
    // 正常放行; 其余一律协议原生 not_supported, 不做静默降级。
    const geminiHasFunctions = (Array.isArray(body.tools) ? body.tools : []).some((t: any) =>
      Array.isArray(t?.functionDeclarations) || Array.isArray(t?.function_declarations));
    const geminiToolConfig = body.toolConfig ?? body.tool_config;
    const geminiMode = String(geminiToolConfig?.functionCallingConfig?.mode ?? "").toUpperCase();
    if (geminiHasFunctions && geminiMode !== "NONE") {
      console.warn("⛔ Gemini 收到自定义函数声明, 上游不支持; 返回 not_supported。");
      recordFailure(geminiModel);
      return notSupportedResponse(
        "gemini",
        "上游 sider 不支持自定义 function calling (tools[].functionDeclarations)。" +
        "内置工具由模型自主触发; 若确实不需要工具, 请设 toolConfig.functionCallingConfig.mode = \"NONE\"。",
        "tools_not_supported",
      );
    }

    // 未知模型一律拒绝 (P2), 与 Chat 端点同契约
    const siderModel = resolveSiderModel(geminiModel);
    if (siderModel === null) {
      console.warn(`⛔ 未知模型: ${geminiModel}`);
      recordFailure(geminiModel);
      return modelNotFoundResponse("gemini", geminiModel);
    }

    const isThink = shouldEnableThinkMode(geminiModel);
    const lastMsg = messages[messages.length - 1];
    const prompt = typeof lastMsg?.content === "string" ? lastMsg.content : "";

    // 上下文预算: 与其余三个端点共用实现 (旧代码直接拼接全部历史, 长对话会撞上游 603)
    const ctx = buildBoundedContext(messages);
    if (ctx.overflow) {
      console.warn("⛔ Gemini 上下文固定部分自身超限, 本地拒绝 (不消耗上游额度)");
      recordFailure(geminiModel);
      return contextOverflowResponse("gemini");
    }
    logContextTruncation("gemini", geminiModel, ctx);
    const fullContext = ctx.text;

    // 构建 Sider 上游请求
    const siderRequest = JSON.parse(JSON.stringify(DEFAULT_REQUEST_TEMPLATE));
    siderRequest.model = siderModel;
    siderRequest.stream = true; // 始终流式读上游
    siderRequest.think_mode = { enable: isThink };
    siderRequest.multi_content = [{
      type: "text", text: fullContext, user_input_text: fullContext,
    }];

    const enableSearch = shouldEnableAutoSearch(prompt);
    siderRequest.tools = {
      auto: enableSearch ? ["search", "data_analysis"] : ["data_analysis"]
    };

    // 发送上游请求: 三段超时/排队/配额/错误分类统一由 UpstreamLease 负责
    const call = await fetchSiderRateLimited(siderModel, SIDER_API_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SIDER_AUTH_TOKEN}`,
        "Accept": "*/*",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Origin": "chrome-extension://dhoenijjpgpeimemopealfcbiecgceod",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "X-App-Name": "ChitChat_Edge_Ext",
        "X-App-Version": "5.21.2"
      },
      body: JSON.stringify(siderRequest)
    }, "gemini");
    const siderResponse = call.response;

    if (!siderResponse.ok) {
      // 统一错误出口: 上游错误已由租约按 Gemini 原生结构渲染
      recordFailure(geminiModel);
      return siderResponse;
    }

    // ===== 非流式: 消费上游流, 聚合后返回 Gemini 格式 =====
    if (!isStream) {
      let fullText = "", reasoningAcc = "";
      let upstreamErrCode = 0;
      let upstreamErrMsg = "";
      const reader = siderResponse.body?.getReader();
      if (!reader) throw new Error("无法获取响应流");
      for await (const ev of iterateSiderEvents(reader, {
        onBusinessError: (code, msg) => call.reportBusinessError(code, msg),
        onValidData: () => call.reportSuccess(),
      })) {
        if (ev.kind === "business_error") {
          upstreamErrCode = ev.code;
          upstreamErrMsg = ev.msg || upstreamErrMsg;
          continue;
        }
        if (ev.kind !== "data") continue;
        const d = ev.data;
        if (d.type === "text" && d.text) fullText += d.text;
        if (d.type === "reasoning_content") {
          const rc = d.reasoning_content;
          if (typeof rc === "object" && rc !== null && "text" in rc) {
            reasoningAcc += (rc as Record<string, unknown>).text as string || "";
          }
        }
      }
      call.complete();
      if (upstreamErrCode !== 0 && !fullText) {
        recordFailure(geminiModel);
        return protocolErrorResponse("gemini", call.describeBusinessError(upstreamErrCode, upstreamErrMsg));
      }
      if (!fullText) {
        recordFailure(geminiModel);
        return new Response(JSON.stringify({
          error: { message: "上游响应没有生成任何文本内容。", type: "upstream_error" }
        }), { status: 502, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
      }
      const limited = applyOutputLimits(fullText, outputLimits);
      // 用量统计: Gemini 非流式
      recordUsage({
        model: geminiModel,
        stream: false,
        ms: 0,
        toolUses: [],
        inputChars: prompt.length,
        outputChars: limited.text.length,
      });
      const geminiResp = buildGeminiResponse(
        limited.text,
        reasoningAcc,
        geminiModel,
        geminiFinishReason(limited.stopReason),
        fullContext,
      );
      return new Response(JSON.stringify(geminiResp), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    // ===== 流式: SSE 逐块翻译 =====
    // Gemini 官方 streamGenerateContent 没有 [DONE] 终止符: 以带 finishReason 的最终
    // 候选事件收尾, 然后直接关闭连接。多发一个 [DONE] 会让严格按 spec 实现的客户端
    // (如 google-genai) 解析到非 Gemini 结构。
    const stream = new ReadableStream({
      async start(controller) {
        const reader = siderResponse.body?.getReader();
        if (!reader) {
          controller.error(new Error("无法获取响应流"));
          call.release();
          return;
        }
        const encoder = new TextEncoder();
        const hb = createSSEHeartbeat(controller, encoder, COMMENT_PING_FRAME);
        // 用量统计累积
        const gT0 = Date.now();
        let gOutputChars = 0;
        const gTools = new Set<string>();
        const textLimiter = createStreamingOutputLimiter(outputLimits);
        const finishGeminiStats = () => {
          recordUsage({
            model: geminiModel,
            stream: true,
            ms: Date.now() - gT0,
            toolUses: [...gTools],
            inputChars: prompt.length,
            outputChars: gOutputChars,
          });
        };

        const enqueueGeminiText = (text: string, finishReason?: "STOP" | "MAX_TOKENS") => {
          if (!text && !finishReason) return;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({
            candidates: [{
              content: { role: "model", parts: text ? [{ text }] : [] },
              ...(finishReason ? { finishReason } : {}),
              index: 0,
            }],
          })}\n\n`));
        };

        // 收尾: 发一个只带 finishReason 的最终事件, 然后关流 —— 不再发 [DONE]
        const finishGeminiStream = (reason: OutputStopReason = "end_turn") => {
          enqueueGeminiText("", geminiFinishReason(reason));
          finishGeminiStats();
          hb.close();
        };

        try {
          for await (const ev of iterateSiderEvents(reader, {
            onBusinessError: (code, msg) => call.reportBusinessError(code, msg),
            onValidData: () => call.reportSuccess(),
          })) {
            if (ev.kind === "done") {
              const flushed = textLimiter.flush();
              if (flushed.text) {
                gOutputChars += flushed.text.length;
                enqueueGeminiText(flushed.text);
              }
              finishGeminiStream(flushed.stopReason);
              call.complete();
              return;
            }

            if (ev.kind === "business_error") {
              const detail = call.describeBusinessError(ev.code, ev.msg);
              if (gOutputChars === 0) {
                // 还没吐出任何正文: 以 Gemini 原生错误事件收尾 (同样不发 [DONE])
                controller.enqueue(encoder.encode(
                  `data: ${JSON.stringify(protocolErrorPayload("gemini", detail))}\n\n`,
                ));
                finishGeminiStats();
                hb.close();
                call.complete();
                return;
              }
              continue;
            }

            const d = ev.data;
            // 累积输出字符 (text) 与工具名 (tool_call)
            if (d.type === "tool_call" && d.tool_call?.name) gTools.add(d.tool_call.name);

            let geminiChunk: any = null;
            if (d.type === "text" && d.text) {
              const textResult = textLimiter.push(d.text);
              if (textResult.text) {
                gOutputChars += textResult.text.length;
                enqueueGeminiText(textResult.text);
              }
              if (textResult.done) {
                finishGeminiStream(textResult.stopReason || "end_turn");
                call.complete();
                return;
              }
            } else if (d.type === "reasoning_content") {
              const rc = d.reasoning_content;
              const rt = (typeof rc === "object" && rc !== null && "text" in rc)
                ? (rc as Record<string, unknown>).text as string : "";
              if (rt) {
                geminiChunk = {
                  candidates: [{
                    content: { role: "model", parts: [] },
                    thought: rt,
                    index: 0,
                  }],
                };
              }
            }

            if (geminiChunk) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(geminiChunk)}\n\n`));
            }
          }

          const flushed = textLimiter.flush();
          if (flushed.text) {
            gOutputChars += flushed.text.length;
            enqueueGeminiText(flushed.text);
          }
          finishGeminiStream(flushed.stopReason);
          call.complete();
        } catch (err: any) {
          console.error("❌ Gemini流式错误:", err);
          call.release();
          const detail = upstreamErrorFromException(err);
          if (detail && !hb.closed) {
            try {
              controller.enqueue(encoder.encode(
                `data: ${JSON.stringify(protocolErrorPayload("gemini", detail))}\n\n`,
              ));
            } catch { /* 已关闭 */ }
            hb.close();
            return;
          }
          hb.fail(err);
        }
      },
      cancel() {
        // 客户端提前断开: 立即结算并释放上游并发槽位
        call.release();
      }
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      }
    });
  } catch (error: any) {
    console.error("❌ 处理请求异常:", error);
    recordFailure(geminiModel); // 失败统计: 异常出口
    return handlerFailureResponse("gemini", error);
  }
}

// ==================== Anthropic 格式处理 ====================

// Anthropic Messages API 入站适配: messages[] + system → 内部 messages[]
function anthropicToMessages(body: any): { messages: any[] } {
  const messages: any[] = [];

  // System 字段 (支持 string 和数组 [{type:"text",text:"..."}])
  const sys = body.system;
  if (typeof sys === "string" && sys.trim()) {
    messages.push({ role: "system", content: sys });
  } else if (Array.isArray(sys)) {
    const text = sys.map((s: any) => s.text || "").join("\n");
    if (text.trim()) messages.push({ role: "system", content: text });
  }

  // Messages[]
  for (const m of (body.messages || [])) {
    const role = m.role === "assistant" ? "assistant" : "user";
    let content = "";
    if (typeof m.content === "string") {
      content = m.content;
    } else if (Array.isArray(m.content)) {
      // Anthropic content 块: [{type:"text",text:"..."}]
      content = m.content
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text || "")
        .join("\n");
    }
    messages.push({ role, content });
  }

  return { messages };
}

// Anthropic 非流式响应构建
function buildAnthropicResponse(
  id: string, content: string, modelName: string, reasoning: string,
  stopReason: OutputStopReason = "end_turn", usage: any = null, stopSequence?: string,
): any {
  const resp: any = {
    id,
    type: "message",
    role: "assistant",
    model: modelName,
    content: [{ type: "text", text: content }],
    stop_reason: stopReason,
  };
  if (stopSequence) {
    resp.stop_sequence = stopSequence;
  }
  if (reasoning) {
    resp.content.unshift({ type: "thinking", thinking: reasoning });
  }
  if (usage) {
    resp.usage = usage;
  }
  return resp;
}

// 处理 Anthropic 请求 (非流式 + 流式)
async function handleAnthropicMessage(req: Request): Promise<Response> {
  let anthroModel = "claude-sonnet-4.6"; // 函数级: catch 出口的失败统计也要用
  try {
    const body = await req.json();
    const isStream = body.stream === true;
    console.log(`📥 Anthropic ${isStream ? "stream" : "message"}: model=${body.model}`);
    const outputLimits = anthropicOutputLimits(body);

    const { messages } = anthropicToMessages(body);

    // 提前赋值模型名: 视觉门控等早期出口的失败统计需要真实模型 (而非默认值)
    anthroModel = body.model || "claude-sonnet-4.6";

    // 能力门控: Anthropic content 块含 {type:"image",source:{...}} => not_supported
    const anthroHasVision = (body.messages || []).some((m: any) =>
      Array.isArray(m?.content) && m.content.some((b: any) =>
        b && (b.type === "image" || b.source)));
    if (anthroHasVision) {
      console.warn("⛔ Anthropic 收到视觉输入, 上游不支持; 返回 not_supported。");
      recordFailure(anthroModel); // 失败统计: 能力门控拒绝
      return notSupportedResponse(
        "anthropic",
        "上游 sider 不支持视觉输入 (图像理解)。请仅发送文本。",
        "vision_not_supported",
      );
    }

    // 能力门控: Anthropic tools[] 是自定义函数声明 -> 上游不支持。
    // 与 Chat / Gemini 同契约: tool_choice.type="none" 视为"明确不要工具", 正常放行;
    // 其余一律协议原生 not_supported, 不做静默降级。
    const anthroToolsRequested = Array.isArray(body.tools) && body.tools.length > 0;
    const anthroToolChoice = body.tool_choice;
    const anthroToolNone = anthroToolChoice?.type === "none" || anthroToolChoice === "none";
    if (anthroToolsRequested && !anthroToolNone) {
      console.warn("⛔ Anthropic 收到自定义 tools, 上游不支持; 返回 not_supported。");
      recordFailure(anthroModel);
      return notSupportedResponse(
        "anthropic",
        "上游 sider 不支持自定义 function calling (tools)。" +
        "内置工具由模型自主触发; 若确实不需要工具, 请传 tool_choice = {\"type\":\"none\"}。",
        "tools_not_supported",
      );
    }

    if (!messages.length) {
      return protocolErrorResponse("anthropic", {
        statusCode: 400,
        type: "invalid_request_error",
        message: "messages array is empty or invalid",
      });
    }

    // 未知模型一律拒绝 (P2), 与 Chat / Gemini 端点同契约
    const siderModel = resolveSiderModel(anthroModel);
    if (siderModel === null) {
      console.warn(`⛔ 未知模型: ${anthroModel}`);
      recordFailure(anthroModel);
      return modelNotFoundResponse("anthropic", anthroModel);
    }

    const isThink = shouldEnableThinkMode(anthroModel);
    const msgId = `msg_${Date.now()}`;
    const lastContent = messages[messages.length - 1]?.content;
    const prompt = typeof lastContent === "string" ? lastContent : "";

    // 上下文预算: 与其余三个端点共用实现 (旧代码直接拼接全部历史, 长对话会撞上游 603)
    const ctx = buildBoundedContext(messages);
    if (ctx.overflow) {
      console.warn("⛔ Anthropic 上下文固定部分自身超限, 本地拒绝 (不消耗上游额度)");
      recordFailure(anthroModel);
      return contextOverflowResponse("anthropic");
    }
    logContextTruncation("anthropic", anthroModel, ctx);
    const fullContext = ctx.text;

    const enableSearch = shouldEnableAutoSearch(prompt);

    // 构建 Sider 上游请求
    const siderRequest = JSON.parse(JSON.stringify(DEFAULT_REQUEST_TEMPLATE));
    siderRequest.model = siderModel;
    siderRequest.stream = true;
    siderRequest.think_mode = { enable: isThink };
    siderRequest.multi_content = [{
      type: "text", text: fullContext, user_input_text: fullContext,
    }];
    siderRequest.tools = {
      auto: enableSearch ? ["search", "data_analysis"] : ["data_analysis"],
    };

    // 发送上游请求: 三段超时/排队/配额/错误分类统一由 UpstreamLease 负责
    const call = await fetchSiderRateLimited(siderModel, SIDER_API_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json", Authorization: `Bearer ${SIDER_AUTH_TOKEN}`,
        "Accept": "*/*", "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Origin": "chrome-extension://dhoenijjpgpeimemopealfcbiecgceod",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "X-App-Name": "ChitChat_Edge_Ext", "X-App-Version": "5.21.2",
      },
      body: JSON.stringify(siderRequest),
    }, "anthropic");
    const siderResp = call.response;

    if (!siderResp.ok) {
      // 统一错误出口: 上游错误已由租约按 Anthropic 原生结构渲染
      recordFailure(anthroModel);
      return siderResp;
    }

    // ---- 非流式 ----
    if (!isStream) {
      let fullText = "", reasoningAcc = "";
      let upstreamErrCode = 0;
      let upstreamErrMsg = "";
      const reader = siderResp.body?.getReader();
      if (!reader) throw new Error("无法获取响应流");
      for await (const ev of iterateSiderEvents(reader, {
        onBusinessError: (code, msg) => call.reportBusinessError(code, msg),
        onValidData: () => call.reportSuccess(),
      })) {
        if (ev.kind === "business_error") {
          upstreamErrCode = ev.code;
          upstreamErrMsg = ev.msg || upstreamErrMsg;
          continue;
        }
        if (ev.kind !== "data") continue;
        const d = ev.data;
        if (d.type === "text" && d.text) fullText += d.text;
        if (d.type === "reasoning_content") {
          const rc = d.reasoning_content;
          if (typeof rc === "object" && rc !== null && "text" in rc) {
            reasoningAcc += (rc as Record<string, unknown>).text as string || "";
          }
        }
      }
      call.complete();
      if (upstreamErrCode !== 0 && !fullText) {
        recordFailure(anthroModel);
        return protocolErrorResponse("anthropic", call.describeBusinessError(upstreamErrCode, upstreamErrMsg));
      }
      if (!fullText) {
        recordFailure(anthroModel);
        return protocolErrorResponse("anthropic", {
          statusCode: 502,
          type: "upstream_error",
          message: "上游响应没有生成任何文本内容。",
        });
      }
      const limited = applyOutputLimits(fullText, outputLimits);
      // 用量统计: Anthropic 非流式
      recordUsage({
        model: anthroModel,
        stream: false,
        ms: 0,
        toolUses: [],
        inputChars: prompt.length,
        outputChars: limited.text.length,
      });
      const resp = buildAnthropicResponse(
        msgId,
        limited.text,
        anthroModel,
        reasoningAcc,
        limited.stopReason,
        {
          input_tokens: estimateTokens(fullContext),
          output_tokens: estimateTokens(reasoningAcc + limited.text),
        },
        limited.stopSequence,
      );
      return new Response(JSON.stringify(resp), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    // ---- 流式: Anthropic SSE 事件序列 (content-block 状态机) ----
    // 惰性开块 + 单调 index + 成对 start/stop; reasoning_content->thinking, text->text。
    const sstream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const reader = siderResp.body?.getReader();
        if (!reader) {
          controller.error(new Error("无响应流"));
          call.release();
          return;
        }
        const encoder = new TextEncoder();
        const hb = createSSEHeartbeat(controller, encoder, ANTHROPIC_PING_FRAME);

        const sendEvent = (event: string, data: any) => {
          if (hb.closed) return;
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        };

        // 状态机: started 保证 message_start 只发一次; blockIndex 单调递增;
        // currentBlock 记录当前开启的块类型, 切换类型前先 closeBlock。
        let started = false;
        let blockIndex = -1;
        let currentBlock: "text" | "thinking" | null = null;
        let outputChars = 0;
        let outputTextAcc = "";
        const textLimiter = createStreamingOutputLimiter(outputLimits);
        // 用量统计累积: 工具名 (Set 去重) + 计时
        const anthroT0 = Date.now();
        const anthroTools = new Set<string>();
        const finishAnthroStats = () => {
          recordUsage({
            model: anthroModel,
            stream: true,
            ms: Date.now() - anthroT0,
            toolUses: [...anthroTools],
            inputChars: fullContext.length,
            outputChars,
          });
        };

        const ensureStart = () => {
          if (started) return;
          started = true;
          sendEvent("message_start", {
            type: "message_start",
            message: {
              id: msgId, type: "message", role: "assistant", model: anthroModel,
              content: [], stop_reason: null, stop_sequence: null,
              usage: { input_tokens: estimateTokens(fullContext), output_tokens: 0 },
            },
          });
        };
        const closeBlock = () => {
          if (currentBlock !== null) {
            sendEvent("content_block_stop", { type: "content_block_stop", index: blockIndex });
            currentBlock = null;
          }
        };
        const openBlock = (type: "text" | "thinking") => {
          closeBlock();
          blockIndex += 1;
          currentBlock = type;
          sendEvent("content_block_start", {
            type: "content_block_start",
            index: blockIndex,
            content_block: type === "thinking"
              ? { type: "thinking", thinking: "" }
              : { type: "text", text: "" },
          });
        };
        const finishOk = (reason: OutputStopReason = "end_turn", stopSequence: string | null = null) => {
          ensureStart();
          closeBlock();
          sendEvent("message_delta", {
            type: "message_delta",
            delta: { stop_reason: reason, stop_sequence: stopSequence },
            usage: { output_tokens: estimateTokens(outputTextAcc) },
          });
          sendEvent("message_stop", { type: "message_stop" });
          finishAnthroStats();
          hb.close();
        };

        try {
          ensureStart();

          for await (const ev of iterateSiderEvents(reader, {
            onBusinessError: (code, msg) => call.reportBusinessError(code, msg),
            onValidData: () => call.reportSuccess(),
          })) {
            if (ev.kind === "done") {
              const flushed = textLimiter.flush();
              if (flushed.text) {
                if (currentBlock !== "text") openBlock("text");
                outputChars += flushed.text.length;
                outputTextAcc += flushed.text;
                sendEvent("content_block_delta", {
                  type: "content_block_delta",
                  index: blockIndex,
                  delta: { type: "text_delta", text: flushed.text },
                });
              }
              finishOk(flushed.stopReason);
              call.complete();
              return;
            }

            if (ev.kind === "business_error") {
              if (outputTextAcc.length === 0) {
                closeBlock();
                sendEvent("error", protocolErrorPayload("anthropic", call.describeBusinessError(ev.code, ev.msg)));
                sendEvent("message_stop", { type: "message_stop" });
                finishAnthroStats();
                hb.close();
                call.complete();
                return;
              }
              continue;
            }

            const d = ev.data;
            if (d.type === "text" && d.text) {
              if (currentBlock !== "text") openBlock("text");
              const textResult = textLimiter.push(d.text);
              if (textResult.text) {
                outputChars += textResult.text.length;
                outputTextAcc += textResult.text;
                sendEvent("content_block_delta", {
                  type: "content_block_delta",
                  index: blockIndex,
                  delta: { type: "text_delta", text: textResult.text },
                });
              }
              if (textResult.done) {
                finishOk(textResult.stopReason || "end_turn", textResult.stopSequence || null);
                call.complete();
                return;
              }
            } else if (d.type === "reasoning_content") {
              const rc = d.reasoning_content;
              const rt = (typeof rc === "object" && rc !== null && "text" in rc)
                ? (rc as Record<string, unknown>).text as string : "";
              if (rt) {
                if (currentBlock !== "thinking") openBlock("thinking");
                sendEvent("content_block_delta", {
                  type: "content_block_delta",
                  index: blockIndex,
                  delta: { type: "thinking_delta", thinking: rt },
                });
              }
            } else if (d.type === "tool_call" && d.tool_call?.name) {
              // 用量统计: 收集触发的内置工具名
              anthroTools.add(d.tool_call.name);
            }
          }

          // 上游未显式发 [DONE] 就结束的兜底
          const flushed = textLimiter.flush();
          if (flushed.text) {
            if (currentBlock !== "text") openBlock("text");
            outputChars += flushed.text.length;
            outputTextAcc += flushed.text;
            sendEvent("content_block_delta", {
              type: "content_block_delta",
              index: blockIndex,
              delta: { type: "text_delta", text: flushed.text },
            });
          }
          finishOk(flushed.stopReason);
          call.complete();
        } catch (err: any) {
          console.error("❌ Anthropic流错误:", err);
          call.release();
          if (!hb.closed) {
            closeBlock();
            sendEvent("error", protocolErrorPayload("anthropic",
              upstreamErrorFromException(err) ?? {
                statusCode: 502,
                type: "upstream_error",
                message: err?.message || "stream error",
              }));
            sendEvent("message_stop", { type: "message_stop" });
          }
          finishAnthroStats();
          hb.close();
        }
      },
      cancel() {
        // 客户端提前断开: 立即结算并释放上游并发槽位
        call.release();
      },
    });

    return new Response(sstream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache", "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error: any) {
    console.error("❌ 处理请求异常:", error);
    recordFailure(anthroModel); // 失败统计: 异常出口
    return handlerFailureResponse("anthropic", error);
  }
}

// ==================== OpenAI Responses API 格式处理 ====================

// Responses API 入站适配: input(字符串/数组) + instructions → messages[]
function responsesToMessages(body: any): { messages: any[]; prompt: string; unsupportedType?: string } {
  const messages: any[] = [];

  // instructions → system message
  if (body.instructions && typeof body.instructions === "string" && body.instructions.trim()) {
    messages.push({ role: "system", content: body.instructions });
  }

  // input
  const input = body.input;
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
  } else if (Array.isArray(input)) {
    for (const m of input) {
      if (!m || typeof m !== "object") {
        return { messages: [], prompt: "", unsupportedType: typeof m };
      }
      if (m.type && m.type !== "message") {
        return { messages: [], prompt: "", unsupportedType: String(m.type) };
      }
      const role = String(m.role || "user");
      if (!new Set(["user", "assistant", "system", "developer"]).has(role)) {
        return { messages: [], prompt: "", unsupportedType: `role:${role}` };
      }
      let content = "";
      if (typeof m.content === "string") {
        content = m.content;
      } else if (Array.isArray(m.content)) {
        const textParts: string[] = [];
        for (const block of m.content) {
          const type = block?.type;
          if (!block || typeof block.text !== "string" ||
            !new Set(["text", "input_text", "output_text"]).has(type)) {
            return { messages: [], prompt: "", unsupportedType: String(type || typeof block) };
          }
          textParts.push(block.text);
        }
        content = textParts.join("\n");
      } else {
        return { messages: [], prompt: "", unsupportedType: typeof m.content };
      }
      messages.push({ role, content });
    }
  }

  const lastContent = messages[messages.length - 1]?.content;
  const prompt = typeof lastContent === "string" ? lastContent : "";
  return { messages, prompt };
}

// Responses API 非流式响应构建
function buildResponsesResponse(
  id: string, content: string, modelName: string, reasoning: string,
  inputText = "", stopReason: OutputStopReason = "end_turn",
): any {
  const output: any[] = [];
  // 如果有推理内容, 先放 reasoning
  if (reasoning) {
    output.push({
      type: "reasoning", id: `rs_${Date.now()}`, summary: [],
      content: [{ type: "reasoning_text", text: reasoning }],
    });
  }
  output.push({
    type: "message", role: "assistant", id: `msg_${Date.now()}`,
    content: [{ type: "output_text", text: content }],
  });

  const resp: any = {
    id, object: "response",
    model: modelName,
    output,
    status: stopReason === "max_tokens" ? "incomplete" : "completed",
    usage: {
      input_tokens: estimateTokens(inputText),
      output_tokens: estimateTokens(content),
      total_tokens: estimateTokens(inputText) + estimateTokens(content),
    },
  };
  if (stopReason === "max_tokens") {
    resp.incomplete_details = { reason: "max_output_tokens" };
  }
  return resp;
}

async function handleOpenAIResponse(req: Request): Promise<Response> {
  let modelName = "sider"; // 函数级: catch 出口的失败统计也要用
  try {
    const body = await req.json();
    const isStream = body.stream === true;
    console.log(`📥 Responses ${isStream ? "stream" : "nonstream"}: model=${body.model}`);
    const outputLimits = responsesOutputLimits(body);

    const { messages, prompt, unsupportedType } = responsesToMessages(body);

    // 能力门控: Responses input 数组含 input_image 块 => not_supported
    const respHasVision = Array.isArray(body.input) && body.input.some((m: any) =>
      Array.isArray(m?.content) && m.content.some((b: any) =>
        b && (b.type === "input_image" || b.type === "image_url" || b.image_url)));
    if (respHasVision) {
      console.warn("⛔ Responses 收到视觉输入, 上游不支持; 返回 not_supported。");
      recordFailure(modelName); // 失败统计: 能力门控拒绝
      return notSupportedResponse(
        "responses",
        "上游 sider 不支持视觉输入 (图像理解)。请仅发送文本。",
        "vision_not_supported",
      );
    }

    if (unsupportedType) {
      console.warn(`⛔ Responses 收到不支持的输入类型: ${unsupportedType}`);
      recordFailure(modelName);
      return notSupportedResponse(
        "responses",
        `Responses 输入类型 ${unsupportedType} 暂不支持；仅支持字符串或文本消息块。`,
        "input_type_not_supported",
      );
    }

    // 能力门控: Responses tools[] 里的自定义 function 声明 -> 上游不支持。
    // 与 Chat / Gemini / Anthropic 同契约: tool_choice="none" 放行, 其余协议原生 not_supported。
    const respHasFunctions = (Array.isArray(body.tools) ? body.tools : []).some((t: any) =>
      t && (t.type === "function" || t.function));
    if (respHasFunctions && body.tool_choice !== "none") {
      console.warn("⛔ Responses 收到自定义 function tools, 上游不支持; 返回 not_supported。");
      recordFailure(modelName);
      return notSupportedResponse(
        "responses",
        "上游 sider 不支持自定义 function calling (tools)。" +
        "内置工具由模型自主触发; 若确实不需要工具, 请传 tool_choice = \"none\"。",
        "tools_not_supported",
      );
    }

    if (!messages.length) {
      return protocolErrorResponse("responses", {
        statusCode: 400,
        type: "invalid_request_error",
        param: "input",
        message: "input is required",
      });
    }

    modelName = body.model || "sider";
    // 未知模型一律拒绝 (P2), 与其余三个端点同契约
    const siderModel = resolveSiderModel(modelName);
    if (siderModel === null) {
      console.warn(`⛔ 未知模型: ${modelName}`);
      recordFailure(modelName);
      return modelNotFoundResponse("responses", modelName);
    }

    const isThink = shouldEnableThinkMode(modelName);
    const respId = `resp_${Date.now()}`;

    // 上下文预算: 与其余三个端点共用实现 (旧代码直接拼接全部历史, 长对话会撞上游 603)
    const ctx = buildBoundedContext(messages);
    if (ctx.overflow) {
      console.warn("⛔ Responses 上下文固定部分自身超限, 本地拒绝 (不消耗上游额度)");
      recordFailure(modelName);
      return contextOverflowResponse("responses");
    }
    logContextTruncation("responses", modelName, ctx);
    const fullContext = ctx.text;

    const enableSearch = shouldEnableAutoSearch(prompt);

    // 构建 Sider 上游请求
    const siderRequest = JSON.parse(JSON.stringify(DEFAULT_REQUEST_TEMPLATE));
    siderRequest.model = siderModel;
    siderRequest.stream = true;
    siderRequest.think_mode = { enable: isThink };
    siderRequest.multi_content = [{
      type: "text", text: fullContext, user_input_text: fullContext,
    }];
    siderRequest.tools = {
      auto: enableSearch ? ["search", "data_analysis"] : ["data_analysis"],
    };

    // 发送上游请求: 三段超时/排队/配额/错误分类统一由 UpstreamLease 负责
    const call = await fetchSiderRateLimited(siderModel, SIDER_API_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json", Authorization: `Bearer ${SIDER_AUTH_TOKEN}`,
        "Accept": "*/*", "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Origin": "chrome-extension://dhoenijjpgpeimemopealfcbiecgceod",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "X-App-Name": "ChitChat_Edge_Ext", "X-App-Version": "5.21.2",
      },
      body: JSON.stringify(siderRequest),
    }, "responses");
    const siderResp = call.response;

    if (!siderResp.ok) {
      // 统一错误出口: 上游错误已由租约按 OpenAI/Responses 错误结构渲染
      recordFailure(modelName);
      return siderResp;
    }

    // ---- 非流式 ----
    if (!isStream) {
      let fullText = "", reasoningAcc = "";
      let upstreamErrCode = 0;
      let upstreamErrMsg = "";
      const reader = siderResp.body?.getReader();
      if (!reader) throw new Error("无法获取响应流");
      for await (const ev of iterateSiderEvents(reader, {
        onBusinessError: (code, msg) => call.reportBusinessError(code, msg),
        onValidData: () => call.reportSuccess(),
      })) {
        if (ev.kind === "business_error") {
          upstreamErrCode = ev.code;
          upstreamErrMsg = ev.msg || upstreamErrMsg;
          continue;
        }
        if (ev.kind !== "data") continue;
        const d = ev.data;
        if (d.type === "text" && d.text) fullText += d.text;
        if (d.type === "reasoning_content") {
          const rc = d.reasoning_content;
          if (typeof rc === "object" && rc !== null && "text" in rc) {
            reasoningAcc += (rc as Record<string, unknown>).text as string || "";
          }
        }
      }
      call.complete();
      if (upstreamErrCode !== 0 && !fullText) {
        recordFailure(modelName);
        return protocolErrorResponse("responses", call.describeBusinessError(upstreamErrCode, upstreamErrMsg));
      }
      if (!fullText) {
        recordFailure(modelName);
        return protocolErrorResponse("responses", {
          statusCode: 502,
          type: "upstream_error",
          message: "上游响应没有生成任何文本内容。",
        });
      }
      const limited = applyOutputLimits(fullText, outputLimits);
      // 用量统计: Responses 非流式
      recordUsage({
        model: modelName,
        stream: false,
        ms: 0,
        toolUses: [],
        inputChars: prompt.length,
        outputChars: limited.text.length,
      });
      const respData = buildResponsesResponse(respId, limited.text, modelName, reasoningAcc, fullContext, limited.stopReason);
      return new Response(JSON.stringify(respData), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    // ---- 流式: Responses API SSE ----
    const respStream = new ReadableStream({
      async start(controller) {
        const reader = siderResp.body?.getReader();
        if (!reader) {
          controller.error(new Error("无响应流"));
          call.release();
          return;
        }
        const encoder = new TextEncoder();
        const hb = createSSEHeartbeat(controller, encoder, COMMENT_PING_FRAME);
        // 用量统计累积
        const rT0 = Date.now();
        let rOutputChars = 0;
        let outputTextAcc = "";
        const rTools = new Set<string>();
        const textLimiter = createStreamingOutputLimiter(outputLimits);
        const finishResponsesStats = () => {
          recordUsage({
            model: modelName,
            stream: true,
            ms: Date.now() - rT0,
            toolUses: [...rTools],
            inputChars: prompt.length,
            outputChars: rOutputChars,
          });
        };

        const sendEvent = (event: string, data: any) => {
          if (hb.closed) return;
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        };

        const itemId = `msg_${Date.now()}`;
        const initialResp: any = {
          object: "response", id: respId, model: modelName,
          output: [], status: "in_progress",
        };
        sendEvent("response.created", { type: "response.created", response: initialResp });
        sendEvent("response.in_progress", { type: "response.in_progress", response: initialResp });

        // 惰性开块: 只有真的产出正文时才补 output_item.added / content_part.added。
        // 旧实现在建流时就直接发了一个"delta 为空、且 item_id/output_index 全缺"的
        // response.output_text.delta, 既不符合官方事件契约, 也让客户端拿到悬空事件。
        let itemOpened = false;
        const ensureItem = () => {
          if (itemOpened) return;
          itemOpened = true;
          sendEvent("response.output_item.added", {
            type: "response.output_item.added",
            output_index: 0,
            item: { id: itemId, type: "message", status: "in_progress", role: "assistant", content: [] },
          });
          sendEvent("response.content_part.added", {
            type: "response.content_part.added",
            item_id: itemId, output_index: 0, content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
          });
        };
        const outputTextPart = () => ({ type: "output_text", text: outputTextAcc, annotations: [] });
        const outputItem = (status: string) => ({
          id: itemId, type: "message", status, role: "assistant", content: [outputTextPart()],
        });

        const sendDelta = (text: string) => {
          ensureItem();
          rOutputChars += text.length;
          outputTextAcc += text;
          sendEvent("response.output_text.delta", {
            type: "response.output_text.delta",
            item_id: itemId,
            output_index: 0,
            content_index: 0,
            delta: text,
          });
        };

        // 收尾事件序列: output_text.done -> content_part.done -> output_item.done
        // -> response.completed, 之后直接关流。
        // 官方 Responses 流式契约是【类型化语义事件】, 未定义 [DONE] 终止符。
        const finishResponsesStream = (reason: OutputStopReason = "end_turn") => {
          const status = reason === "max_tokens" ? "incomplete" : "completed";
          if (itemOpened) {
            sendEvent("response.output_text.done", {
              type: "response.output_text.done",
              item_id: itemId, output_index: 0, content_index: 0, text: outputTextAcc,
            });
            sendEvent("response.content_part.done", {
              type: "response.content_part.done",
              item_id: itemId, output_index: 0, content_index: 0, part: outputTextPart(),
            });
            sendEvent("response.output_item.done", {
              type: "response.output_item.done",
              output_index: 0,
              item: outputItem("completed"),
            });
          }
          const completedResp: any = {
            ...initialResp,
            status,
            output: itemOpened ? [outputItem("completed")] : [],
            usage: {
              input_tokens: estimateTokens(fullContext),
              output_tokens: estimateTokens(outputTextAcc),
              total_tokens: estimateTokens(fullContext) + estimateTokens(outputTextAcc),
            },
          };
          if (reason === "max_tokens") {
            completedResp.incomplete_details = { reason: "max_output_tokens" };
          }
          sendEvent("response.completed", { type: "response.completed", response: completedResp });
          finishResponsesStats();
          hb.close();
        };

        try {
          for await (const ev of iterateSiderEvents(reader, {
            onBusinessError: (code, msg) => call.reportBusinessError(code, msg),
            onValidData: () => call.reportSuccess(),
          })) {
            if (ev.kind === "done") {
              const flushed = textLimiter.flush();
              if (flushed.text) sendDelta(flushed.text);
              finishResponsesStream(flushed.stopReason);
              call.complete();
              return;
            }

            if (ev.kind === "business_error") {
              if (outputTextAcc.length === 0) {
                sendEvent("error", protocolErrorPayload("responses", call.describeBusinessError(ev.code, ev.msg)));
                finishResponsesStats();
                hb.close();
                call.complete();
                return;
              }
              continue;
            }

            const d = ev.data;
            if (d.type === "text" && d.text) {
              const textResult = textLimiter.push(d.text);
              if (textResult.text) sendDelta(textResult.text);
              if (textResult.done) {
                finishResponsesStream(textResult.stopReason || "end_turn");
                call.complete();
                return;
              }
            }
            if (d.type === "tool_call" && d.tool_call?.name) {
              rTools.add(d.tool_call.name);
            }
            // reasoning_content ignored in responses stream (kept simple)
          }
          const flushed = textLimiter.flush();
          if (flushed.text) sendDelta(flushed.text);
          finishResponsesStream(flushed.stopReason);
          call.complete();
        } catch (err: any) {
          console.error("❌ Responses流错误:", err);
          call.release();
          const detail = upstreamErrorFromException(err);
          if (detail) {
            sendEvent("error", protocolErrorPayload("responses", detail));
            finishResponsesStats();
            hb.close();
            return;
          }
          finishResponsesStats();
          hb.fail(err);
        }
      },
      cancel() {
        // 客户端提前断开: 立即结算并释放上游并发槽位
        call.release();
      },
    });

    return new Response(respStream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache", "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error: any) {
    console.error("❌ 处理请求异常:", error);
    recordFailure(modelName); // 失败统计: 异常出口
    return handlerFailureResponse("responses", error);
  }
}

// ==================== 内嵌管理界面HTML (Deploy环境) ====================

function getEmbeddedAdminHTML(): string {
  const hasAuth = AUTH_TOKEN ? true : false;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sider2API 管理界面 (Deno Deploy)</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      padding: 20px;
    }
    .container {
      max-width: 1200px;
      margin: 0 auto;
    }
    .auth-container {
      max-width: 400px;
      margin: 100px auto;
      background: white;
      padding: 40px;
      border-radius: 12px;
      box-shadow: 0 10px 40px rgba(0,0,0,0.2);
    }
    .auth-container h2 {
      text-align: center;
      color: #333;
      margin-bottom: 30px;
    }
    .auth-container input {
      width: 100%;
      padding: 12px;
      border: 2px solid #ddd;
      border-radius: 6px;
      font-size: 14px;
      margin-bottom: 15px;
    }
    .auth-container button {
      width: 100%;
      padding: 12px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      border: none;
      border-radius: 6px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      transition: transform 0.2s;
    }
    .auth-container button:hover {
      transform: translateY(-2px);
    }
    .error {
      background: #fee;
      color: #c33;
      padding: 10px;
      border-radius: 6px;
      margin-bottom: 15px;
      text-align: center;
      display: none;
    }
    .notice {
      background: #fff3cd;
      border-left: 4px solid #ffc107;
      padding: 15px;
      border-radius: 8px;
      margin-bottom: 20px;
    }
    .notice strong {
      color: #856404;
      display: block;
      margin-bottom: 5px;
    }
    .card {
      background: white;
      padding: 20px;
      border-radius: 12px;
      margin-bottom: 20px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.1);
    }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 15px;
      margin-bottom: 20px;
    }
    .stat-card {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 20px;
      border-radius: 8px;
      text-align: center;
    }
    .stat-card h3 {
      font-size: 32px;
      margin-bottom: 5px;
    }
    .stat-card p {
      opacity: 0.9;
      font-size: 14px;
    }
    .hidden {
      display: none;
    }
    h1 {
      color: white;
      margin-bottom: 20px;
      text-align: center;
    }
  </style>
</head>
<body>
  ${hasAuth ? `
  <!-- 认证表单 -->
  <div id="authContainer" class="auth-container">
    <h2>🔐 管理界面认证</h2>
    <div id="authError" class="error">认证失败,请检查密码</div>
    <input type="password" id="authToken" placeholder="请输入 AUTH_TOKEN" />
    <button onclick="authenticate()">登录</button>
  </div>
  ` : ''}

  <!-- 主界面 -->
  <div id="mainContainer" class="container ${hasAuth ? 'hidden' : ''}">
    <h1>🚀 Sider2API 管理界面</h1>

    <div class="notice">
      <strong>⚠️ Deno Deploy 版本提示</strong>
      <p>当前运行在 Deno Deploy 环境中。自定义模型仅存储在内存中,重启后会丢失。</p>
      <p>💡 建议:通过环境变量 <code>CUSTOM_MODELS</code> 预配置自定义模型。</p>
    </div>

    <div class="stats-grid">
      <div class="stat-card">
        <h3 id="builtInCount">-</h3>
        <p>内置模型</p>
      </div>
      <div class="stat-card">
        <h3 id="customCount">-</h3>
        <p>自定义模型</p>
      </div>
      <div class="stat-card">
        <h3 id="sessionCount">-</h3>
        <p>活跃会话</p>
      </div>
      <div class="stat-card">
        <h3>✅</h3>
        <p>服务状态</p>
      </div>
    </div>

    <div class="card">
      <h2>📊 功能说明</h2>
      <ul style="line-height: 2; padding-left: 20px;">
        <li>✅ 所有 API 端点正常可用</li>
        <li>✅ 支持 29+ 内置模型</li>
        <li>✅ 文本对话 + 图像生成</li>
        <li>✅ 多轮对话 + Think 模式</li>
        <li>⚠️ 自定义模型仅内存存储 (重启丢失)</li>
        <li>💡 完整管理功能请使用本地版本</li>
      </ul>
    </div>

    <div class="card">
      <h2>🔗 API 端点</h2>
      <ul style="line-height: 2; padding-left: 20px;">
        <li><strong>GET /v1/models</strong> - 获取模型列表</li>
        <li><strong>POST /v1/chat/completions</strong> - 文本对话</li>
        <li><strong>POST /v1/images/generations</strong> - 图像生成</li>
        <li><strong>GET /api/admin/models</strong> - 管理API:获取所有模型</li>
        <li><strong>GET /api/admin/stats</strong> - 管理API:获取统计信息</li>
      </ul>
    </div>
  </div>

  <script>
    const hasAuth = ${hasAuth};
    let authToken = null;

    // 检查是否已认证
    function checkAuth() {
      if (!hasAuth) return true;
      authToken = localStorage.getItem('admin_auth_token');
      if (authToken) {
        document.getElementById('authContainer').classList.add('hidden');
        document.getElementById('mainContainer').classList.remove('hidden');
        loadStats();
        return true;
      }
      return false;
    }

    // 认证函数
    async function authenticate() {
      const token = document.getElementById('authToken').value;
      const errorDiv = document.getElementById('authError');

      if (!token) {
        errorDiv.textContent = '请输入认证密码';
        errorDiv.style.display = 'block';
        return;
      }

      try {
        // 尝试访问管理API验证token
        const response = await fetch('/api/admin/stats', {
          headers: {
            'Authorization': 'Bearer ' + token
          }
        });

        if (response.ok) {
          // 认证成功
          localStorage.setItem('admin_auth_token', token);
          authToken = token;
          document.getElementById('authContainer').classList.add('hidden');
          document.getElementById('mainContainer').classList.remove('hidden');
          loadStats();
        } else {
          // 认证失败
          errorDiv.textContent = '认证失败,请检查密码';
          errorDiv.style.display = 'block';
        }
      } catch (error) {
        errorDiv.textContent = '认证请求失败: ' + error.message;
        errorDiv.style.display = 'block';
      }
    }

    // 加载统计信息
    async function loadStats() {
      try {
        const headers = {};
        if (authToken) {
          headers['Authorization'] = 'Bearer ' + authToken;
        }

        const response = await fetch('/api/admin/stats', { headers });
        if (response.ok) {
          const stats = await response.json();
          document.getElementById('builtInCount').textContent = stats.builtInModels;
          document.getElementById('customCount').textContent = stats.customModels;
          document.getElementById('sessionCount').textContent = stats.activeSessions;
        }
      } catch (error) {
        console.error('加载统计信息失败:', error);
      }
    }

    // 页面加载时检查认证状态
    if (checkAuth()) {
      loadStats();
      setInterval(loadStats, 30000); // 每30秒刷新
    }

    // 回车键提交
    if (hasAuth) {
      document.getElementById('authToken').addEventListener('keypress', function(e) {
        if (e.key === 'Enter') {
          authenticate();
        }
      });
    }
  </script>
</body>
</html>`;
}

// ==================== 用量统计页面渲染 ====================

// /stats 用量看板: 服务端把 StatsSnapshot 渲染成自包含 HTML (内联 SVG + CSS,
// 无外部依赖、无构建步骤), Deno Deploy 上零额外成本, 离线也能打开。
// 参考 sider2claude 的 stats-page.ts 设计; 本项目仅单上游 (sider), 去掉后端维度。
// 可视化: 模型分布环形图 + 表格, 字符使用趋势面积图, 工具调用频次条形, 最近请求表格。

function escHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 1234567 -> 1.23M, 与看板表格紧凑风格一致 */
function compactNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// 时间显示统一使用 UTC+8 (北京/上海时区), 与部署服务器所在时区 (Deno Deploy 为 UTC) 无关。
// 手动偏移 + getUTC* 比 toLocaleString(timeZone) 更可控, 不依赖 ICU/locale 数据。
function hhmm(iso: string): string {
  const d = new Date(iso);
  const utc8 = new Date(d.getTime() + 8 * 3600_000);
  return `${String(utc8.getUTCHours()).padStart(2, "0")}:${String(utc8.getUTCMinutes()).padStart(2, "0")}`;
}

// 分类槽位 1-8, 超出的模型折叠成「其他」而不是循环取色
const STATS_SERIES_COUNT = 8;

/** 环形图: 按模型请求数构成。返回 SVG 弧段。 */
function statsDonut(models: ModelStatRow[], total: number): string {
  // 分母一律用扇区数据之和 (与 models 同窗口口径), 忽略外部传入的 total,
  // 避免「分子是 24h 窗口、分母是累计全量」的口径错配导致圆环无法闭合。
  const shownTotal = models.reduce((s, m) => s + m.requests, 0);
  if (shownTotal === 0) {
    return `<circle cx="90" cy="90" r="62" fill="none" stroke="var(--grid)" stroke-width="26"/>
      <text x="90" y="90" class="donut-empty" text-anchor="middle" dominant-baseline="middle">暂无数据</text>`;
  }

  const R = 62;
  const C = 2 * Math.PI * R;
  let offset = 0;
  const arcs = models.map((m, i) => {
    const frac = m.requests / shownTotal;
    const len = frac * C;
    // 扇区间不留缝隙: 所有扇区长度之和 = 周长, 保证圆环始终完整闭合。
    const dash = `${len} ${C - len}`;
    const arc = `<circle cx="90" cy="90" r="${R}" fill="none"
      stroke="var(--s${i + 1})" stroke-width="26"
      stroke-dasharray="${dash}" stroke-dashoffset="${-offset}"
      transform="rotate(-90 90 90)">
      <title>${escHtml(m.model)}：${m.requests} 次请求（${Math.round(frac * 100)}%）</title>
    </circle>`;
    offset += len;
    return arc;
  }).join("");

  return `${arcs}
    <text x="90" y="82" class="donut-num" text-anchor="middle">${shownTotal}</text>
    <text x="90" y="102" class="donut-cap" text-anchor="middle">窗口请求</text>`;
}

/** 面积图: Token 使用趋势 + 调用失败曲线。单一 y 轴 (Token), 失败用独立缩放叠加。 */
function statsTrendChart(trend: TrendBucketRow[]): string {
  const W = 720;
  const H = 200;
  const PAD_L = 48;
  const PAD_B = 26;
  const PAD_T = 12;
  const plotW = W - PAD_L - 12;
  const plotH = H - PAD_B - PAD_T;

  const peak = Math.max(1, ...trend.map((b) => Math.max(b.inputChars, b.outputChars)));
  // 失败曲线独立缩放 (失败数远小于 Token 量级, 共用 y 轴会被压成一条线)
  const failPeak = Math.max(1, ...trend.map((b) => b.failures));
  const stepX = trend.length > 1 ? plotW / (trend.length - 1) : plotW;
  const x = (i: number) => PAD_L + i * stepX;
  const y = (v: number) => PAD_T + plotH - (v / peak) * plotH;
  const yFail = (v: number) => PAD_T + plotH - (v / failPeak) * plotH;

  const line = (pick: (b: TrendBucketRow) => number, yFn: (v: number) => number) =>
    trend.map((b, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${yFn(pick(b)).toFixed(1)}`).join(" ");
  const area = (pick: (b: TrendBucketRow) => number) =>
    `${line(pick, y)} L${x(trend.length - 1).toFixed(1)},${(PAD_T + plotH).toFixed(1)} L${x(0).toFixed(1)},${(PAD_T + plotH).toFixed(1)} Z`;

  // 5 条横向参考线 (Token 轴)
  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const gy = PAD_T + plotH - f * plotH;
    return `<line x1="${PAD_L}" y1="${gy.toFixed(1)}" x2="${W - 12}" y2="${gy.toFixed(1)}" class="grid"/>
      <text x="${PAD_L - 8}" y="${(gy + 4).toFixed(1)}" class="tick" text-anchor="end">${compactNum(Math.round(peak * f))}</text>`;
  }).join("");

  // x 轴每 6 桶标一次, 避免标签相撞
  const xLabels = trend.map((b, i) =>
    i % 6 === 0 || i === trend.length - 1
      ? `<text x="${x(i).toFixed(1)}" y="${H - 8}" class="tick" text-anchor="middle">${hhmm(b.at)}</text>`
      : ""
  ).join("");

  // 悬停热区: 整列可点, 命中目标远大于数据点本身
  const hotspots = trend.map((b, i) =>
    `<rect x="${(x(i) - stepX / 2).toFixed(1)}" y="${PAD_T}" width="${stepX.toFixed(1)}"
      height="${plotH}" fill="transparent">
      <title>${hhmm(b.at)}　请求 ${b.requests}　失败 ${b.failures}　输入 ${compactNum(b.inputChars)}　输出 ${compactNum(b.outputChars)}</title>
    </rect>`
  ).join("");

  return `<svg viewBox="0 0 ${W} ${H}" class="trend" role="img" aria-label="近 24 小时 Token 使用趋势与调用失败">
    ${grid}
    <path d="${area((b) => b.inputChars)}" fill="var(--s1)" opacity="0.14"/>
    <path d="${line((b) => b.inputChars, y)}" fill="none" stroke="var(--s1)" stroke-width="2" stroke-linejoin="round"/>
    <path d="${area((b) => b.outputChars)}" fill="var(--s2)" opacity="0.14"/>
    <path d="${line((b) => b.outputChars, y)}" fill="none" stroke="var(--s2)" stroke-width="2" stroke-linejoin="round"/>
    <path d="${line((b) => b.failures, yFail)}" fill="none" stroke="var(--s3)" stroke-width="2" stroke-linejoin="round" stroke-dasharray="4 3"/>
    ${xLabels}
    ${hotspots}
  </svg>`;
}

// ===== stats 区块 HTML 生成 (服务端渲染 + 前端 5s 局部刷新共用) =====
// 各区块生成函数独立, /stats 首屏与 /stats.json 的 html 片段都调用它们,
// 保证刷新前后渲染逻辑一致 (不会因两套模板产生闪烁/抖动)。

/** 折叠模型: 超过槽位数的模型合并为「其他」。返回展示用模型数组。 */
function statsShownModels(snapshot: StatsSnapshot): ModelStatRow[] {
  const shown = snapshot.models.slice(0, STATS_SERIES_COUNT);
  const rest = snapshot.models.slice(STATS_SERIES_COUNT);
  if (rest.length > 0) {
    shown.push({
      model: `其他 ${rest.length} 个模型`,
      requests: rest.reduce((s, m) => s + m.requests, 0),
      failures: rest.reduce((s, m) => s + m.failures, 0),
      inputChars: rest.reduce((s, m) => s + m.inputChars, 0),
      outputChars: rest.reduce((s, m) => s + m.outputChars, 0),
      totalChars: rest.reduce((s, m) => s + m.totalChars, 0),
    });
  }
  return shown;
}

/** 顶部三个统计卡。 */
function statsTilesHtml(totals: StatsSnapshot["totals"]): string {
  return `<div class="card tile"><div class="v">${totals.requests}</div><div class="k">近 24h 上游请求</div></div>
  <div class="card tile"><div class="v">${compactNum(totals.inputChars + totals.outputChars)}</div><div class="k">近 24h 字符总量</div></div>
  <div class="card tile"><div class="v">${totals.toolCalls}</div><div class="k">近 24h 工具调用</div></div>`;
}

/** header 副标题 (时间起点 + 链接)。 */
function statsSubHtml(snapshot: StatsSnapshot): string {
  const first = snapshot.trend[0]?.at ? hhmm(snapshot.trend[0].at) : "";
  const last = snapshot.trend[snapshot.trend.length - 1]?.at ? hhmm(snapshot.trend[snapshot.trend.length - 1].at) : "";
  const windowLabel = first && last ? `${first} - ${last}` : "近 24 小时";
  return `统计窗口 ${escHtml(windowLabel)} · 数据源 ${snapshot.persisted ? "Deno KV" : "当前实例"} · <a href="/">服务信息</a> · <a href="/admin">管理界面</a>`;
}

/** 模型分布表 tbody 行。失败列: 有失败时红色高亮, 无失败灰色。 */
function statsModelRowsHtml(shown: ModelStatRow[]): string {
  if (shown.length === 0) {
    return `<tr><td colspan="5" class="empty-row">暂无数据</td></tr>`;
  }
  return shown.map((m, i) => `<tr>
      <td><i class="dot" style="background:var(--s${i + 1})"></i>${escHtml(m.model)}</td>
      <td class="num">${m.requests}</td>
      <td class="num">${m.failures > 0
        ? `<span class="fail-num">${m.failures}</span>`
        : `<span class="muted">0</span>`}</td>
      <td class="num">${compactNum(m.totalChars)}</td>
      <td class="num muted">${compactNum(m.inputChars)} / ${compactNum(m.outputChars)}</td>
    </tr>`).join("");
}

/** 最近请求表 tbody 行。 */
function statsRecentRowsHtml(recent: StatsSnapshot["recent"]): string {
  if (recent.length === 0) {
    return `<tr><td colspan="5" class="empty-row">暂无数据</td></tr>`;
  }
  return recent.map((r) => `<tr>
      <td class="num muted">${hhmm(r.time)}</td>
      <td>${escHtml(r.model)}</td>
      <td>${r.stream ? '<span class="tag ghost">stream</span>' : ""}</td>
      <td>${r.tools.length ? escHtml(r.tools.join(", ")) : '<span class="muted">—</span>'}</td>
      <td class="num muted">${r.ms}ms</td>
    </tr>`).join("");
}

/** 工具调用频次列表。 */
function statsToolRowsHtml(tools: StatsSnapshot["tools"]): string {
  if (tools.length === 0) {
    return `<p class="muted small">暂无工具调用</p>`;
  }
  const max = tools[0]?.count || 1;
  return `<ul class="tools">${tools.map((t) =>
    `<li><span class="tname">${escHtml(t.name)}</span>
      <span class="tbar"><i style="width:${(t.count / max) * 100}%"></i></span>
      <span class="tnum">${t.count}</span></li>`).join("")}</ul>`;
}

/** 页脚说明 (含持久化状态)。 */
function statsFooterHtml(snapshot: StatsSnapshot): string {
  return `${escHtml(snapshot.note)}<br>
  ${snapshot.persisted ? "聚合窗口数据已持久化（Deno KV），跨实例读取一致。" : "⚠️ 聚合窗口数据未持久化：仅统计当前实例，且实例回收后清零。"}
  近 24h 流式请求 ${snapshot.totals.streaming} 次。字符数以请求文本长度估算（上游流式不回传 token 用量）。`;
}

/** 环形图整块 (含 svg 外壳)。 */
function statsDonutBlock(shown: ModelStatRow[], total: number): string {
  return `<svg viewBox="0 0 180 180" width="150" height="150" role="img" aria-label="按模型的请求数构成">${statsDonut(shown, total)}</svg>`;
}

/** 供 /stats.json 附带的预渲染片段 (前端 5s 刷新时直接替换 innerHTML)。 */
function statsHtmlFragments(snapshot: StatsSnapshot) {
  const shown = statsShownModels(snapshot);
  return {
    tiles: statsTilesHtml(snapshot.totals),
    sub: statsSubHtml(snapshot),
    donut: statsDonutBlock(shown, snapshot.totals.requests),
    modelRows: statsModelRowsHtml(shown),
    trend: statsTrendChart(snapshot.trend),
    toolRows: statsToolRowsHtml(snapshot.tools),
    recentRows: statsRecentRowsHtml(snapshot.recent),
    footer: statsFooterHtml(snapshot),
  };
}

// 渲染 /stats 页面 (首屏完整 HTML; 此后由前端每 5s 拉 /stats.json 局部刷新, 不整页刷新)
function renderStatsPage(snapshot: StatsSnapshot): string {
  const shown = statsShownModels(snapshot);
  const { totals } = snapshot;

  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="auto">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sider2API 用量统计</title>
<style>
:root {
  color-scheme: light dark;
  --plane: #f9f9f7;
  --surface: #fcfcfb;
  --ink: #0b0b0b;
  --ink-2: #52514e;
  --muted: #898781;
  --grid: #e1e0d9;
  --border: rgba(11,11,11,0.10);
  --s1: #2a78d6;
  --s2: #eb6834;
  --s3: #1baf7a;
  --s4: #eda100;
  --s5: #e87ba4;
  --s6: #008300;
  --s7: #4a3aa7;
  --s8: #e34948;
  --warn: #fab219;
}
@media (prefers-color-scheme: dark) {
  :root {
    --plane: #0d0d0d;
    --surface: #1a1a19;
    --ink: #ffffff;
    --ink-2: #c3c2b7;
    --muted: #898781;
    --grid: #2c2c2a;
    --border: rgba(255,255,255,0.10);
    --s1: #3987e5;
    --s2: #d95926;
    --s3: #199e70;
    --s4: #c98500;
    --s5: #d55181;
    --s6: #008300;
    --s7: #9085e9;
    --s8: #e66767;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 24px;
  background: var(--plane); color: var(--ink);
  font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
}
header { display: flex; align-items: baseline; gap: 12px; margin-bottom: 20px; flex-wrap: wrap; }
h1 { font-size: 18px; margin: 0; font-weight: 600; }
.sub { color: var(--muted); font-size: 12px; }
.grid-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 16px; }
.row { display: grid; grid-template-columns: 1fr 1.35fr; gap: 16px; margin-bottom: 16px; }
@media (max-width: 900px) { .row, .grid-3 { grid-template-columns: 1fr; } }
.card {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 10px; padding: 16px;
}
.card h2 { font-size: 13px; margin: 0 0 14px; font-weight: 600; color: var(--ink-2); }
.tile .v { font-size: 26px; font-weight: 650; letter-spacing: -0.02em; }
.tile .k { color: var(--muted); font-size: 12px; margin-top: 2px; }
.donut-wrap { display: flex; align-items: center; gap: 18px; flex-wrap: wrap; }
.donut-num { font-size: 24px; font-weight: 650; fill: var(--ink); }
.donut-cap { font-size: 11px; fill: var(--muted); }
.donut-empty { font-size: 12px; fill: var(--muted); }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th {
  text-align: left; font-weight: 500; color: var(--muted); font-size: 12px;
  padding: 6px 8px; border-bottom: 1px solid var(--grid);
}
td { padding: 7px 8px; border-bottom: 1px solid var(--grid); }
tr:last-child td { border-bottom: 0; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.muted { color: var(--muted); }
.fail-num { color: var(--warn); font-weight: 650; }
.small { font-size: 12px; }
.empty-row { text-align: center; color: var(--muted); padding: 20px 0; }
.dot { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 7px; vertical-align: baseline; }
.trend { width: 100%; height: auto; }
.grid { stroke: var(--grid); stroke-width: 1; }
.tick { font-size: 10px; fill: var(--muted); }
.legend { display: flex; gap: 16px; font-size: 12px; color: var(--ink-2); margin-bottom: 6px; }
.legend i { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 6px; }
.tag {
  display: inline-block; padding: 1px 7px; border-radius: 4px;
  font-size: 11px; margin-right: 4px; border: 1px solid var(--border);
}
.tag.ghost { color: var(--muted); }
.tools { list-style: none; margin: 0; padding: 0; }
.tools li { display: grid; grid-template-columns: 1fr 120px 34px; align-items: center; gap: 10px; padding: 4px 0; }
.tname { font-size: 13px; }
.tbar { height: 7px; background: var(--grid); border-radius: 4px; overflow: hidden; }
.tbar i { display: block; height: 100%; background: var(--s3); border-radius: 4px; }
.tnum { text-align: right; font-variant-numeric: tabular-nums; color: var(--ink-2); font-size: 12px; }
footer { color: var(--muted); font-size: 12px; margin-top: 18px; line-height: 1.7; }
a { color: var(--s1); }
</style>
</head>
<body>
<header>
  <h1>Sider2API 用量统计</h1>
  <span class="sub" id="sub-since">${statsSubHtml(snapshot)}</span>
</header>

<div class="grid-3" id="tiles">${statsTilesHtml(totals)}</div>

<div class="row">
  <div class="card">
    <h2>模型分布</h2>
    <div class="donut-wrap">
      <div id="donut">${statsDonutBlock(shown, totals.requests)}</div>
      <table>
        <thead><tr><th>模型</th><th class="num">请求</th><th class="num">失败</th><th class="num">Token</th><th class="num">输入/输出</th></tr></thead>
        <tbody id="modelRows">${statsModelRowsHtml(shown)}</tbody>
      </table>
    </div>
  </div>
  <div class="card">
    <h2>Token 使用趋势（近 24 小时）</h2>
    <div class="legend">
      <span><i style="background:var(--s1)"></i>输入 Token</span>
      <span><i style="background:var(--s2)"></i>输出 Token</span>
      <span><i style="background:var(--s3)"></i>调用失败</span>
    </div>
    <div id="trend">${statsTrendChart(snapshot.trend)}</div>
  </div>
</div>

<div class="row">
  <div class="card">
    <h2>工具调用频次</h2>
    <div id="toolRows">${statsToolRowsHtml(snapshot.tools)}</div>
  </div>
  <div class="card">
    <h2>最近请求</h2>
    <table>
      <thead><tr><th>时间</th><th>模型</th><th>标记</th><th>工具</th><th class="num">耗时</th></tr></thead>
      <tbody id="recentRows">${statsRecentRowsHtml(snapshot.recent)}</tbody>
    </table>
  </div>
</div>

<footer id="footer">${statsFooterHtml(snapshot)}</footer>

<script>
// 每 5 秒拉 /stats.json, 用服务端预渲染片段局部替换 DOM (不整页刷新, 不闪烁/不抖动)。
// /stats.json 响应里附带 html 片段字段, 由服务端同一批渲染函数生成, 保证与首屏一致。
const REFRESH_MS = 5000;
const NODES = {
  tiles:      'tiles',
  sub:        'sub-since',
  donut:      'donut',
  modelRows:  'modelRows',
  trend:      'trend',
  toolRows:   'toolRows',
  recentRows: 'recentRows',
  footer:     'footer',
};

async function refreshStats() {
  try {
    const res = await fetch('/stats.json', { headers: { 'Accept': 'application/json' } });
    if (!res.ok) return;
    const data = await res.json();
    const frag = data.html;   // 服务端预渲染片段
    if (!frag) return;
    for (const [key, id] of Object.entries(NODES)) {
      const el = document.getElementById(id);
      if (el && frag[key] !== undefined) el.innerHTML = frag[key];
    }
  } catch (e) {
    // 网络抖动静默重试, 不打断定时器
  }
}
setInterval(refreshStats, REFRESH_MS);
</script>
</body>
</html>`;
}

// ==================== 路由处理 ====================

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  // 处理 CORS 预检
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, GET, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Session-ID, x-api-key, x-goog-api-key, anthropic-version"
      }
    });
  }

  // 主页
  if (req.method === "GET" && path === "/") {
    return new Response("🚀 Sider2API 集成服务已启动！\n\n✨ 功能特性:\n- 文本对话(流式/非流式)\n- 图像生成(自动检测)\n- 多轮对话支持\n- Think 模式\n- 30+ 模型支持", {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Access-Control-Allow-Origin": "*"
      }
    });
  }

  // 用量统计页面 (公开, 参考 sider2claude /stats 设计; 聚合取 KV 持久层, 明细取进程内)
  if (req.method === "GET" && path === "/stats") {
    return new Response(renderStatsPage(await getStatsSnapshotMerged()), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Access-Control-Allow-Origin": "*"
      }
    });
  }

  // 用量统计原始数据 (JSON, 与 /stats 页面同级公开; 附预渲染 HTML 片段,
  // 供页面每 5s 前端局部刷新。数据为聚合统计 + 最近请求元数据, 不含消息内容。)
  if (req.method === "GET" && path === "/stats.json") {
    const snapshot = await getStatsSnapshotMerged();
    const payload = {
      ...snapshot,
      html: statsHtmlFragments(snapshot),
    };
    return new Response(JSON.stringify(payload), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      }
    });
  }

  // 模型列表
  if (req.method === "GET" && path === "/v1/models") {
    return new Response(JSON.stringify({
      object: "list",
      data: MODELS
    }), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      }
    });
  }

  // 聊天对话(支持图像生成)
  if (req.method === "POST" && path === "/v1/chat/completions") {
    return authMiddleware(handleChatCompletion)(req);
  }

  // 专用图像生成端点
  if (req.method === "POST" && path === "/v1/images/generations") {
    return authMiddleware(handleImageGeneration)(req);
  }

  // ==================== Gemini 格式端点 ====================
  // 匹配 /v1beta/models/{model}:generateContent 或 :streamGenerateContent
  const geminiMatch = path.match(/^\/v1beta\/models\/(.+):(generateContent|streamGenerateContent)$/);
  if (req.method === "POST" && geminiMatch) {
    const geminiModel = geminiMatch[1];
    const geminiAction = geminiMatch[2];
    const isStream = geminiAction === "streamGenerateContent";
    return authMiddleware(async (req: Request) =>
      handleGeminiGenerate(req, geminiModel, isStream)
    )(req);
  }

  // ==================== Anthropic 格式端点 ====================
  // POST /v1/messages (Anthropic Messages API, 非流式 + 流式 stream:true)
  if (req.method === "POST" && path === "/v1/messages") {
    return authMiddleware(async (req: Request) =>
      handleAnthropicMessage(req)
    )(req);
  }

  // ==================== OpenAI Responses API 格式端点 ====================
  // POST /v1/responses (OpenAI Responses API, 非流式 + 流式 stream:true)
  if (req.method === "POST" && path === "/v1/responses") {
    return authMiddleware(async (req: Request) =>
      handleOpenAIResponse(req)
    )(req);
  }

  // ==================== 管理界面路由 ====================

  // 管理界面 HTML
  if (req.method === "GET" && path === "/admin") {
    try {
      // 检查是否在 Deno Deploy 环境或配置了 AUTH_TOKEN
      const isDeployEnv = Deno.env.get("DENO_DEPLOYMENT_ID") !== undefined;
      const hasAuthToken = AUTH_TOKEN !== undefined && AUTH_TOKEN !== null && AUTH_TOKEN !== "";

      // Deploy 环境或配置了认证时,使用内嵌的简化版管理界面
      if (isDeployEnv || hasAuthToken) {
        return new Response(getEmbeddedAdminHTML(), {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Access-Control-Allow-Origin": "*"
          }
        });
      }

      // 本地环境且未配置认证时,从文件读取完整版管理界面
      const html = await Deno.readTextFile("./admin.html");
      return new Response(html, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Access-Control-Allow-Origin": "*"
        }
      });
    } catch (error) {
      // 如果文件读取失败,返回内嵌版本
      return new Response(getEmbeddedAdminHTML(), {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }
  }

  // 获取所有模型(内置+自定义)
  if (req.method === "GET" && path === "/api/admin/models") {
    return authMiddleware(async (req: Request) => {
      const models = getAllModels();
      return new Response(JSON.stringify(models), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });
    })(req);
  }

  // 获取服务统计信息
  if (req.method === "GET" && path === "/api/admin/stats") {
    return authMiddleware(async (req: Request) => {
      const stats = {
        activeSessions: conversationSessions.size,
        totalModels: Object.keys(MODEL_MAPPING).length,
        customModels: customModels.size,
        builtInModels: Object.keys(MODEL_MAPPING).length - customModels.size
      };
      return new Response(JSON.stringify(stats), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });
    })(req);
  }

  // 添加自定义模型
  if (req.method === "POST" && path === "/api/admin/models") {
    return authMiddleware(async (req: Request) => {
      try {
        const model: CustomModel = await req.json();

        // 验证必需字段
        if (!model.id || !model.model) {
          return new Response("缺少必需字段: id 和 model", {
            status: 400,
            headers: {
              "Content-Type": "text/plain",
              "Access-Control-Allow-Origin": "*"
            }
          });
        }

        // 检查是否已存在
        if (MODEL_MAPPING[model.id]) {
          return new Response(`模型 ${model.id} 已存在`, {
            status: 400,
            headers: {
              "Content-Type": "text/plain",
              "Access-Control-Allow-Origin": "*"
            }
          });
        }

        addCustomModel(model);
        return new Response(JSON.stringify({ success: true, model }), {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*"
          }
        });
      } catch (error: any) {
        return new Response(`添加失败: ${error.message}`, {
          status: 500,
          headers: {
            "Content-Type": "text/plain",
            "Access-Control-Allow-Origin": "*"
          }
        });
      }
    })(req);
  }

  // 更新自定义模型
  if (req.method === "PUT" && path === "/api/admin/models") {
    return authMiddleware(async (req: Request) => {
      try {
        const model: CustomModel = await req.json();

        if (!model.id || !model.model) {
          return new Response("缺少必需字段: id 和 model", {
            status: 400,
            headers: {
              "Content-Type": "text/plain",
              "Access-Control-Allow-Origin": "*"
            }
          });
        }

        updateCustomModel(model);
        return new Response(JSON.stringify({ success: true, model }), {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*"
          }
        });
      } catch (error: any) {
        return new Response(`更新失败: ${error.message}`, {
          status: 400,
          headers: {
            "Content-Type": "text/plain",
            "Access-Control-Allow-Origin": "*"
          }
        });
      }
    })(req);
  }

  // 删除自定义模型
  if (req.method === "DELETE" && path.startsWith("/api/admin/models/")) {
    return authMiddleware(async (req: Request) => {
      try {
        const modelId = path.split("/").pop();
        if (!modelId) {
          return new Response("缺少模型ID", {
            status: 400,
            headers: {
              "Content-Type": "text/plain",
              "Access-Control-Allow-Origin": "*"
            }
          });
        }

        deleteCustomModel(decodeURIComponent(modelId));
        return new Response(JSON.stringify({ success: true }), {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*"
          }
        });
      } catch (error: any) {
        return new Response(`删除失败: ${error.message}`, {
          status: 400,
          headers: {
            "Content-Type": "text/plain",
            "Access-Control-Allow-Origin": "*"
          }
        });
      }
    })(req);
  }

  // 404
  return new Response("Not Found", {
    status: 404,
    headers: { "Access-Control-Allow-Origin": "*" }
  });
}

// ==================== 启动服务 ====================
// 迁移到console.deno.com以后用原生deno.serve -- Weihong 2026/06/28
const PORT = parseInt(Deno.env.get("PORT") || "8000");

// 1. 先定义启动逻辑
console.log("🚀 启动 Sider2API 集成代理服务器...");

// 2. 立即启动服务 (不要被 await loadCustomModels 阻塞)
Deno.serve({
  port: PORT,
  hostname: "0.0.0.0",
  onListen({ port, hostname }) {
    console.log(`📍 监听地址: http://${hostname}:${port}`);
    console.log(`💬 聊天接口: POST /v1/chat/completions`);
    // 服务启动成功后，再在后台加载自定义模型
    loadCustomModels().catch(err => console.error("⚠️ 自定义模型加载失败:", err));
  }
}, handleRequest);

console.log("📍 监听端口: 8000");
console.log("🔗 主页: http://localhost:8000");
console.log("🎛️ 管理界面: http://localhost:8000/admin");
console.log("💬 聊天接口: POST /v1/chat/completions");
console.log("🎨 图像接口: POST /v1/images/generations");
console.log("📋 模型列表: GET /v1/models");
console.log("\n✨ 功能特性:");
console.log("   - 文本对话(流式和非流式)");
console.log("   - 自动检测图像生成请求");
console.log("   - 多轮对话支持(会话管理)");
console.log("   - Think 模式支持");
console.log("   - OpenAI 完全兼容格式");
console.log("   - 环境变量配置");
console.log("   - Web 管理界面");
console.log("   - 自定义模型映射");
console.log(`   - 支持 ${Object.keys(MODEL_MAPPING).length} 个模型`);
console.log("\n🔐 安全配置:");
console.log(`   - SIDER_AUTH_TOKEN: ${SIDER_AUTH_TOKEN ? "✅ 已配置" : "❌ 未配置"}`);
console.log(`   - AUTH_TOKEN: ${AUTH_TOKEN ? "✅ 已启用认证" : "⚠️ 未启用认证(开发模式)"}`);
