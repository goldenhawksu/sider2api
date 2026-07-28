// sider2api - 精简版 OpenAI 兼容网关 (单文件, 零依赖 Deno)
// 定位: 面向 OpenAI /v1/chat/completions 的聚焦网关。
// 借鉴 deno_pro.ts 的生产级设计落地 Phase1/2/3:
//   Phase1 - 新上游协议(sider.ai/api/chat/v1) + multi_content 模板 + 会话管理 + 超时 + 错误码映射
//   Phase2 - SSE 心跳保活 + reasoning_content 事件 + 流内错误检测
//   Phase3 - 上下文长度截断 + 能力门控(vision/tools) + 会话过期清理
// 多协议(Gemini/Anthropic/Responses)、图像生成、Admin 属 deno_pro.ts 域, 本文件不含。

// ==================== 配置常量 ====================

const SIDER_API_ENDPOINT = "https://sider.ai/api/chat/v1/completions";

// 上游 sider Token (仅 .env, 代码不含真实值)
const SIDER_AUTH_TOKEN = Deno.env.get("SIDER_AUTH_TOKEN");
// 服务端 API 认证 Token (可选; 未配置则放行所有请求)
const AUTH_TOKEN = Deno.env.get("AUTH_TOKEN");

// 上游请求超时(毫秒) - 避免长时间挂起放大尾延迟
const UPSTREAM_TIMEOUT_MS = parseInt(Deno.env.get("UPSTREAM_TIMEOUT_MS") || "60000", 10);
// 是否默认启用自动联网搜索(会显著影响 TTFT/长尾)
const ENABLE_AUTO_SEARCH = (Deno.env.get("ENABLE_AUTO_SEARCH") || "true").toLowerCase() === "true";
// Sider API 对 text/user_input_text 字段的字符上限, 预留安全余量
const SIDER_MAX_CHARS = 49500;
// Sider API 词数上限(实测 code:603 触发于长对话), 保守设 6000 词
const SIDER_MAX_WORDS = 6000;
// SSE 心跳间隔(毫秒): 流式空闲时定期发 ping 帧, 防止 nginx/LB/客户端掐断空闲连接。0 关闭。
const SSE_PING_INTERVAL_MS = parseInt(Deno.env.get("SSE_PING_INTERVAL_MS") || "15000", 10);

// 默认请求模板(基于真实成功的抓包数据; multi_content/model/tools 运行时填充)
const DEFAULT_REQUEST_TEMPLATE = {
  "stream": true,
  "cid": "",
  "model": "sider",
  "filter_search_history": false,
  "from": "chat",
  "chat_models": [],
  "think_mode": { "enable": false },
  "quote": null,
  "prompt_templates": [
    { "key": "artifacts", "attributes": { "lang": "original" } }
  ],
  "extra_info": {
    "origin_url": "chrome-extension://dhoenijjpgpeimemopealfcbiecgceod/standalone.html?from=sidebar",
    "origin_title": "Sider"
  },
  "customize_instructions": { "enable": true }
};

// 模型映射(与上游 probe 确认的当前可用模型集一致)
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

  // DeepSeek 系列
  "deepseek-v4-flash": "deepseek-v4-flash",
  "deepseek-v4-flash-think": "deepseek-v4-flash-think",
  "deepseek-v4-pro": "deepseek-v4-pro",
  "deepseek-v4-pro-think": "deepseek-v4-pro-think",

  // 其他模型
  "grok-4": "grok-4",
  "glm-5": "glm-5",
  "glm-5-think": "glm-5-think",
  "qwen3-max": "qwen3-max",
  "kimi-k3": "kimi-k3",
  "llama-3.1-405b": "llama-3.1-405b",

  // 默认智能路由
  "sider": "sider"
};

const MODEL_CREATED_TIMESTAMP = 1704067200; // 2024-01-01 基准

// 支持的模型列表 (完全兼容 OpenAI API 格式, 含 created/root/parent)
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

// ==================== 会话管理 (多轮对话) ====================

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
setInterval(cleanupOldSessions, 1800000); // 每30分钟

// ==================== 工具函数 ====================

// 轻量级字符串哈希(djb2 变体), 用于会话指纹
function simpleHash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
    hash = hash >>> 0;
  }
  return hash.toString(36);
}

// OpenAI content 可为 string 或 content-block 数组, 统一扁平化为字符串。
function flattenMessageContent(content: any): string {
  if (typeof content === "string") return content;
  if (!content) return "";
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part) return "";
        if (typeof part === "string") return part;
        if (part.type === "text" && typeof part.text === "string") return part.text;
        if ((part.type === "input_text" || part.type === "inputText") && typeof part.text === "string") return part.text;
        return ""; // 图像/工具等非文本块在扁平化时忽略
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof content.text === "string") return content.text;
  return String(content);
}

// 从 messages[] 推导稳定会话指纹(同一对话「system + 第一条 user」不变)。
function deriveSessionId(messages: any[]): string {
  const systemText = flattenMessageContent(messages.find(m => m.role === "system")?.content ?? "");
  const firstUserText = flattenMessageContent(messages.find(m => m.role === "user")?.content ?? "");
  return `conv-${simpleHash(systemText + "|" + firstUserText)}`;
}

// 估算词数: 中日韩字符各计 1 词, 其余按空白分词。用于防触发 code:603。
function estimateWordCount(text: string): number {
  const cjkChars = (text.match(/[一-鿿぀-ヿ가-힯]/g) || []).length;
  const otherWords = text.replace(/[一-鿿぀-ヿ가-힯]/g, " ")
    .trim().split(/\s+/).filter(Boolean).length;
  return cjkChars + otherWords;
}

// 将 messages[] 历史拼接为上下文(Phase3 上下文截断)。
// 优先级: system > 当前问题 > 历史(从最新往最旧填充), 严守 SIDER_MAX_CHARS/WORDS。
function buildFullContext(msgs: any[]): string {
  if (!msgs || msgs.length === 0) return "";
  const SEP = "\n\n---\n\n";
  const nonSystemMsgs = msgs.filter(m => m.role !== "system");

  if (nonSystemMsgs.length <= 1 && !msgs.find(m => m.role === "system")) {
    return flattenMessageContent(msgs[0]?.content || "");
  }

  const systemMsg = msgs.find(m => m.role === "system");
  const systemPart = systemMsg ? `[System]\n${flattenMessageContent(systemMsg.content)}` : "";

  const currentText = flattenMessageContent(nonSystemMsgs[nonSystemMsgs.length - 1]?.content);
  const currentPart = `[Current Question]\n${currentText}`;

  const fixedChars = (systemPart ? systemPart.length + SEP.length : 0) + currentPart.length;
  const historyBudget = SIDER_MAX_CHARS - fixedChars - SEP.length - "[Conversation History]\n".length;

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

// 能力门控(CLAUDE.md 铁律): 上游不支持视觉输入。检测图像块 → 返回 not_supported。
// 兼容 OpenAI(image_url) / Anthropic(image source) / Gemini(inline_data)。
function detectVisionInput(messages: any[]): boolean {
  for (const m of (messages || [])) {
    const c = m?.content;
    if (!Array.isArray(c)) continue;
    for (const part of c) {
      if (!part || typeof part !== "object") continue;
      const t = part.type;
      if (t === "image_url" || t === "image" || t === "input_image") return true;
      if (part.source && (part.source.type === "base64" || part.source.type === "url")) return true;
      if (part.inline_data || part.inlineData || part.file_data || part.fileData) return true;
    }
  }
  return false;
}

// 标准化 not_supported 错误响应 (能力门控统一出口)
function notSupportedResponse(message: string, code = "vision_not_supported"): Response {
  return new Response(JSON.stringify({
    error: { message, type: "not_supported", code }
  }), {
    status: 422,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
  });
}

// 是否启用 Think 模式(模型名 -think 后缀)
function shouldEnableThinkMode(modelName: string): boolean {
  return modelName.includes("-think");
}

// 是否为本次 prompt 启用上游联网搜索(默认 OFF 时按关键词触发)
function shouldEnableAutoSearch(prompt: string): boolean {
  if (ENABLE_AUTO_SEARCH) return true;
  return /\b(search|查一下|查询|搜索|找一下|最新|新闻|link|citation|来源)\b/i.test(prompt);
}

// ==================== 认证中间件 ====================

function authMiddleware(handler: (req: Request) => Promise<Response>): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    if (!AUTH_TOKEN) {
      return handler(req);
    }
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return new Response(JSON.stringify({
        error: {
          message: "Unauthorized: Missing or invalid Authorization header",
          type: "invalid_request_error"
        }
      }), {
        status: 401,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }
    const token = authHeader.split(" ")[1];
    if (token !== AUTH_TOKEN) {
      return new Response(JSON.stringify({
        error: { message: "Unauthorized: Invalid token", type: "invalid_request_error" }
      }), {
        status: 401,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }
    return handler(req);
  };
}

// ==================== SSE 基础设施 ====================

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

// SSE 流安全写入 + 心跳。closed 守卫避免 close 后再 enqueue / 二次 close。
// OpenAI/Gemini/Responses 用 SSE 注释行 ": ping" 作心跳(所有兼容解析器忽略);
// Anthropic 用官方 event: ping 帧。
const COMMENT_PING_FRAME = ": ping\n\n";
const ANTHROPIC_PING_FRAME = `event: ping\ndata: ${JSON.stringify({ type: "ping" })}\n\n`;

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
    get closed() { return closed; },
    close() {
      if (closed) return;
      closed = true;
      if (timer) clearInterval(timer);
      try { controller.close(); } catch { /* 已关闭 */ }
    },
    fail(err: unknown) {
      if (closed) return;
      closed = true;
      if (timer) clearInterval(timer);
      try { controller.error(err); } catch { /* 已关闭 */ }
    },
  };
}

// ==================== 上游错误码映射 ====================

// 将 sider 上游错误码翻译为 OpenAI 兼容错误响应。
function translateUpstreamError(status: number, errorText: string): Response {
  let errorPayload: any = null;
  try { errorPayload = JSON.parse(errorText); } catch { /* 非 JSON */ }
  const upstreamCode = errorPayload?.code;
  const upstreamMsg = errorPayload?.msg || "";
  let statusCode = status;
  let message = `Sider API 错误: ${status} - ${errorText}`;
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
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
  });
}

// ==================== 请求处理器 ====================

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

    // 能力门控: 上游不支持视觉输入, 收到图像块直接返回 not_supported (不静默丢给上游幻觉)。
    if (detectVisionInput(messages)) {
      console.warn("⛔ 收到视觉输入(图像), 上游 sider 不支持; 返回 not_supported。");
      return notSupportedResponse(
        "上游 sider 不支持视觉输入 (图像理解)。请仅发送文本内容。"
      );
    }

    // 能力门控: 上游不支持自定义 function calling。优雅降级为纯文本 (不伪造 tool_calls)。
    const hasCustomTools = Array.isArray(requestBody.tools) &&
      requestBody.tools.some((t: any) => t && t.type === "function");
    const hasLegacyFunctions = Array.isArray(requestBody.functions) && requestBody.functions.length > 0;
    const customToolsRequested = hasCustomTools || hasLegacyFunctions;
    const toolChoiceNone = requestBody.tool_choice === "none";
    const customToolsDegraded = customToolsRequested && !toolChoiceNone;
    if (customToolsDegraded) {
      console.warn("⚠️ 收到自定义 function tools, 上游不支持; 已降级为纯文本 (不伪造 tool_calls)。");
    }

    const userPrompt = flattenMessageContent(lastMessage?.content);
    // 多轮时注入完整上下文, 单轮直接用原始 prompt
    const fullContext = messages.length > 1 ? buildFullContext(messages) : userPrompt;

    // 会话 ID: 优先客户端 X-Session-ID, 否则 messages 指纹推导
    const sessionId = req.headers.get("X-Session-ID") || deriveSessionId(messages);
    const session = conversationSessions.get(sessionId);

    // 构建 Sider 请求
    const siderRequest = JSON.parse(JSON.stringify(DEFAULT_REQUEST_TEMPLATE));
    const enableThink = shouldEnableThinkMode(modelName);

    siderRequest.multi_content = [{
      type: "text",
      text: fullContext,
      user_input_text: fullContext
    }];
    siderRequest.model = siderModel;
    siderRequest.stream = isStreaming;
    siderRequest.think_mode = { enable: enableThink };

    if (session) {
      siderRequest.cid = session.cid;
      siderRequest.parent_message_id = session.parent_message_id;
      session.last_used = Date.now();
      console.log(`♻️ 使用现有会话: ${sessionId} (cid: ${session.cid})`);
    } else {
      console.log(`🆕 创建新会话: ${sessionId}`);
    }

    const enableSearch = shouldEnableAutoSearch(userPrompt);
    siderRequest.tools = { auto: enableSearch ? ["search", "data_analysis"] : ["data_analysis"] };

    console.log("🚀 发送到 Sider:", {
      model: siderRequest.model, thinkMode: enableThink,
      sessionId, hasCid: !!siderRequest.cid, stream: isStreaming
    });

    if (!SIDER_AUTH_TOKEN) {
      return new Response(JSON.stringify({
        error: { message: "Sider authorization token not configured", type: "server_error" }
      }), {
        status: 500,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    // 发送请求(带超时控制)
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
      return translateUpstreamError(siderResponse.status, errorText);
    }

    console.log("✅ Sider 响应状态:", siderResponse.status);

    if (!isStreaming) {
      return await handleNonStreamingResponse(siderResponse, modelName, fullContext, sessionId, customToolsDegraded);
    }
    return handleStreamingResponse(siderResponse, modelName, sessionId);

  } catch (error: any) {
    console.error("❌ 处理聊天请求错误:", error);
    return new Response(JSON.stringify({
      error: { message: `处理请求失败: ${error.message}`, type: "server_error" }
    }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  }
}

// 处理非流式响应
async function handleNonStreamingResponse(
  siderResponse: Response,
  modelName: string,
  userPrompt: string,
  sessionId: string,
  customToolsDegraded = false
): Promise<Response> {
  let fullText = "";
  let reasoningContentAcc = "";
  let conversationId = "";
  let messageId = "";

  const reader = siderResponse.body?.getReader();
  if (!reader) throw new Error("无法获取响应流");

  const lineReader = new SSELineReader();

  for await (const line of lineReader.readLines(reader)) {
    const trimmedLine = line.trim();
    if (!trimmedLine || trimmedLine === '[DONE]') continue;
    const dataLine = trimmedLine.startsWith('data:') ? trimmedLine.substring(5).trim() : trimmedLine;
    if (!dataLine) continue;

    try {
      const siderData = JSON.parse(dataLine);
      if (!siderData.data) continue;

      switch (siderData.data.type) {
        case "message_start":
          conversationId = siderData.data.message_start.cid || "";
          messageId = siderData.data.message_start.assistant_message_id || "";
          conversationSessions.set(sessionId, {
            cid: conversationId,
            parent_message_id: messageId,
            created_at: conversationSessions.get(sessionId)?.created_at || Date.now(),
            last_used: Date.now()
          });
          break;
        case "text":
          fullText += siderData.data.text || "";
          break;
        case "reasoning_content": {
          const rc = siderData.data.reasoning_content;
          if (typeof rc === "object" && rc !== null && "text" in rc) {
            reasoningContentAcc += (rc as Record<string, unknown>).text as string || "";
          }
          break;
        }
      }
    } catch {
      console.warn("⚠️ 解析失败:", dataLine.substring(0, 100));
    }
  }

  const content = fullText || "生成完成";
  const openAIResponse: any = {
    id: messageId || `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: modelName,
    choices: [{
      message: { role: "assistant", content },
      finish_reason: "stop",
      index: 0
    }],
    usage: {
      prompt_tokens: userPrompt.length,
      completion_tokens: fullText.length,
      total_tokens: userPrompt.length + fullText.length
    }
  };

  if (reasoningContentAcc) {
    openAIResponse.choices[0].message.reasoning_content = reasoningContentAcc;
  }

  // 能力门控透明告知: 自定义工具已降级(不伪造 tool_calls)
  if (customToolsDegraded) {
    openAIResponse.warning = {
      type: "tools_not_supported",
      message: "上游 sider 不支持自定义 function calling, 已降级为纯文本对话。"
    };
  }

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
      const streamT0 = Date.now();
      let firstChunkAt: number | null = null;

      try {
        for await (const line of lineReader.readLines(reader)) {
          const trimmedLine = line.trim();
          if (!trimmedLine) continue;
          const dataLine = trimmedLine.startsWith('data:') ? trimmedLine.substring(5).trim() : trimmedLine;

          if (dataLine === '[DONE]') {
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            hb.close();
            return;
          }
          if (!dataLine) continue;

          try {
            const siderData = JSON.parse(dataLine);
            if (!siderData.data) {
              // 上游流内错误码检测(顶层 code 非 0)
              if (siderData.code && siderData.code !== 0) {
                emitStreamError(controller, encoder, modelName, siderData.code, siderData.msg);
                hb.close();
                return;
              }
              continue;
            }

            let openAIChunk: any = null;

            switch (siderData.data.type) {
              case "message_start":
                conversationId = siderData.data.message_start.cid || "";
                conversationSessions.set(sessionId, {
                  cid: conversationId,
                  parent_message_id: siderData.data.message_start.assistant_message_id || "",
                  created_at: conversationSessions.get(sessionId)?.created_at || Date.now(),
                  last_used: Date.now()
                });
                break;
              case "text":
                if (firstChunkAt === null) {
                  firstChunkAt = Date.now();
                  console.log("⏱️ TTFT(ms):", firstChunkAt - streamT0);
                }
                openAIChunk = buildDeltaChunk(modelName, { content: siderData.data.text });
                break;
              case "reasoning_content": {
                const rc = siderData.data.reasoning_content;
                const reasoningText = (typeof rc === "object" && rc !== null && "text" in rc)
                  ? (rc as Record<string, unknown>).text as string : "";
                if (reasoningText) {
                  if (firstChunkAt === null) firstChunkAt = Date.now();
                  openAIChunk = buildDeltaChunk(modelName, { reasoning_content: reasoningText });
                }
                break;
              }
              case "pulse":
              case "credit_info":
                break;
            }

            // 上游流内错误码检测(SSE 顶层 code 非 0, 如 1135 限流)
            if (siderData.code && siderData.code !== 0) {
              emitStreamError(controller, encoder, modelName, siderData.code, siderData.msg);
              hb.close();
              return;
            }

            if (openAIChunk) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(openAIChunk)}\n\n`));
            }
          } catch {
            console.warn("⚠️ 解析流式数据失败");
          }
        }

        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
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

// 构造 OpenAI 流式 delta chunk
function buildDeltaChunk(modelName: string, delta: Record<string, unknown>) {
  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: modelName,
    choices: [{ delta, finish_reason: null, index: 0 }]
  };
}

// 流内错误 → 发错误块 + [DONE]
function emitStreamError(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  modelName: string,
  code: number,
  msg: string
) {
  console.error(`❌ 上游流内错误: code=${code} msg=${msg}`);
  const errChunk = {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: modelName,
    choices: [{ delta: {}, finish_reason: "error", index: 0 }],
    error: { code, message: msg || "" }
  };
  controller.enqueue(encoder.encode(`data: ${JSON.stringify(errChunk)}\n\n`));
  controller.enqueue(encoder.encode("data: [DONE]\n\n"));
}

// ==================== 多协议上下文拼接 ====================

// 三协议(Gemini/Anthropic/Responses)通用的历史拼接。
// 统一复用 OpenAI 路径已验证的 buildFullContext(结构化 [System]/[Current Question]/[Conversation History]),
// 比简单 join 更能让模型聚焦当前问题, 并共享字符/词数预算截断。
function joinMessagesContext(messages: any[], prompt: string): string {
  return messages.length > 1 ? buildFullContext(messages) : prompt;
}

// 三协议通用的上游请求发送(始终流式读上游, 带超时)。失败抛出 Response 由各处理器兜底。
async function callSiderUpstream(siderModel: string, isThink: boolean, prompt: string, fullContext: string): Promise<Response> {
  const siderRequest = JSON.parse(JSON.stringify(DEFAULT_REQUEST_TEMPLATE));
  siderRequest.model = siderModel;
  siderRequest.stream = true; // 始终流式读上游
  siderRequest.think_mode = { enable: isThink };
  siderRequest.multi_content = [{ type: "text", text: fullContext, user_input_text: fullContext }];
  const enableSearch = shouldEnableAutoSearch(prompt);
  siderRequest.tools = { auto: enableSearch ? ["search", "data_analysis"] : ["data_analysis"] };

  const upstreamController = new AbortController();
  const upstreamTimeout = setTimeout(() => upstreamController.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    return await fetch(SIDER_API_ENDPOINT, {
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
  } finally {
    clearTimeout(upstreamTimeout);
  }
}

// 消费上游流, 聚合 text 与 reasoning_content(非流式各协议共用)。
async function drainUpstream(siderResponse: Response): Promise<{ fullText: string; reasoning: string }> {
  let fullText = "", reasoning = "";
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
          reasoning += (rc as Record<string, unknown>).text as string || "";
        }
      }
    } catch { /* skip */ }
  }
  return { fullText, reasoning };
}

// ==================== Gemini 格式处理 ====================

// Gemini contents[] → messages[] 入站适配
function geminiToMessages(body: any): { messages: any[] } {
  const messages: any[] = [];
  if (body.systemInstruction && body.systemInstruction.parts) {
    const text = body.systemInstruction.parts.map((p: any) => p.text || "").join("\n");
    if (text) messages.push({ role: "system", content: text });
  }
  for (const c of (body.contents || [])) {
    const role = c.role === "model" ? "assistant" : (c.role || "user");
    const parts = c.parts || [];
    const textParts: string[] = [];
    for (const p of parts) {
      if (p.text !== undefined) textParts.push(p.text);
    }
    messages.push({ role, content: textParts.join("\n") });
  }
  return { messages };
}

// Gemini 非流式响应构建
function buildGeminiResponse(content: string, reasoning: string, finishReason = "STOP"): any {
  const resp: any = {
    candidates: [{
      content: { role: "model", parts: [{ text: content || "" }] },
      finishReason,
      index: 0,
    }],
    usageMetadata: {
      promptTokenCount: 0,
      candidatesTokenCount: content.length,
      totalTokenCount: content.length,
    },
  };
  if (reasoning) resp.candidates[0].thought = reasoning;
  return resp;
}

async function handleGeminiGenerate(req: Request, geminiModel: string, isStream: boolean): Promise<Response> {
  try {
    const body = await req.json();
    console.log(`📥 Gemini ${isStream ? "stream" : "generate"}: model=${geminiModel}`);
    const { messages } = geminiToMessages(body);

    // 能力门控: Gemini inline_data/file_data(图像) → not_supported
    const geminiHasVision = (body.contents || []).some((c: any) =>
      Array.isArray(c?.parts) && c.parts.some((p: any) =>
        p && (p.inline_data || p.inlineData || p.file_data || p.fileData)));
    if (geminiHasVision) {
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
    const fullContext = joinMessagesContext(messages, prompt);

    const siderResponse = await callSiderUpstream(siderModel, isThink, prompt, fullContext);
    if (!siderResponse.ok) {
      const errorText = await siderResponse.text();
      console.error("❌ Gemini上游错误:", errorText);
      return new Response(JSON.stringify({
        error: { message: `上游错误: ${siderResponse.status}`, type: "upstream_error" }
      }), { status: 502, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
    }

    // 非流式
    if (!isStream) {
      const { fullText, reasoning } = await drainUpstream(siderResponse);
      return new Response(JSON.stringify(buildGeminiResponse(fullText || "生成完成", reasoning)), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    // 流式
    const stream = new ReadableStream({
      async start(controller) {
        const reader = siderResponse.body?.getReader();
        if (!reader) { controller.error(new Error("无法获取响应流")); return; }
        const lineReader = new SSELineReader();
        const encoder = new TextEncoder();
        const hb = createSSEHeartbeat(controller, encoder, COMMENT_PING_FRAME);
        try {
          for await (const line of lineReader.readLines(reader)) {
            const tl = line.trim();
            if (!tl) continue;
            const dl = tl.startsWith("data:") ? tl.substring(5).trim() : tl;
            if (dl === "[DONE]") {
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              hb.close();
              return;
            }
            if (!dl) continue;
            try {
              const sd = JSON.parse(dl);
              if (sd.code && sd.code !== 0) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { code: sd.code, message: sd.msg || "" } })}\n\n`));
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                hb.close();
                return;
              }
              const d = sd.data;
              if (!d) continue;
              let geminiChunk: any = null;
              if (d.type === "text" && d.text) {
                geminiChunk = { candidates: [{ content: { role: "model", parts: [{ text: d.text }] }, index: 0 }] };
              } else if (d.type === "reasoning_content") {
                const rc = d.reasoning_content;
                const rt = (typeof rc === "object" && rc !== null && "text" in rc) ? (rc as Record<string, unknown>).text as string : "";
                if (rt) geminiChunk = { candidates: [{ content: { role: "model", parts: [] }, thought: rt, index: 0 }] };
              }
              if (geminiChunk) controller.enqueue(encoder.encode(`data: ${JSON.stringify(geminiChunk)}\n\n`));
            } catch { /* skip */ }
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
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
        "Cache-Control": "no-cache", "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*"
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

// Anthropic Messages API 入站适配: system(string/数组) + messages[] → 内部 messages[]
function anthropicToMessages(body: any): { messages: any[] } {
  const messages: any[] = [];
  const sys = body.system;
  if (typeof sys === "string" && sys.trim()) {
    messages.push({ role: "system", content: sys });
  } else if (Array.isArray(sys)) {
    const text = sys.map((s: any) => s.text || "").join("\n");
    if (text.trim()) messages.push({ role: "system", content: text });
  }
  for (const m of (body.messages || [])) {
    const role = m.role === "assistant" ? "assistant" : "user";
    let content = "";
    if (typeof m.content === "string") {
      content = m.content;
    } else if (Array.isArray(m.content)) {
      content = m.content.filter((b: any) => b.type === "text").map((b: any) => b.text || "").join("\n");
    }
    messages.push({ role, content });
  }
  return { messages };
}

// Anthropic 非流式响应构建
function buildAnthropicResponse(id: string, content: string, modelName: string, reasoning: string, stopReason = "end_turn"): any {
  const resp: any = {
    id, type: "message", role: "assistant", model: modelName,
    content: [{ type: "text", text: content }],
    stop_reason: stopReason,
  };
  if (reasoning) resp.content.unshift({ type: "thinking", thinking: reasoning });
  resp.usage = { input_tokens: 0, output_tokens: content.length };
  return resp;
}

async function handleAnthropicMessage(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const isStream = body.stream === true;
    console.log(`📥 Anthropic ${isStream ? "stream" : "message"}: model=${body.model}`);
    const { messages } = anthropicToMessages(body);

    // 能力门控: Anthropic content 块含 image/source → not_supported
    const anthroHasVision = (body.messages || []).some((m: any) =>
      Array.isArray(m?.content) && m.content.some((b: any) => b && (b.type === "image" || b.source)));
    if (anthroHasVision) {
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
    const fullContext = joinMessagesContext(messages, prompt);

    const siderResp = await callSiderUpstream(siderModel, isThink, prompt, fullContext);
    if (!siderResp.ok) {
      const errorText = await siderResp.text();
      console.error("❌ Anthropic上游错误:", errorText);
      return new Response(JSON.stringify({
        type: "error", error: { type: "api_error", message: `上游错误: ${siderResp.status}` },
      }), { status: 502, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
    }

    // 非流式
    if (!isStream) {
      const { fullText, reasoning } = await drainUpstream(siderResp);
      const resp = buildAnthropicResponse(msgId, fullText || "生成完成", anthroModel, reasoning);
      return new Response(JSON.stringify(resp), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    // 流式: Anthropic SSE content-block 状态机 (惰性开块 + 单调 index + 成对 start/stop)
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

        let started = false;
        let blockIndex = -1;
        let currentBlock: "text" | "thinking" | null = null;
        let outputChars = 0;

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
            content_block: type === "thinking" ? { type: "thinking", thinking: "" } : { type: "text", text: "" },
          });
        };
        const finishOk = () => {
          ensureStart();
          closeBlock();
          sendEvent("message_delta", {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: Math.max(1, Math.ceil(outputChars / 4)) },
          });
          sendEvent("message_stop", { type: "message_stop" });
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
                sendEvent("error", { type: "error", error: { type: "api_error", message: sd.msg || `code=${sd.code}` } });
                sendEvent("message_stop", { type: "message_stop" });
                hb.close();
                return;
              }
              const d = sd.data;
              if (!d) continue;
              if (d.type === "text" && d.text) {
                if (currentBlock !== "text") openBlock("text");
                outputChars += d.text.length;
                sendEvent("content_block_delta", {
                  type: "content_block_delta", index: blockIndex,
                  delta: { type: "text_delta", text: d.text },
                });
              } else if (d.type === "reasoning_content") {
                const rc = d.reasoning_content;
                const rt = (typeof rc === "object" && rc !== null && "text" in rc) ? (rc as Record<string, unknown>).text as string : "";
                if (rt) {
                  if (currentBlock !== "thinking") openBlock("thinking");
                  sendEvent("content_block_delta", {
                    type: "content_block_delta", index: blockIndex,
                    delta: { type: "thinking_delta", thinking: rt },
                  });
                }
              }
            } catch { /* skip */ }
          }
          finishOk();
        } catch (err: any) {
          console.error("❌ Anthropic流错误:", err);
          if (!hb.closed) {
            closeBlock();
            sendEvent("error", { type: "error", error: { type: "api_error", message: err?.message || "stream error" } });
            sendEvent("message_stop", { type: "message_stop" });
          }
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
      type: "error", error: { type: "api_error", message: `处理请求失败: ${error.message}` },
    }), { status: 500, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
  }
}

// ==================== OpenAI Responses API 格式处理 ====================

// Responses API 入站适配: instructions + input(string/数组) → messages[]
function responsesToMessages(body: any): { messages: any[]; prompt: string } {
  const messages: any[] = [];
  if (body.instructions && typeof body.instructions === "string" && body.instructions.trim()) {
    messages.push({ role: "system", content: body.instructions });
  }
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
        content = m.content.filter((b: any) => b.type === "text").map((b: any) => b.text || "").join("\n");
      }
      messages.push({ role, content });
    }
  }
  const lastContent = messages[messages.length - 1]?.content;
  const prompt = typeof lastContent === "string" ? lastContent : "";
  return { messages, prompt };
}

// Responses API 非流式响应构建
function buildResponsesResponse(id: string, content: string, modelName: string, reasoning: string): any {
  const output: any[] = [];
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
    id, object: "response", model: modelName, output,
    usage: { input_tokens: 0, output_tokens: content.length, total_tokens: content.length },
  };
}

async function handleOpenAIResponse(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const isStream = body.stream === true;
    console.log(`📥 Responses ${isStream ? "stream" : "nonstream"}: model=${body.model}`);
    const { messages, prompt } = responsesToMessages(body);

    // 能力门控: Responses input_image → not_supported
    const respHasVision = Array.isArray(body.input) && body.input.some((m: any) =>
      Array.isArray(m?.content) && m.content.some((b: any) =>
        b && (b.type === "input_image" || b.type === "image_url" || b.image_url)));
    if (respHasVision) {
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
    const fullContext = joinMessagesContext(messages, prompt);

    const siderResp = await callSiderUpstream(siderModel, isThink, prompt, fullContext);
    if (!siderResp.ok) {
      return new Response(JSON.stringify({
        error: { message: `上游错误: ${siderResp.status}`, type: "api_error" },
      }), { status: 502, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
    }

    // 非流式
    if (!isStream) {
      const { fullText, reasoning } = await drainUpstream(siderResp);
      const respData = buildResponsesResponse(respId, fullText || "生成完成", modelName, reasoning);
      return new Response(JSON.stringify(respData), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    // 流式: Responses API SSE
    const respStream = new ReadableStream({
      async start(controller) {
        const reader = siderResp.body?.getReader();
        if (!reader) { controller.error(new Error("无响应流")); return; }
        const lineReader = new SSELineReader();
        const encoder = new TextEncoder();
        const hb = createSSEHeartbeat(controller, encoder, COMMENT_PING_FRAME);

        const sendEvent = (event: string, data: any) => {
          if (hb.closed) return;
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        };

        const initialResp: any = { object: "response", id: respId, model: modelName, output: [], status: "in_progress" };
        sendEvent("response.created", { type: "response.created", response: initialResp });
        sendEvent("response.output_text.delta", { type: "response.output_text.delta", delta: "" });

        try {
          for await (const line of lineReader.readLines(reader)) {
            const tl = line.trim();
            if (!tl) continue;
            const dl = tl.startsWith("data:") ? tl.substring(5).trim() : tl;
            if (dl === "[DONE]") {
              const completedResp = {
                ...initialResp, status: "completed",
                output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "" }] }],
                usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
              };
              sendEvent("response.completed", { type: "response.completed", response: completedResp });
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              hb.close();
              return;
            }
            if (!dl) continue;
            try {
              const sd = JSON.parse(dl);
              if (sd.code && sd.code !== 0) {
                sendEvent("error", { type: "error", error: { type: "api_error", message: sd.msg || `code=${sd.code}` } });
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                hb.close();
                return;
              }
              const d = sd.data;
              if (!d) continue;
              if (d.type === "text" && d.text) {
                sendEvent("response.output_text.delta", {
                  type: "response.output_text.delta",
                  item_id: respId, output_index: 0, content_index: 0, delta: d.text,
                });
              }
            } catch { /* skip */ }
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          hb.close();
        } catch (err: any) {
          console.error("❌ Responses流错误:", err);
          hb.fail(err);
        }
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

// ==================== 静态处理器 ====================

function indexHandler(): Response {
  return new Response("🚀 Sider2API服务已启动！", {
    headers: { "Content-Type": "text/html; charset=utf-8", "Access-Control-Allow-Origin": "*" }
  });
}

function handleModelsList(): Response {
  return new Response(JSON.stringify({ object: "list", data: MODELS }), {
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
  });
}

function notFound(): Response {
  return new Response(JSON.stringify({
    error: { message: "Not Found", type: "invalid_request_error" }
  }), {
    status: 404,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
  });
}

// ==================== 路由 ====================

async function handleRequest(req: Request): Promise<Response> {
  const { pathname } = new URL(req.url);

  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Session-ID"
      }
    });
  }

  if (req.method === "GET" && pathname === "/") {
    return indexHandler();
  }

  if (req.method === "GET" && pathname === "/v1/models") {
    return handleModelsList();
  }

  if (req.method === "POST" && pathname === "/v1/chat/completions") {
    return authMiddleware(handleChatCompletion)(req);
  }

  // Gemini 端点: /v1beta/models/{model}:generateContent | :streamGenerateContent
  const geminiMatch = pathname.match(/^\/v1beta\/models\/(.+):(generateContent|streamGenerateContent)$/);
  if (req.method === "POST" && geminiMatch) {
    const geminiModel = geminiMatch[1];
    const isStream = geminiMatch[2] === "streamGenerateContent";
    return authMiddleware((r: Request) => handleGeminiGenerate(r, geminiModel, isStream))(req);
  }

  // Anthropic Messages API 端点
  if (req.method === "POST" && pathname === "/v1/messages") {
    return authMiddleware(handleAnthropicMessage)(req);
  }

  // OpenAI Responses API 端点
  if (req.method === "POST" && pathname === "/v1/responses") {
    return authMiddleware(handleOpenAIResponse)(req);
  }

  return notFound();
}

// ==================== 启动 ====================

console.log("🚀 启动 Sider2API 代理服务器...");
console.log("🤖 支持的模型:", Object.keys(MODEL_MAPPING).length, "个");
console.log("🔌 协议: OpenAI Chat/Responses · Gemini · Anthropic");
console.log("💡 流式响应: ✅  会话管理: ✅  能力门控: ✅  心跳保活: ✅");

const PORT = parseInt(Deno.env.get("PORT") || "8000");
Deno.serve({
  port: PORT,
  hostname: "0.0.0.0",
  onListen({ port, hostname }) {
    console.log(`📍 监听地址: http://${hostname}:${port}`);
  }
}, handleRequest);
