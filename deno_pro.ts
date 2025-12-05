import { serve } from "https://deno.land/std@0.200.0/http/server.ts";

// ==================== 配置常量 ====================

const SIDER_API_ENDPOINT = "https://sider.ai/api/chat/v1/completions";

// 从环境变量获取 Token,如果没有则使用默认值(仅用于测试)
const SIDER_AUTH_TOKEN = Deno.env.get("SIDER_AUTH_TOKEN") 
// 服务端 API 认证 Token(可选)
const AUTH_TOKEN = Deno.env.get("AUTH_TOKEN");

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

  // Claude 系列
  "claude-opus-4.5": "claude-opus-4.5",
  "claude-opus-4.5-think": "claude-opus-4.5-think",
  "claude-4.5-sonnet": "claude-4.5-sonnet",
  "claude-4.5-sonnet-think": "claude-4.5-sonnet-think",
  "claude-haiku-4.5": "claude-haiku-4.5",
  "claude-haiku-4.5-think": "claude-haiku-4.5-think",

  // Gemini 系列
  "gemini-2.5-pro": "gemini-2.5-pro",
  "gemini-2.5-flash": "gemini-2.5-flash",
  "gemini-2.5-pro-think": "gemini-2.5-pro-think",
  "gemini-2.5-flash-think": "gemini-2.5-flash-think",
  "gemini-3.0-pro": "gemini-3.0-pro",
  "gemini-3.0-pro-think": "gemini-3.0-pro-think",

  // DeepSeek 系列
  "deepseek-v3.1": "deepseek-v3.1",
  "deepseek-v3.1-think": "deepseek-v3.1-think",
  "deepseek-reasoner": "deepseek-reasoner",

  // 其他模型
  "grok-4": "grok-4",
  "kimi-k2": "kimi-k2",
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
function detectImageQuality(prompt: string): string {
  if (/4k|高清|ultra|hd|高质量/i.test(prompt)) return "nano_banana_pro";
  if (/快速|draft|sketch/i.test(prompt)) return "nano_banana_lite";
  return "nano_banana"; // 默认标准质量
}

// 检测是否启用 Think 模式
function shouldEnableThinkMode(modelName: string): boolean {
  return modelName.includes("-think");
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
    const userPrompt = lastMessage?.content || "";

    // 获取或创建会话ID(从请求头或生成新的)
    const sessionId = req.headers.get("X-Session-ID") || `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    let session = conversationSessions.get(sessionId);

    // 构建 Sider 请求
    const siderRequest = JSON.parse(JSON.stringify(DEFAULT_REQUEST_TEMPLATE));

    // 判断是否为图像生成请求
    const isImageGen = isImageGenerationRequest(userPrompt);

    // 检查是否启用 Think 模式
    const enableThink = shouldEnableThinkMode(modelName);

    // 设置 multi_content(所有请求都需要)
    siderRequest.multi_content = [{
      type: "text",
      text: userPrompt,
      user_input_text: userPrompt
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
      siderRequest.tools = {
        auto: ["search", "data_analysis"]
      };
    }

    console.log("🚀 发送到 Sider:", {
      model: siderRequest.model,
      isImage: isImageGen,
      thinkMode: enableThink,
      sessionId: sessionId,
      hasCid: !!siderRequest.cid
    });

    // 发送请求
    const siderResponse = await fetch(SIDER_API_ENDPOINT, {
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
    });

    if (!siderResponse.ok) {
      const errorText = await siderResponse.text();
      console.error("❌ Sider API 错误响应:", errorText);
      throw new Error(`Sider API 错误: ${siderResponse.status} - ${errorText}`);
    }

    console.log("✅ Sider 响应状态:", siderResponse.status);

    // 非流式响应
    if (!isStreaming) {
      return await handleNonStreamingResponse(siderResponse, modelName, userPrompt, isImageGen, sessionId);
    }

    // 流式响应
    return handleStreamingResponse(siderResponse, modelName, isImageGen, sessionId);

  } catch (error) {
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
  sessionId: string
): Promise<Response> {
  let fullText = "";
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

  if (isImageGen && imageUrl) {
    content = `![生成的图像](${imageUrl})\n\n${fullText}`;
  }

  const openAIResponse = {
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

  if (imageData) {
    (openAIResponse as any).image_data = imageData;
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
      let hasStarted = false;

      try {
        for await (const line of lineReader.readLines(reader)) {
          const trimmedLine = line.trim();
          if (!trimmedLine) continue;

          const dataLine = trimmedLine.startsWith('data:')
            ? trimmedLine.substring(5).trim()
            : trimmedLine;

          if (dataLine === '[DONE]') {
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
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
                  console.log("🖼️ 流式收到图像:", siderData.data.file.url);
                  openAIChunk = {
                    id: `chatcmpl-${Date.now()}`,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model: modelName,
                    choices: [{
                      delta: {
                        content: `\n![生成的图像](${siderData.data.file.url})\n`
                      },
                      finish_reason: null,
                      index: 0
                    }]
                  };
                }
                break;

              case "tool_call":
                console.log("🔧 工具调用状态:", siderData.data.tool_call.status);
                break;

              case "pulse":
                // 心跳,忽略
                break;

              case "credit_info":
                console.log("💳 额度信息:", siderData.data.credit_info);
                break;
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
        controller.close();

      } catch (error) {
        console.error("❌ 流式处理错误:", error);
        controller.error(error);
      }
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
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
    siderRequest.tools = {
      image: {
        quality_level: quality === "hd" ? "nano_banana_pro" : "nano_banana"
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

    const siderResponse = await fetch(SIDER_API_ENDPOINT, {
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
    });

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

  } catch (error) {
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

console.log("🚀 启动 Sider2API 集成代理服务器...");
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

// 加载自定义模型
await loadCustomModels();

serve(handleRequest, { port: 8000 });
