// 迁移到console.deno.com以后用原生deno.serve -- Weihong 2026/06/28
// import { serve } from "https://deno.land/std@0.200.0/http/server.ts";

// ==================== 配置常量 ====================

const SIDER_API_ENDPOINT = "https://sider.ai/api/chat/v1/completions";

// 从环境变量获取 Token,如果没有则使用默认值(仅用于测试)
const SIDER_AUTH_TOKEN = Deno.env.get("SIDER_AUTH_TOKEN")
// 服务端 API 认证 Token(可选)
const AUTH_TOKEN = Deno.env.get("AUTH_TOKEN");

// ==================== 性能/兼容性开关 ====================
// 上游请求超时(毫秒) - 避免长时间挂起放大尾延迟
const UPSTREAM_TIMEOUT_MS = parseInt(Deno.env.get("UPSTREAM_TIMEOUT_MS") || "60000", 10);
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
  "gpt-4.1": "gpt-4.1",
  "gpt-5": "gpt-5",
  "gpt-5-think": "gpt-5-think",
  "gpt-5-mini": "gpt-5-mini",
  "gpt-5.1": "gpt-5.1",
  "gpt-5.1-think": "gpt-5.1-think",
  "gpt-5.4": "gpt-5.4",
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
  
  // Claude 系列
  "claude-opus-4.5": "claude-opus-4.5",
  "claude-opus-4.5-think": "claude-opus-4.5-think",
  "claude-opus-4.6": "claude-opus-4.6",
  "claude-opus-4.6-think": "claude-opus-4.6-think",
  "claude-opus-4.8": "claude-opus-4.8",
  "claude-opus-4.8-think": "claude-opus-4.8-think", 
  "claude-opus-5": "claude-opus-5",
  "claude-opus-5-think": "claude-opus-5-think",
  "claude-fable-5": "claude-fable-5",  
  "claude-fable-5-think": "claude-fable-5-think", 
  "claude-4.5-sonnet": "claude-4.5-sonnet",
  "claude-4.5-sonnet-think": "claude-4.5-sonnet-think",
  "claude-sonnet-4.6": "claude-sonnet-4.6",
  "claude-sonnet-4.6-think": "claude-sonnet-4.6-think",  
  "claude-sonnet-5": "claude-sonnet-5",  
  "claude-sonnet-5-think": "claude-sonnet-5-think", 
  "claude-haiku-4.5": "claude-haiku-4.5",
  "claude-haiku-4.5-think": "claude-haiku-4.5-think",

  // Gemini 系列
  "gemini-2.5-pro": "gemini-2.5-pro",
  "gemini-2.5-flash": "gemini-2.5-flash",
  "gemini-2.5-pro-think": "gemini-2.5-pro-think",
  "gemini-2.5-flash-think": "gemini-2.5-flash-think",
  "gemini-3.0-flash": "gemini-3.0-flash",
  "gemini-3.0-flash-think": "gemini-3.0-flash-think",
  "gemini-3.5-flash": "gemini-3.5-flash",
  "gemini-3.5-flash-think": "gemini-3.5-flash-think",
  "gemini-3.6-flash": "gemini-3.6-flash",
  "gemini-3.6-flash-think": "gemini-3.6-flash-think",
  "gemini-3.7-flash": "gemini-3.7-flash",
  "gemini-3.7-flash-think": "gemini-3.7-flash-think",
  
  // DeepSeek 系列
  "deepseek-v4-flash": "deepseek-v4-flash",
  "deepseek-v4-flash-think": "deepseek-v4-flash-think",
  "deepseek-v4-pro": "deepseek-v4-pro",
  "deepseek-v4-pro-think": "deepseek-v4-pro-think",

  // 其他模型
  "grok-4": "grok-4",
  "grok-4.6": "grok-4.6",
  "glm-5": "glm-5",
  "glm-5-think": "glm-5-think",
  "qwen3.8-max": "qwen3.8-max",  
  "kimi-k3": "kimi-k3",
  "llama-3.1-405b": "llama-3.1-405b",

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

// 轻量级字符串哈希（djb2 变体），用于会话指纹
function simpleHash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
    hash = hash >>> 0; // 保持 32-bit 无符号
  }
  return hash.toString(36);
}

// 从 messages[] 推导稳定的会话指纹 ID。
// 同一对话的所有轮次共享相同的「系统消息 + 第一条用户消息」，
// 因此可作为跨轮次的稳定标识，无需客户端主动发送 X-Session-ID。
function deriveSessionId(messages: any[], flattenFn: (c: any) => string): string {
  const systemText = flattenFn(messages.find(m => m.role === "system")?.content ?? "");
  const firstUserText = flattenFn(messages.find(m => m.role === "user")?.content ?? "");
  return `conv-${simpleHash(systemText + "|" + firstUserText)}`;
}

// 估算文本词数：中日韩字符各计 1 词，其余按空白分词。
// 用于防止触发 Sider code:603 "Too many words" 限制。
function estimateWordCount(text: string): number {
  const cjkChars = (text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  const otherWords = text.replace(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, " ")
    .trim().split(/\s+/).filter(Boolean).length;
  return cjkChars + otherWords;
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

// 标准化 not_supported 错误响应 (能力门控统一出口)
function notSupportedResponse(message: string, code = "vision_not_supported"): Response {
  return new Response(JSON.stringify({
    error: {
      message,
      type: "not_supported",
      code,
    }
  }), {
    status: 422,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    }
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
  inputChars: number;
  outputChars: number;
  totalChars: number;
}

interface TrendBucketRow {
  at: string;
  requests: number;
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

const statsStartedAt = Date.now();
let statsTotals = {
  requests: 0, streaming: 0, toolCalls: 0, inputChars: 0, outputChars: 0,
};
const statsToolCounts = new Map<string, number>();
const statsModelMap = new Map<string, ModelStatRow>();
const statsRecent: Array<{ at: number; record: UsageRecord }> = [];

// 每次请求完成时调用 (fire-and-forget 语义: 不抛错、不阻塞响应路径)
function recordUsage(record: UsageRecord): void {
  statsTotals.requests += 1;
  if (record.stream) statsTotals.streaming += 1;
  statsTotals.toolCalls += record.toolUses.length;
  statsTotals.inputChars += record.inputChars;
  statsTotals.outputChars += record.outputChars;
  for (const name of record.toolUses) {
    statsToolCounts.set(name, (statsToolCounts.get(name) ?? 0) + 1);
  }

  let row = statsModelMap.get(record.model);
  if (!row) {
    row = { model: record.model, requests: 0, inputChars: 0, outputChars: 0, totalChars: 0 };
    statsModelMap.set(record.model, row);
  }
  row.requests += 1;
  row.inputChars += record.inputChars;
  row.outputChars += record.outputChars;
  row.totalChars += record.inputChars + record.outputChars;

  statsRecent.unshift({ at: Date.now(), record });
  if (statsRecent.length > STATS_RECENT_LIMIT) {
    statsRecent.length = STATS_RECENT_LIMIT;
  }

  persistUsage(record); // fire-and-forget; KV 未启用时内部直接返回
}

// 近 24 小时按小时分桶; 空桶保留保证时间轴连续。
// 数据源是 recent(200 条上限), 高流量下早期桶会偏低——趋势形状可读, 绝对值以 totals 为准。
function buildStatsTrend(now: number): TrendBucketRow[] {
  const currentBucket = Math.floor(now / STATS_BUCKET_MS) * STATS_BUCKET_MS;
  const buckets = new Map<number, TrendBucketRow>();
  for (let i = STATS_BUCKET_COUNT - 1; i >= 0; i -= 1) {
    const at = currentBucket - i * STATS_BUCKET_MS;
    buckets.set(at, { at: new Date(at).toISOString(), requests: 0, inputChars: 0, outputChars: 0 });
  }
  for (const { at, record } of statsRecent) {
    const key = Math.floor(at / STATS_BUCKET_MS) * STATS_BUCKET_MS;
    const bucket = buckets.get(key);
    if (!bucket) continue; // 落在 24 小时窗口外
    bucket.requests += 1;
    bucket.inputChars += record.inputChars;
    bucket.outputChars += record.outputChars;
  }
  return [...buckets.values()];
}

// 生成统计快照 (供 /stats 页面与 /stats.json 使用)
function getStatsSnapshot(now = Date.now()): StatsSnapshot {
  const tools = [...statsToolCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, count]) => ({ name, count }));

  const models = [...statsModelMap.values()].sort((a, b) => b.requests - a.requests);

  return {
    since: new Date(statsStartedAt).toISOString(),
    totals: { ...statsTotals },
    models,
    tools,
    trend: buildStatsTrend(now),
    recent: statsRecent.slice(0, STATS_RECENT_DISPLAY).map(({ at, record }) => ({
      time: new Date(at).toISOString(),
      model: record.model,
      stream: record.stream,
      tools: record.toolUses,
      ms: record.ms,
      chars: record.inputChars + record.outputChars,
    })),
    note: "进程内统计, 实例重启后清零; Deno Deploy 各隔离实例独立, 仅代表当前实例。Token 以字符数估算 (上游流式不回传真实 usage)。",
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

    sum([...P, "requests"], 1);
    if (record.stream) sum([...P, "streaming"], 1);
    sum([...P, "toolCalls"], record.toolUses.length);
    sum([...P, "inputChars"], record.inputChars);
    sum([...P, "outputChars"], record.outputChars);
    for (const name of record.toolUses) sum([...P, "tool", name], 1);

    const m = [...P, "model", record.model];
    sum([...m, "requests"], 1);
    sum([...m, "inputChars"], record.inputChars);
    sum([...m, "outputChars"], record.outputChars);

    const t = [...P, "trend", bucket];
    sum([...t, "requests"], 1);
    sum([...t, "inputChars"], record.inputChars);
    sum([...t, "outputChars"], record.outputChars);

    await kv.atomic()
      .mutate(...ops)
      .commit()
      .catch(() => { /* 静默: KV 抖动不影响进程内统计 */ });
  })();
}

/** KV 持久化的聚合视图; KV 未启用时返回 null (调用方回退进程内)。 */
interface PersistentStats {
  since: number;
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
    inputChars: number;
    outputChars: number;
  }>;
  tools: Array<{ name: string; count: number }>;
  trend: Array<{
    bucket: number;
    requests: number;
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
  const sinceEntry = await kv.get([...P, "since"]);
  const totals = { requests: 0, streaming: 0, toolCalls: 0, inputChars: 0, outputChars: 0 };
  const models: PersistentStats["models"] = [];
  const tools: PersistentStats["tools"] = [];
  const trend: PersistentStats["trend"] = [];

  // 只扫描本命名空间前缀, 不会读到 sider2claude 的 ["stats", ...] 键
  for await (const entry of kv.list({ prefix: P })) {
    const key = entry.key;
    const value = statsKvNum(entry.value);

    // 键形: [root, "stats", "model", model, field] / [root, "stats", "trend", bucket, field]
    // 相对前缀的偏移: key[0]=root, key[1]="stats", 故模型在 key[2], 字段在 key[3]
    if (key[1] === "stats" && key[2] === "model" && key.length === 5) {
      const model = key[3] as string;
      const field = key[4] as string;
      let row = models.find((m) => m.model === model);
      if (!row) {
        row = { model, requests: 0, inputChars: 0, outputChars: 0 };
        models.push(row);
      }
      if (field === "requests" || field === "inputChars" || field === "outputChars") {
        (row as unknown as Record<string, number>)[field] += value;
      }
      continue;
    }

    if (key[1] === "stats" && key[2] === "trend" && key.length === 5) {
      const bucket = Number(key[3]);
      const field = key[4] as string;
      let row = trend.find((t) => t.bucket === bucket);
      if (!row) {
        row = { bucket, requests: 0, inputChars: 0, outputChars: 0 };
        trend.push(row);
      }
      if (field === "requests" || field === "inputChars" || field === "outputChars") {
        (row as unknown as Record<string, number>)[field] += value;
      }
      continue;
    }

    if (key[1] === "stats" && key[2] === "tool" && key.length === 4) {
      tools.push({ name: key[3] as string, count: value });
      continue;
    }

    if (key[1] === "stats" && key.length === 3 && key[2] !== "since") {
      const field = key[2] as string;
      if (field in totals) {
        (totals as unknown as Record<string, number>)[field] += value;
      }
    }
  }

  models.sort((a, b) => b.requests - a.requests);
  tools.sort((a, b) => b.count - a.count);
  trend.sort((a, b) => a.bucket - b.bucket);

  return {
    since: statsKvNum(sinceEntry.value) || Date.now(),
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
      inputChars: row?.inputChars ?? 0,
      outputChars: row?.outputChars ?? 0,
    });
  }

  return {
    ...local,
    since: new Date(persistent.since).toISOString(),
    totals: { ...persistent.totals },
    models: persistent.models
      .map((m) => ({
        ...m,
        totalChars: m.inputChars + m.outputChars,
      }))
      .sort((a, b) => b.requests - a.requests),
    tools: persistent.tools.slice(0, 8),
    trend,
    note: "聚合数据持久化于 Deno KV, 跨实例、跨重启累计; 最近请求明细与近 24 小时窗口仅当前实例。Token 以字符数估算 (上游流式不回传真实 usage)。",
    persisted: true,
  };
}

// ==================== 图像生成互斥锁 ====================

// 图像生成忙碌标志(防止并发请求)
let isImageGenerating = false;
let currentGenerationStartTime = 0;
const IMAGE_GENERATION_TIMEOUT = 180000; // 3分钟超时

// ==================== 认证中间件 ====================

function authMiddleware(handler: (req: Request) => Promise<Response>): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    // 如果未配置 AUTH_TOKEN,允许所有请求
    if (!AUTH_TOKEN) {
      return handler(req);
    }

    // 获取请求头中的授权信息
    const authHeader = req.headers.get("Authorization");

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return new Response(JSON.stringify({
        error: {
          message: "Unauthorized: Missing or invalid Authorization header",
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

    const token = authHeader.split(" ")[1];

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

// ==================== 请求处理器 ====================

// 处理文本对话请求
async function handleChatCompletion(req: Request): Promise<Response> {
  try {
    const requestBody = await req.json();
    console.log("📥 收到聊天请求:", {
      model: requestBody.model,
      stream: requestBody.stream,
      messageCount: requestBody.messages?.length
    });

    const modelName = requestBody.model || "sider";
    const siderModel = MODEL_MAPPING[modelName] || "sider";
    const isStreaming = requestBody.stream ?? false;
    const messages = requestBody.messages || [];
    const lastMessage = messages[messages.length - 1];

    // 能力门控 (CLAUDE.md 铁律): 上游 sider 不支持视觉输入。
    // 经 test/probe_vision.py 决定性判别确认 (读不出图中文字, 仅幻觉)。
    // 收到图像块直接返回标准 not_supported, 绝不静默丢给上游让其幻觉。
    if (detectVisionInput(messages)) {
      console.warn("⛔ 收到视觉输入(图像), 但上游 sider 不支持视觉理解; 返回 not_supported。");
      return notSupportedResponse(
        "上游 sider 不支持视觉输入 (图像理解)。请仅发送文本内容。" +
        "如需图像生成, 请用绘图关键词描述 (如'画一只猫') 或调用 /v1/images/generations。"
      );
    }

    // 能力门控 (CLAUDE.md 铁律): 上游 sider 不支持自定义 function calling。
    // 经 test/probe_tools.py 探针确认: 顶层 tools=[{type:function}] 报 code:1000,
    // functions[] 被静默忽略。上游只支持内置工具 (search/data_analysis/create_image)。
    // 处理策略: 不 fake (绝不伪造 tool_calls), 优雅降级为纯文本, 并在响应中显式告知。
    const hasCustomTools = Array.isArray(requestBody.tools) &&
      requestBody.tools.some((t: any) => t && t.type === "function");
    const hasLegacyFunctions = Array.isArray(requestBody.functions) && requestBody.functions.length > 0;
    const customToolsRequested = hasCustomTools || hasLegacyFunctions;
    const toolChoiceNone = requestBody.tool_choice === "none";
    if (customToolsRequested && !toolChoiceNone) {
      console.warn("⚠️ 收到自定义 function tools, 但上游 sider 不支持自定义函数调用; " +
        "已降级为纯文本对话 (不伪造 tool_calls)。");
    }

    // OpenAI-compatible: `message.content` can be either a string or an array of content blocks.
    // Some clients (e.g., newer OpenClaw versions) send: [{"type":"text","text":"..."}, ...]
    // We keep this gateway backward-compatible by flattening array content into a single string.
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

    const userPrompt = flattenMessageContent(lastMessage?.content);

    // 将完整的 messages[] 历史拼接为上下文，解决多轮对话上下文丢失问题。
    // 标准 OpenAI 客户端每轮都会携带完整历史，代理需全量注入而非只取最后一条。
    // 优先级：system > 当前问题 > 历史（从最新往最旧填充），严格遵守 SIDER_MAX_CHARS 上限。
    function buildFullContext(msgs: any[]): string {
      if (!msgs || msgs.length === 0) return "";

      const SEP = "\n\n---\n\n";
      const nonSystemMsgs = msgs.filter(m => m.role !== "system");

      // 仅有一条消息且无 system 时直接返回
      if (nonSystemMsgs.length <= 1 && !msgs.find(m => m.role === "system")) {
        return flattenMessageContent(msgs[0]?.content || "");
      }

      // 固定部分：system（最高优先级）
      const systemMsg = msgs.find(m => m.role === "system");
      const systemPart = systemMsg
        ? `[System]\n${flattenMessageContent(systemMsg.content)}`
        : "";

      // 固定部分：当前问题（必须保留）
      const currentText = flattenMessageContent(nonSystemMsgs[nonSystemMsgs.length - 1]?.content);
      const currentPart = `[Current Question]\n${currentText}`;

      // 计算固定部分已用字符数
      const fixedChars =
        (systemPart ? systemPart.length + SEP.length : 0) +
        currentPart.length;

      // 剩余预算分配给历史
      const historyBudget = SIDER_MAX_CHARS - fixedChars - SEP.length - "[Conversation History]\n".length;

      // 历史消息从最新到最旧逐条填充，超出字符或词数预算则停止
      const historyMsgs = nonSystemMsgs.slice(0, -1);
      const selectedLines: string[] = [];
      let usedChars = 0;
      let usedWords = estimateWordCount((systemPart ? systemPart + "\n\n" : "") + currentPart);
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

      // 组装最终结果
      const parts: string[] = [];
      if (systemPart) parts.push(systemPart);
      if (selectedLines.length > 0) {
        const label = truncated
          ? "[Conversation History (partial, oldest trimmed)]\n"
          : "[Conversation History]\n";
        parts.push(label + selectedLines.join("\n\n"));
      }
      parts.push(currentPart);

      return parts.join(SEP);
    }

    // 当存在多轮历史时使用完整上下文，单轮时直接使用原始 prompt
    const fullContext = messages.length > 1 ? buildFullContext(messages) : userPrompt;

    // 优先使用客户端显式传入的 X-Session-ID，
    // 否则从 messages[] 指纹推导稳定 ID，确保同一对话多轮复用同一 Sider 服务端会话。
    const sessionId = req.headers.get("X-Session-ID") || deriveSessionId(messages, flattenMessageContent);
    let session = conversationSessions.get(sessionId);

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
      console.log(`🆕 创建新会话: ${sessionId}`);
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

    // 发送请求 (带超时控制，避免长时间挂起放大尾延迟)
    const upstreamController = new AbortController();
    const upstreamTimeout = setTimeout(() => upstreamController.abort(), UPSTREAM_TIMEOUT_MS);

    const siderResponse = await fetch(SIDER_API_ENDPOINT, {
      method: "POST",
      signal: upstreamController.signal,
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
    });

    clearTimeout(upstreamTimeout);

    if (!siderResponse.ok) {
      const errorText = await siderResponse.text();
      console.error("❌ Sider API 错误响应:", errorText);
      // 翻译上游错误码为 OpenAI 兼容格式
      let errorPayload;
      try {
        errorPayload = JSON.parse(errorText);
      } catch {
        errorPayload = null;
      }
      const upstreamCode = errorPayload?.code;
      const upstreamMsg = errorPayload?.msg || "";
      let statusCode = siderResponse.status;
      let message = `Sider API 错误: ${siderResponse.status} - ${errorText}`;
      let type = "upstream_error";
      if (upstreamCode === 603) {
        statusCode = 400;
        message = upstreamMsg || "请求内容超出词数上限, 请缩短 prompt 或缩减对话历史。";
        type = "context_length_exceeded";
      } else if (upstreamCode === 1001) {
        statusCode = 401;
        message = "上游 Token 无效或已过期。";
        type = "auth_error";
      } else if (upstreamCode === 1101) {
        statusCode = 429;
        message = upstreamMsg || "上游并发/限流, 请稍后重试。";
        type = "rate_limit_error";
      } else if (upstreamCode === 1135) {
        statusCode = 429;
        message = upstreamMsg || "上游模型使用额度已达上限, 请稍后重试。";
        type = "rate_limit_error";
      }
      return new Response(JSON.stringify({
        error: { message, type, upstream_code: upstreamCode }
      }), {
        status: statusCode,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }

    console.log("✅ Sider 响应状态:", siderResponse.status);

    // 非流式响应
    if (!isStreaming) {
      return await handleNonStreamingResponse(siderResponse, modelName, fullContext, isImageGen, sessionId,
        customToolsRequested && !toolChoiceNone);
    }

    // 流式响应
    return handleStreamingResponse(siderResponse, modelName, isImageGen, sessionId);

  } catch (error: any) {
    console.error("❌ 处理聊天请求错误:", error);
    return new Response(JSON.stringify({
      error: {
        message: `处理请求失败: ${error.message}`,
        type: "server_error"
      }
    }), {
      status: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      }
    });
  }
}

// 处理非流式响应
async function handleNonStreamingResponse(
  siderResponse: Response,
  modelName: string,
  userPrompt: string,
  isImageGen: boolean,
  sessionId: string,
  customToolsDegraded = false
): Promise<Response> {
  let fullText = "";
  let reasoningContentAcc = "";
  let imageUrl = "";
  let imageData: any = null;
  let conversationId = "";
  let messageId = "";
  let parentMessageId = "";

  const reader = siderResponse.body?.getReader();
  if (!reader) {
    throw new Error("无法获取响应流");
  }

  const lineReader = new SSELineReader();

  for await (const line of lineReader.readLines(reader)) {
    const trimmedLine = line.trim();
    if (!trimmedLine || trimmedLine === '[DONE]') continue;

    const dataLine = trimmedLine.startsWith('data:')
      ? trimmedLine.substring(5).trim()
      : trimmedLine;

    if (!dataLine) continue;

    try {
      const siderData = JSON.parse(dataLine);

      if (!siderData.data) continue;

      switch (siderData.data.type) {
        case "message_start":
          conversationId = siderData.data.message_start.cid || "";
          messageId = siderData.data.message_start.assistant_message_id || "";
          parentMessageId = siderData.data.message_start.parent_message_id || "";
          console.log("📝 会话信息:", { conversationId, messageId, parentMessageId });

          // 更新或创建会话
          conversationSessions.set(sessionId, {
            cid: conversationId,
            parent_message_id: messageId, // 下一轮使用当前 assistant 消息作为 parent
            created_at: conversationSessions.get(sessionId)?.created_at || Date.now(),
            last_used: Date.now()
          });
          break;

        case "text":
          fullText += siderData.data.text || "";
          break;

        case "file":
          if (siderData.data.file.type === "image") {
            imageUrl = siderData.data.file.url;
            imageData = siderData.data.file;
            console.log("🖼️ 收到图像:", imageUrl);
          }
          break;

        case "reasoning_content":
          // Think 模式: 收集上游思考流 (经探针确认 SUPPORTED)
          const rc2 = siderData.data.reasoning_content;
          if (typeof rc2 === "object" && rc2 !== null && "text" in rc2) {
            reasoningContentAcc += (rc2 as Record<string,unknown>).text as string || "";
          }
          break;

        case "tool_call":
          console.log("🔧 工具调用:", siderData.data.tool_call);
          break;
      }
    } catch (parseError) {
      console.warn("⚠️ 解析失败:", dataLine.substring(0, 100));
    }
  }

  // 构建 OpenAI 格式响应
  let content = fullText || "生成完成";

  // 图像生成优化: 在文本中添加Markdown格式的图片URL (双保险)
  if (isImageGen && imageUrl) {
    content = `${fullText || "我已为您生成了图像"}\n\n![图片](${imageUrl})`;
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
      finish_reason: "stop",
      index: 0
    }],
    usage: {
      prompt_tokens: userPrompt.length,
      completion_tokens: fullText.length,
      total_tokens: userPrompt.length + fullText.length
    }
  };

  // 携带推理内容 (think 模式非流式), 兼容 Anthropic/Ollama 风格
  if (reasoningContentAcc) {
    openAIResponse.choices[0].message.reasoning_content = reasoningContentAcc;
  }

  // 能力门控显式告知: 客户端请求了自定义 function tools, 但上游不支持, 已降级纯文本。
  // 不伪造 tool_calls (铁律: 不 fake), 用扩展字段透明告知调用方。
  if (customToolsDegraded) {
    openAIResponse.warning = {
      type: "tools_not_supported",
      message: "上游 sider 不支持自定义 function calling, 已降级为纯文本对话。" +
        "内置工具 (联网搜索/图像生成) 由模型自主触发, 无需显式传 tools。",
    };
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
    outputChars: fullText.length,
  });

  return new Response(JSON.stringify(openAIResponse), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "X-Session-ID": sessionId,
      "X-Conversation-ID": conversationId
    }
  });
}

// 处理流式响应
function handleStreamingResponse(
  siderResponse: Response,
  modelName: string,
  isImageGen: boolean,
  sessionId: string
): Response {
  let conversationId = "";

  const stream = new ReadableStream({
    async start(controller) {
      const reader = siderResponse.body?.getReader();
      if (!reader) {
        controller.error(new Error("无法获取响应流"));
        return;
      }

      const lineReader = new SSELineReader();
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

      // 流式请求完成时统一采集 (正常出口调用)
      const finishStreamStats = () => {
        recordUsage({
          model: modelName,
          stream: true,
          ms: Date.now() - streamT0,
          toolUses: [...streamToolNames],
          inputChars: 0, // 流式路径无 prompt 注入点, 输入以 0 计
          outputChars: streamOutputChars,
        });
      };

      try {
        for await (const line of lineReader.readLines(reader)) {
          const trimmedLine = line.trim();
          if (!trimmedLine) continue;

          const dataLine = trimmedLine.startsWith('data:')
            ? trimmedLine.substring(5).trim()
            : trimmedLine;

          if (dataLine === '[DONE]') {
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

            controller.enqueue(encoder.encode("data: [DONE]\n\n"));

            // 在关闭前再次等待确保所有数据都已flush
            await new Promise(resolve => setTimeout(resolve, 50));
            finishStreamStats();
            hb.close();
            return;
          }

          if (!dataLine) continue;

          try {
            const siderData = JSON.parse(dataLine);
            if (!siderData.data) continue;

            let openAIChunk: any = null;

            switch (siderData.data.type) {
              case "message_start":
                conversationId = siderData.data.message_start.cid || "";
                const messageId = siderData.data.message_start.assistant_message_id || "";
                console.log("📝 流式会话开始:", conversationId);

                // 更新会话
                conversationSessions.set(sessionId, {
                  cid: conversationId,
                  parent_message_id: messageId,
                  created_at: conversationSessions.get(sessionId)?.created_at || Date.now(),
                  last_used: Date.now()
                });
                break;

              case "text":
                if (!hasStarted) {
                  hasStarted = true;
                }
                if (firstChunkAt === null) {
                  firstChunkAt = Date.now();
                  console.log("⏱️ TTFT(ms):", firstChunkAt - streamT0);
                }
                streamOutputChars += (siderData.data.text || "").length;
                openAIChunk = {
                  id: `chatcmpl-${Date.now()}`,
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model: modelName,
                  choices: [{
                    delta: {
                      content: siderData.data.text
                    },
                    finish_reason: null,
                    index: 0
                  }]
                };
                break;

              case "file":
                if (siderData.data.file.type === "image") {
                  const imageUrl = siderData.data.file.url;

                  // 收集图像URL和数据
                  imageUrls.push(imageUrl);
                  imageDataList.push(siderData.data.file);

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
                console.log("🔧 工具调用状态:", siderData.data.tool_call.status);
                // 用量统计: 收集触发的内置工具名 (tool_call.name, 经探针确认存在)
                const tcName = siderData.data.tool_call?.name;
                if (tcName) streamToolNames.add(tcName);
                break;

              case "reasoning_content":
                // Think 模式: 上游独立流式返回思考过程 (经探针确认 SUPPORTED)
                if (firstChunkAt === null) {
                  firstChunkAt = Date.now();
                  console.log("⏱️ TTFT(ms) (reasoning):", firstChunkAt - streamT0);
                }
                const rc = siderData.data.reasoning_content;
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
                console.log("💳 额度信息:", siderData.data.credit_info);
                break;
            }

            // 上游流内错误码检测 (SSE 顶层 code 非 0/null, 如 1135 限流)
            if (siderData.code && siderData.code !== 0) {
              const errCode = siderData.code;
              const errMsg = siderData.msg || "";
              console.error(`❌ 上游流内错误: code=${errCode} msg=${errMsg}`);
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
                error: { code: errCode, message: errMsg }
              };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(errChunk)}\n\n`));
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              finishStreamStats();
              hb.close();
              return;
            }

            if (openAIChunk) {
              const chunk = `data: ${JSON.stringify(openAIChunk)}\n\n`;
              controller.enqueue(encoder.encode(chunk));
            }

          } catch (parseError) {
            console.warn("⚠️ 解析流式数据失败:", parseError);
          }
        }

        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        finishStreamStats();
        hb.close();

      } catch (error) {
        console.error("❌ 流式处理错误:", error);
        hb.fail(error);
      }
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
      "X-Session-ID": sessionId,
      "X-Conversation-ID": conversationId
    }
  });
}

// 处理图像生成请求(专用端点)
async function handleImageGeneration(req: Request): Promise<Response> {
  // ==================== 并发控制:检查是否已有图像生成进行中 ====================
  if (isImageGenerating) {
    const elapsedTime = Date.now() - currentGenerationStartTime;

    // 检查是否超时(可能是僵尸锁)
    if (elapsedTime > IMAGE_GENERATION_TIMEOUT) {
      console.warn(`⚠️ 检测到超时的图像生成锁,自动释放 (已运行 ${Math.floor(elapsedTime/1000)} 秒)`);
      isImageGenerating = false;
    } else {
      // 拒绝并发请求
      console.log(`🚫 拒绝并发请求: 已有图像生成进行中 (已运行 ${Math.floor(elapsedTime/1000)} 秒)`);
      return new Response(JSON.stringify({
        error: {
          message: `服务器正在处理其他图像生成请求,请稍后重试。当前请求已运行 ${Math.floor(elapsedTime/1000)} 秒。`,
          type: "rate_limit_error",
          code: "concurrent_request_rejected"
        }
      }), {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Retry-After": "10"
        }
      });
    }
  }

  // 设置忙碌标志
  isImageGenerating = true;
  currentGenerationStartTime = Date.now();
  console.log(`🔒 设置图像生成锁 (时间戳: ${currentGenerationStartTime})`);

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
    const model = requestBody.model || "dall-e-3";  // 默认模型
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

    siderRequest.model = MODEL_MAPPING[model] || "sider";
    siderRequest.stream = true; // 图像生成必须使用流式以接收图像

    console.log("🚀 发送图像生成请求到 Sider");
    console.log("📋 请求配置:", {
      tools: siderRequest.tools,
      model: siderRequest.model,
      stream: siderRequest.stream,
      promptLength: imagePrompt.length
    });

    const imgUpstreamController = new AbortController();
    const imgUpstreamTimeout = setTimeout(() => imgUpstreamController.abort(), UPSTREAM_TIMEOUT_MS);

    const siderResponse = await fetch(SIDER_API_ENDPOINT, {
      method: "POST",
      signal: imgUpstreamController.signal,
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
    });

    clearTimeout(imgUpstreamTimeout);

    if (!siderResponse.ok) {
      const errorText = await siderResponse.text();
      console.error("❌ Sider API 错误:", errorText);
      throw new Error(`Sider API 错误: ${siderResponse.status} - ${errorText}`);
    }

    // 收集图像 URL (改进的流处理逻辑)
    const imageUrls: string[] = [];
    const reader = siderResponse.body?.getReader();
    if (!reader) {
      throw new Error("无法获取响应流");
    }

    const lineReader = new SSELineReader();
    let lineCount = 0;
    let hasToolCall = false;
    let hasDoneMarker = false;
    const maxWaitTime = 60000; // 最多等待60秒
    const startTime = Date.now();

    console.log("📡 开始读取 SSE 流...");

    try {
      for await (const line of lineReader.readLines(reader)) {
        lineCount++;
        const trimmedLine = line.trim();

        // 超时检查
        if (Date.now() - startTime > maxWaitTime) {
          console.warn("⚠️ 等待超时,停止读取");
          break;
        }

        if (trimmedLine === '[DONE]') {
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
          } else {
            console.warn("⚠️ 收到 [DONE] 但未看到工具调用,可能图像生成失败");
            break;
          }
        }

        if (!trimmedLine) continue;

        const dataLine = trimmedLine.startsWith('data:')
          ? trimmedLine.substring(5).trim()
          : trimmedLine;

        if (!dataLine) continue;

        try {
          const siderData = JSON.parse(dataLine);

          // 🐛 调试: 打印完整 JSON 结构
          if (lineCount <= 10) {
            console.log(`🔍 [行${lineCount}] 原始 JSON:`, JSON.stringify(siderData).substring(0, 200));
          }

          // 检查 Sider API 错误响应
          if (siderData.code && siderData.code !== 0) {
            console.error(`❌ Sider API 错误 [行${lineCount}]:`, {
              code: siderData.code,
              msg: siderData.msg
            });

            // 特殊处理:并发限制错误
            if (siderData.code === 1101) {
              throw new Error(`Sider API 限流: ${siderData.msg}。请等待当前请求完成后重试。`);
            }

            // 其他错误也应该抛出
            throw new Error(`Sider API 错误 (${siderData.code}): ${siderData.msg}`);
          }

          if (!siderData.data) {
            console.log(`⚠️ [行${lineCount}] 数据缺少 data 字段,跳过`);
            continue;
          }

          const dataType = siderData.data.type;
          console.log(`📦 [行${lineCount}] 收到数据类型: ${dataType}`);

          switch (dataType) {
            case "message_start":
              console.log("🚀 会话开始");
              break;

            case "tool_call":
              hasToolCall = true;
              console.log(`🔧 工具调用: ${siderData.data.tool_call.status} (hasToolCall 已设置为 true)`);
              if (siderData.data.tool_call.status === "processing") {
                console.log("⏳ 图像生成中...");
              } else if (siderData.data.tool_call.status === "start") {
                console.log("🎬 工具调用已启动");
              } else if (siderData.data.tool_call.status === "finish") {
                console.log("✅ 工具调用已完成");
              }
              break;

            case "file":
              if (siderData.data.file.type === "image") {
                imageUrls.push(siderData.data.file.url);
                console.log(`✅ 图像生成成功 (${imageUrls.length}/${n}):`, siderData.data.file.url);
                console.log(`📏 图像尺寸: ${siderData.data.file.width}x${siderData.data.file.height}`);

                // 如果已收集足够数量的图像,可以退出
                if (imageUrls.length >= n) {
                  console.log(`✅ 已收集到所需数量 (${n}) 的图像,准备结束`);
                  break;
                }
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
              if (siderData.data.text) {
                console.log("💬 文本内容:", siderData.data.text.substring(0, 50));
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

        } catch (parseError) {
          // 如果是我们主动抛出的 API 错误,需要重新抛出
          if (parseError instanceof Error && parseError.message.includes('Sider API')) {
            throw parseError;
          }
          // 否则是 JSON 解析错误,记录警告后继续
          console.warn(`⚠️ 解析失败 (行${lineCount}):`, dataLine.substring(0, 100));
        }
      }

      console.log(`\n📊 流处理完成统计:`);
      console.log(`   - 总行数: ${lineCount}`);
      console.log(`   - 是否有工具调用: ${hasToolCall ? "是" : "否"}`);
      console.log(`   - 是否收到 [DONE]: ${hasDoneMarker ? "是" : "否"}`);
      console.log(`   - 收集到的图像数: ${imageUrls.length}`);

    } catch (streamError) {
      console.error("❌ 流处理错误:", streamError);
      throw streamError;
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
    console.error("❌ 图像生成错误:", error);
    return new Response(JSON.stringify({
      error: {
        message: `图像生成失败: ${error.message}`,
        type: "server_error"
      }
    }), {
      status: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      }
    });
  } finally {
    // 释放锁 (无论成功还是失败)
    isImageGenerating = false;
    const totalTime = Date.now() - currentGenerationStartTime;
    console.log(`🔓 释放图像生成锁 (总耗时: ${Math.floor(totalTime/1000)} 秒)`);
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
  finishReason = "STOP"
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
      promptTokenCount: 0,
      candidatesTokenCount: content.length,
      totalTokenCount: content.length,
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

    // 入站适配: Gemini → messages[]
    const { messages } = geminiToMessages(body);

    // 能力门控: Gemini contents.parts 内含 inline_data/file_data (图像) => not_supported
    const geminiHasVision = (body.contents || []).some((c: any) =>
      Array.isArray(c?.parts) && c.parts.some((p: any) =>
        p && (p.inline_data || p.inlineData || p.file_data || p.fileData)));
    if (geminiHasVision) {
      console.warn("⛔ Gemini 收到视觉输入, 上游不支持; 返回 not_supported。");
      return notSupportedResponse("上游 sider 不支持视觉输入 (图像理解)。请仅发送文本。");
    }

    if (!messages.length) {
      return new Response(JSON.stringify({
        error: { message: "contents array is empty or invalid", type: "invalid_request_error" }
      }), { status: 400, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
    }

    const siderModel = MODEL_MAPPING[geminiModel] || "sider";
    const isThink = shouldEnableThinkMode(geminiModel);
    const lastMsg = messages[messages.length - 1];
    const prompt = typeof lastMsg?.content === "string" ? lastMsg.content : "";

    // 上下文拼接
    const fullContext = messages.length > 1
      ? (messages.map(m => {
          const label = m.role === "system" ? "[System]" : m.role === "assistant" ? "Assistant" : "User";
          return `${label}: ${typeof m.content === "string" ? m.content : ""}`;
        }).join("\n\n---\n\n"))
      : prompt;

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

    // 发送上游请求
    const upstreamController = new AbortController();
    const upstreamTimeout = setTimeout(() => upstreamController.abort(), UPSTREAM_TIMEOUT_MS);

    const siderResponse = await fetch(SIDER_API_ENDPOINT, {
      method: "POST",
      signal: upstreamController.signal,
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
    });
    clearTimeout(upstreamTimeout);

    if (!siderResponse.ok) {
      const errorText = await siderResponse.text();
      console.error("❌ Gemini上游错误:", errorText);
      return new Response(JSON.stringify({
        error: { message: `上游错误: ${siderResponse.status}`, type: "upstream_error" }
      }), { status: 502, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
    }

    // ===== 非流式: 消费上游流, 聚合后返回 Gemini 格式 =====
    if (!isStream) {
      let fullText = "", reasoningAcc = "";
      const reader = siderResponse.body?.getReader();
      if (!reader) throw new Error("无法获取响应流");
      const lineReader = new SSELineReader();
      for await (const line of lineReader.readLines(reader)) {
        const tl = line.trim();
        if (!tl || tl === "[DONE]") continue;
        const dl = tl.startsWith("data:") ? tl.substring(5).trim() : tl;
        if (!dl) continue;
        try {
          const sd = JSON.parse(dl);
          if (sd.code && sd.code !== 0) continue;
          const d = sd.data;
          if (!d) continue;
          if (d.type === "text" && d.text) fullText += d.text;
          if (d.type === "reasoning_content") {
            const rc = d.reasoning_content;
            if (typeof rc === "object" && rc !== null && "text" in rc) {
              reasoningAcc += (rc as Record<string, unknown>).text as string || "";
            }
          }
        } catch { /* skip */ }
      }
      // 用量统计: Gemini 非流式
      recordUsage({
        model: geminiModel,
        stream: false,
        ms: 0,
        toolUses: [],
        inputChars: prompt.length,
        outputChars: fullText.length,
      });
      const geminiResp = buildGeminiResponse(fullText || "生成完成", reasoningAcc, geminiModel);
      return new Response(JSON.stringify(geminiResp), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    // ===== 流式: SSE 逐块翻译 =====
    const stream = new ReadableStream({
      async start(controller) {
        const reader = siderResponse.body?.getReader();
        if (!reader) { controller.error(new Error("无法获取响应流")); return; }
        const lineReader = new SSELineReader();
        const encoder = new TextEncoder();
        const hb = createSSEHeartbeat(controller, encoder, COMMENT_PING_FRAME);
        // 用量统计累积
        const gT0 = Date.now();
        let gOutputChars = 0;
        const gTools = new Set<string>();
        const finishGeminiStats = () => {
          recordUsage({
            model: geminiModel,
            stream: true,
            ms: Date.now() - gT0,
            toolUses: [...gTools],
            inputChars: 0,
            outputChars: gOutputChars,
          });
        };

        try {
          for await (const line of lineReader.readLines(reader)) {
            const tl = line.trim();
            if (!tl) continue;
            const dl = tl.startsWith("data:") ? tl.substring(5).trim() : tl;
            if (dl === "[DONE]") {
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              finishGeminiStats();
              hb.close();
              return;
            }
            if (!dl) continue;
            try {
              const sd = JSON.parse(dl);
              if (sd.code && sd.code !== 0) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                  error: { code: sd.code, message: sd.msg || "" }
                })}\n\n`));
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                finishGeminiStats();
                hb.close();
                return;
              }
              const d = sd.data;
              if (!d) continue;

              // 累积输出字符 (text) 与工具名 (tool_call)
              if (d.type === "text" && d.text) gOutputChars += d.text.length;
              if (d.type === "tool_call" && d.tool_call?.name) gTools.add(d.tool_call.name);

              let geminiChunk: any = null;
              if (d.type === "text" && d.text) {
                geminiChunk = {
                  candidates: [{
                    content: { role: "model", parts: [{ text: d.text }] },
                    index: 0,
                  }],
                };
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
            } catch { /* skip */ }
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          finishGeminiStats();
          hb.close();
        } catch (err: any) {
          console.error("❌ Gemini流式错误:", err);
          hb.fail(err);
        }
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
    console.error("❌ Gemini处理错误:", error);
    return new Response(JSON.stringify({
      error: { message: `处理请求失败: ${error.message}`, type: "server_error" }
    }), { status: 500, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
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
  stopReason = "end_turn", usage: any = null,
): any {
  const resp: any = {
    id,
    type: "message",
    role: "assistant",
    model: modelName,
    content: [{ type: "text", text: content }],
    stop_reason: stopReason,
  };
  if (reasoning) {
    resp.content.unshift({ type: "thinking", thinking: reasoning });
  }
  resp.usage = usage || { input_tokens: 0, output_tokens: content.length };
  return resp;
}

// 处理 Anthropic 请求 (非流式 + 流式)
async function handleAnthropicMessage(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const isStream = body.stream === true;
    console.log(`📥 Anthropic ${isStream ? "stream" : "message"}: model=${body.model}`);

    const { messages } = anthropicToMessages(body);

    // 能力门控: Anthropic content 块含 {type:"image",source:{...}} => not_supported
    const anthroHasVision = (body.messages || []).some((m: any) =>
      Array.isArray(m?.content) && m.content.some((b: any) =>
        b && (b.type === "image" || b.source)));
    if (anthroHasVision) {
      console.warn("⛔ Anthropic 收到视觉输入, 上游不支持; 返回 not_supported。");
      return new Response(JSON.stringify({
        type: "error",
        error: { type: "not_supported", message: "上游 sider 不支持视觉输入 (图像理解)。请仅发送文本。" },
      }), { status: 422, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
    }

    if (!messages.length) {
      return new Response(JSON.stringify({
        type: "error",
        error: { type: "invalid_request_error", message: "messages array is empty or invalid" },
      }), { status: 400, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
    }

    const anthroModel = body.model || "claude-sonnet-4.6";
    const siderModel = MODEL_MAPPING[anthroModel] || "sider";
    const isThink = shouldEnableThinkMode(anthroModel);
    const msgId = `msg_${Date.now()}`;
    const lastContent = messages[messages.length - 1]?.content;
    const prompt = typeof lastContent === "string" ? lastContent : "";

    // 上下文拼接
    const fullContext = messages.length > 1
      ? messages.map(m => {
          const label = m.role === "system" ? "[System]"
            : m.role === "assistant" ? "Assistant" : "User";
          return `${label}: ${typeof m.content === "string" ? m.content : ""}`;
        }).join("\n\n---\n\n")
      : prompt;

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

    const upstreamController = new AbortController();
    const upstreamTimeout = setTimeout(() => upstreamController.abort(), UPSTREAM_TIMEOUT_MS);
    const siderResp = await fetch(SIDER_API_ENDPOINT, {
      method: "POST", signal: upstreamController.signal,
      headers: {
        "Content-Type": "application/json", Authorization: `Bearer ${SIDER_AUTH_TOKEN}`,
        "Accept": "*/*", "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Origin": "chrome-extension://dhoenijjpgpeimemopealfcbiecgceod",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "X-App-Name": "ChitChat_Edge_Ext", "X-App-Version": "5.21.2",
      },
      body: JSON.stringify(siderRequest),
    });
    clearTimeout(upstreamTimeout);

    if (!siderResp.ok) {
      const errorText = await siderResp.text();
      console.error("❌ Anthropic上游错误:", errorText);
      return new Response(JSON.stringify({
        type: "error",
        error: { type: "api_error", message: `上游错误: ${siderResp.status}` },
      }), { status: 502, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
    }

    // ---- 非流式 ----
    if (!isStream) {
      let fullText = "", reasoningAcc = "";
      const reader = siderResp.body?.getReader();
      if (!reader) throw new Error("无法获取响应流");
      const lineReader = new SSELineReader();
      for await (const line of lineReader.readLines(reader)) {
        const tl = line.trim();
        if (!tl || tl === "[DONE]") continue;
        const dl = tl.startsWith("data:") ? tl.substring(5).trim() : tl;
        if (!dl) continue;
        try {
          const sd = JSON.parse(dl);
          if (sd.code && sd.code !== 0) continue;
          const d = sd.data; if (!d) continue;
          if (d.type === "text" && d.text) fullText += d.text;
          if (d.type === "reasoning_content") {
            const rc = d.reasoning_content;
            if (typeof rc === "object" && rc !== null && "text" in rc) {
              reasoningAcc += (rc as Record<string, unknown>).text as string || "";
            }
          }
        } catch { /* skip */ }
      }
      // 用量统计: Anthropic 非流式
      recordUsage({
        model: anthroModel,
        stream: false,
        ms: 0,
        toolUses: [],
        inputChars: prompt.length,
        outputChars: fullText.length,
      });
      const resp = buildAnthropicResponse(msgId, fullText || "生成完成", anthroModel, reasoningAcc);
      return new Response(JSON.stringify(resp), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    // ---- 流式: Anthropic SSE 事件序列 (content-block 状态机) ----
    // 惰性开块 + 单调 index + 成对 start/stop; reasoning_content->thinking, text->text。
    const sstream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const reader = siderResp.body?.getReader();
        if (!reader) { controller.error(new Error("无响应流")); return; }
        const lineReader = new SSELineReader();
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
        // 用量统计累积: 工具名 (Set 去重) + 计时
        const anthroT0 = Date.now();
        const anthroTools = new Set<string>();
        const finishAnthroStats = () => {
          recordUsage({
            model: anthroModel,
            stream: true,
            ms: Date.now() - anthroT0,
            toolUses: [...anthroTools],
            inputChars: 0,
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
              usage: { input_tokens: 0, output_tokens: 0 },
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
        const finishOk = () => {
          ensureStart();
          closeBlock();
          sendEvent("message_delta", {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            // token 估算 (约 4 字符/token), 避免用字符数直填 usage。
            usage: { output_tokens: Math.max(1, Math.ceil(outputChars / 4)) },
          });
          sendEvent("message_stop", { type: "message_stop" });
          finishAnthroStats();
          hb.close();
        };

        try {
          ensureStart();

          for await (const line of lineReader.readLines(reader)) {
            const tl = line.trim();
            if (!tl) continue;
            const dl = tl.startsWith("data:") ? tl.substring(5).trim() : tl;
            if (dl === "[DONE]") { finishOk(); return; }
            if (!dl) continue;
            try {
              const sd = JSON.parse(dl);
              if (sd.code && sd.code !== 0) {
                closeBlock();
                sendEvent("error", {
                  type: "error",
                  error: { type: "api_error", message: sd.msg || `code=${sd.code}` },
                });
                sendEvent("message_stop", { type: "message_stop" });
                hb.close();
                return;
              }
              const d = sd.data; if (!d) continue;
              if (d.type === "text" && d.text) {
                if (currentBlock !== "text") openBlock("text");
                outputChars += d.text.length;
                sendEvent("content_block_delta", {
                  type: "content_block_delta",
                  index: blockIndex,
                  delta: { type: "text_delta", text: d.text },
                });
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
            } catch { /* skip 单行解析错误 */ }
          }

          // 上游未显式发 [DONE] 就结束的兜底
          finishOk();
        } catch (err: any) {
          console.error("❌ Anthropic流错误:", err);
          if (!hb.closed) {
            closeBlock();
            sendEvent("error", {
              type: "error",
              error: { type: "api_error", message: err?.message || "stream error" },
            });
            sendEvent("message_stop", { type: "message_stop" });
          }
          finishAnthroStats();
          hb.close();
        }
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
    console.error("❌ Anthropic处理错误:", error);
    return new Response(JSON.stringify({
      type: "error",
      error: { type: "api_error", message: `处理请求失败: ${error.message}` },
    }), { status: 500, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
  }
}

// ==================== OpenAI Responses API 格式处理 ====================

// Responses API 入站适配: input(字符串/数组) + instructions → messages[]
function responsesToMessages(body: any): { messages: any[]; prompt: string } {
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
      const role = m.role === "assistant" ? "assistant" : "user";
      let content = "";
      if (typeof m.content === "string") {
        content = m.content;
      } else if (Array.isArray(m.content)) {
        content = m.content.filter((b: any) => b.type === "text")
          .map((b: any) => b.text || "").join("\n");
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

  return {
    id, object: "response",
    model: modelName,
    output,
    usage: {
      input_tokens: 0,
      output_tokens: content.length,
      total_tokens: content.length,
    },
  };
}

async function handleOpenAIResponse(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const isStream = body.stream === true;
    console.log(`📥 Responses ${isStream ? "stream" : "nonstream"}: model=${body.model}`);

    const { messages, prompt } = responsesToMessages(body);

    // 能力门控: Responses input 数组含 input_image 块 => not_supported
    const respHasVision = Array.isArray(body.input) && body.input.some((m: any) =>
      Array.isArray(m?.content) && m.content.some((b: any) =>
        b && (b.type === "input_image" || b.type === "image_url" || b.image_url)));
    if (respHasVision) {
      console.warn("⛔ Responses 收到视觉输入, 上游不支持; 返回 not_supported。");
      return notSupportedResponse("上游 sider 不支持视觉输入 (图像理解)。请仅发送文本。");
    }

    if (!messages.length) {
      return new Response(JSON.stringify({
        error: { message: "input is required", type: "invalid_request_error", param: "input" },
      }), { status: 400, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
    }

    const modelName = body.model || "sider";
    const siderModel = MODEL_MAPPING[modelName] || "sider";
    const isThink = shouldEnableThinkMode(modelName);
    const respId = `resp_${Date.now()}`;

    // 上下文拼接
    const fullContext = messages.length > 1
      ? messages.map(m => {
          const label = m.role === "system" ? "[System]"
            : m.role === "assistant" ? "Assistant" : "User";
          return `${label}: ${typeof m.content === "string" ? m.content : ""}`;
        }).join("\n\n---\n\n")
      : prompt;

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

    const upstreamController = new AbortController();
    const upstreamTimeout = setTimeout(() => upstreamController.abort(), UPSTREAM_TIMEOUT_MS);
    const siderResp = await fetch(SIDER_API_ENDPOINT, {
      method: "POST", signal: upstreamController.signal,
      headers: {
        "Content-Type": "application/json", Authorization: `Bearer ${SIDER_AUTH_TOKEN}`,
        "Accept": "*/*", "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Origin": "chrome-extension://dhoenijjpgpeimemopealfcbiecgceod",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "X-App-Name": "ChitChat_Edge_Ext", "X-App-Version": "5.21.2",
      },
      body: JSON.stringify(siderRequest),
    });
    clearTimeout(upstreamTimeout);

    if (!siderResp.ok) {
      return new Response(JSON.stringify({
        error: { message: `上游错误: ${siderResp.status}`, type: "api_error" },
      }), { status: 502, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
    }

    // ---- 非流式 ----
    if (!isStream) {
      let fullText = "", reasoningAcc = "";
      const reader = siderResp.body?.getReader();
      if (!reader) throw new Error("无法获取响应流");
      const lineReader = new SSELineReader();
      for await (const line of lineReader.readLines(reader)) {
        const tl = line.trim();
        if (!tl || tl === "[DONE]") continue;
        const dl = tl.startsWith("data:") ? tl.substring(5).trim() : tl;
        if (!dl) continue;
        try {
          const sd = JSON.parse(dl);
          if (sd.code && sd.code !== 0) continue;
          const d = sd.data; if (!d) continue;
          if (d.type === "text" && d.text) fullText += d.text;
          if (d.type === "reasoning_content") {
            const rc = d.reasoning_content;
            if (typeof rc === "object" && rc !== null && "text" in rc) {
              reasoningAcc += (rc as Record<string, unknown>).text as string || "";
            }
          }
        } catch { /* skip */ }
      }
      // 用量统计: Responses 非流式
      recordUsage({
        model: modelName,
        stream: false,
        ms: 0,
        toolUses: [],
        inputChars: prompt.length,
        outputChars: fullText.length,
      });
      const respData = buildResponsesResponse(respId, fullText || "生成完成", modelName, reasoningAcc);
      return new Response(JSON.stringify(respData), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    // ---- 流式: Responses API SSE ----
    const respStream = new ReadableStream({
      async start(controller) {
        const reader = siderResp.body?.getReader();
        if (!reader) { controller.error(new Error("无响应流")); return; }
        const lineReader = new SSELineReader();
        const encoder = new TextEncoder();
        const hb = createSSEHeartbeat(controller, encoder, COMMENT_PING_FRAME);
        // 用量统计累积
        const rT0 = Date.now();
        let rOutputChars = 0;
        const rTools = new Set<string>();
        const finishResponsesStats = () => {
          recordUsage({
            model: modelName,
            stream: true,
            ms: Date.now() - rT0,
            toolUses: [...rTools],
            inputChars: 0,
            outputChars: rOutputChars,
          });
        };

        const sendEvent = (event: string, data: any) => {
          if (hb.closed) return;
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        };

        const initialResp: any = {
          object: "response", id: respId, model: modelName,
          output: [], status: "in_progress",
        };
        sendEvent("response.created", { type: "response.created", response: initialResp });

        let textStarted = false;
        sendEvent("response.output_text.delta", { type: "response.output_text.delta", delta: "" });

        try {
          for await (const line of lineReader.readLines(reader)) {
            const tl = line.trim();
            if (!tl) continue;
            const dl = tl.startsWith("data:") ? tl.substring(5).trim() : tl;
            if (dl === "[DONE]") {
              const completedResp = {
                ...initialResp,
                status: "completed",
                output: [{
                  type: "message", role: "assistant",
                  content: [{ type: "output_text", text: textStarted ? "" : "" }],
                }],
                usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
              };
              sendEvent("response.completed", { type: "response.completed", response: completedResp });
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              finishResponsesStats();
              hb.close(); return;
            }
            if (!dl) continue;
            try {
              const sd = JSON.parse(dl);
              if (sd.code && sd.code !== 0) {
                sendEvent("error", {
                  type: "error",
                  error: { type: "api_error", message: sd.msg || `code=${sd.code}` },
                });
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                finishResponsesStats();
                hb.close(); return;
              }
              const d = sd.data; if (!d) continue;
              if (d.type === "text" && d.text) {
                if (!textStarted) textStarted = true;
                rOutputChars += d.text.length;
                sendEvent("response.output_text.delta", {
                  type: "response.output_text.delta",
                  item_id: respId,
                  output_index: 0,
                  content_index: 0,
                  delta: d.text,
                });
              }
              if (d.type === "tool_call" && d.tool_call?.name) {
                rTools.add(d.tool_call.name);
              }
              // reasoning_content ignored in responses stream (kept simple)
            } catch { /* skip */ }
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          finishResponsesStats();
          hb.close();
        } catch (err: any) { console.error("❌ Responses流错误:", err); finishResponsesStats(); hb.fail(err); }
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
    console.error("❌ Responses处理错误:", error);
    return new Response(JSON.stringify({
      error: { message: `处理请求失败: ${error.message}`, type: "server_error" },
    }), { status: 500, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
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
  if (total === 0) {
    return `<circle cx="90" cy="90" r="62" fill="none" stroke="var(--grid)" stroke-width="26"/>
      <text x="90" y="90" class="donut-empty" text-anchor="middle" dominant-baseline="middle">暂无数据</text>`;
  }

  const R = 62;
  const C = 2 * Math.PI * R;
  let offset = 0;
  const arcs = models.map((m, i) => {
    const frac = m.requests / total;
    const len = frac * C;
    // 2px 表面间隙: 相邻扇区之间留缝, 避免两色直接相接
    const gap = models.length > 1 ? 2 : 0;
    const dash = `${Math.max(len - gap, 0.5)} ${C - Math.max(len - gap, 0.5)}`;
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
    <text x="90" y="82" class="donut-num" text-anchor="middle">${total}</text>
    <text x="90" y="102" class="donut-cap" text-anchor="middle">总请求</text>`;
}

/** 面积图: 字符使用趋势。单一 y 轴, input/output 两条序列。 */
function statsTrendChart(trend: TrendBucketRow[]): string {
  const W = 720;
  const H = 200;
  const PAD_L = 48;
  const PAD_B = 26;
  const PAD_T = 12;
  const plotW = W - PAD_L - 12;
  const plotH = H - PAD_B - PAD_T;

  const peak = Math.max(1, ...trend.map((b) => Math.max(b.inputChars, b.outputChars)));
  const stepX = trend.length > 1 ? plotW / (trend.length - 1) : plotW;
  const x = (i: number) => PAD_L + i * stepX;
  const y = (v: number) => PAD_T + plotH - (v / peak) * plotH;

  const line = (pick: (b: TrendBucketRow) => number) =>
    trend.map((b, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(pick(b)).toFixed(1)}`).join(" ");
  const area = (pick: (b: TrendBucketRow) => number) =>
    `${line(pick)} L${x(trend.length - 1).toFixed(1)},${(PAD_T + plotH).toFixed(1)} L${x(0).toFixed(1)},${(PAD_T + plotH).toFixed(1)} Z`;

  // 5 条横向参考线
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
      <title>${hhmm(b.at)}　请求 ${b.requests}　输入 ${compactNum(b.inputChars)}　输出 ${compactNum(b.outputChars)}</title>
    </rect>`
  ).join("");

  return `<svg viewBox="0 0 ${W} ${H}" class="trend" role="img" aria-label="近 24 小时字符使用趋势">
    ${grid}
    <path d="${area((b) => b.inputChars)}" fill="var(--s1)" opacity="0.14"/>
    <path d="${line((b) => b.inputChars)}" fill="none" stroke="var(--s1)" stroke-width="2" stroke-linejoin="round"/>
    <path d="${area((b) => b.outputChars)}" fill="var(--s2)" opacity="0.14"/>
    <path d="${line((b) => b.outputChars)}" fill="none" stroke="var(--s2)" stroke-width="2" stroke-linejoin="round"/>
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
      inputChars: rest.reduce((s, m) => s + m.inputChars, 0),
      outputChars: rest.reduce((s, m) => s + m.outputChars, 0),
      totalChars: rest.reduce((s, m) => s + m.totalChars, 0),
    });
  }
  return shown;
}

/** 顶部三个统计卡。 */
function statsTilesHtml(totals: StatsSnapshot["totals"]): string {
  return `<div class="card tile"><div class="v">${totals.requests}</div><div class="k">上游请求</div></div>
  <div class="card tile"><div class="v">${compactNum(totals.inputChars + totals.outputChars)}</div><div class="k">字符总量</div></div>
  <div class="card tile"><div class="v">${totals.toolCalls}</div><div class="k">工具调用</div></div>`;
}

/** header 副标题 (时间起点 + 链接)。 */
function statsSubHtml(snapshot: StatsSnapshot): string {
  return `自 ${escHtml(hhmm(snapshot.since))} 起 · 近 24 小时趋势 · <a href="/">服务信息</a> · <a href="/admin">管理界面</a>`;
}

/** 模型分布表 tbody 行。 */
function statsModelRowsHtml(shown: ModelStatRow[]): string {
  if (shown.length === 0) {
    return `<tr><td colspan="4" class="empty-row">暂无数据</td></tr>`;
  }
  return shown.map((m, i) => `<tr>
      <td><i class="dot" style="background:var(--s${i + 1})"></i>${escHtml(m.model)}</td>
      <td class="num">${m.requests}</td>
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
  ${snapshot.persisted ? "聚合数据已持久化（Deno KV），跨实例、跨重启累计。" : "⚠️ 聚合数据未持久化：仅统计当前实例，且实例回收后清零。"}
  流式请求 ${snapshot.totals.streaming} 次。字符数以请求文本长度估算（上游流式不回传 token 用量）。`;
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
        <thead><tr><th>模型</th><th class="num">请求</th><th class="num">字符</th><th class="num">输入/输出</th></tr></thead>
        <tbody id="modelRows">${statsModelRowsHtml(shown)}</tbody>
      </table>
    </div>
  </div>
  <div class="card">
    <h2>字符使用趋势（近 24 小时）</h2>
    <div class="legend">
      <span><i style="background:var(--s1)"></i>输入字符</span>
      <span><i style="background:var(--s2)"></i>输出字符</span>
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
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Session-ID"
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

