
import { serve } from "https://deno.land/std@0.200.0/http/server.ts";

// 默认 JSON 模板
const DEFAULT_JSON_TEMPLATE = {
  "app_name": "ChitChat_Edge_Ext",
  "app_version": "4.40.0",
  "tz_name": "Asia/Shanghai",
  "cid": "",
  "search": false,
  "auto_search": false,
  "filter_search_history": false,
  "from": "chat",
  "group_id": "default",
  "chat_models": [],
  "files": [],
  "prompt_templates": [
    {"key": "artifacts", "attributes": {"lang": "original"}},
    {"key": "thinking_mode", "attributes": {}}
  ],
  "tools": {
    "auto": ["search", "text_to_image", "data_analysis"]
  },
  "extra_info": {
    "origin_url": "chrome-extension://dhoenijjpgpeimemopealfcbiecgceod/standalone.html?from=sidebar",
    "origin_title": "Sider"
  },
  "branch": true
};

// 简化的模型映射配置
const MODEL_MAPPING = {
  "gpt-4o": { 
    endpoint: "https://api2.sider.ai/api/v3/completion/text",
    model: "gpt-4o" 
  },
  "gpt-4.1": { 
    endpoint: "https://api2.sider.ai/api/v3/completion/text",
    model: "gpt-4.1" 
  },
  "gpt-4.5": { 
    endpoint: "https://api2.sider.ai/api/v3/completion/text",
    model: "gpt-4.5" 
  },
  "gpt-4.1-mini": { 
    endpoint: "https://api2.sider.ai/api/v3/completion/text",
    model: "gpt-4.1-mini" 
  },
  "claude-3.7-sonnet": { 
    endpoint: "https://api2.sider.ai/api/v3/completion/text",
    model: "claude-3.7-sonnet" 
  },
  "claude-4-sonnet": { 
    endpoint: "https://api2.sider.ai/api/v3/completion/text",
    model: "claude-4-sonnet" 
  },
  "claude-4-sonnet-think": { 
    endpoint: "https://api2.sider.ai/api/v3/completion/text",
    model: "claude-4-sonnet-think" 
  },
  "claude-4-opus": { 
    endpoint: "https://api2.sider.ai/api/v3/completion/text",
    model: "claude-4-opus" 
  },
  "claude-4-opus-think": { 
    endpoint: "https://api2.sider.ai/api/v3/completion/text",
    model: "claude-4-opus-think" 
  },
  "deepseek-reasoner": { 
    endpoint: "https://api2.sider.ai/api/v3/completion/text",
    model: "deepseek-reasoner" 
  },
  "o1": { 
    endpoint: "https://api2.sider.ai/api/v3/completion/text",
    model: "o1" 
  },
  "o3": { 
    endpoint: "https://api2.sider.ai/api/v3/completion/text",
    model: "o3" 
  },
  "o3-mini": { 
    endpoint: "https://api2.sider.ai/api/v3/completion/text",
    model: "o3-mini" 
  },
  "o4-mini": { 
    endpoint: "https://api2.sider.ai/api/v3/completion/text",
    model: "o4-mini" 
  },
  "llama-3.1-405b": { 
    endpoint: "https://api2.sider.ai/api/v3/completion/text",
    model: "llama-3.1-405b" 
  },
  "gemini-2.0-pro": { 
    endpoint: "https://api2.sider.ai/api/v3/completion/text",
    model: "gemini-2.0-pro" 
  },
  "gemini-2.5-pro": { 
    endpoint: "https://api2.sider.ai/api/v3/completion/text",
    model: "gemini-2.5-pro" 
  },
  "gemini-2.5-flash": { 
    endpoint: "https://api2.sider.ai/api/v3/completion/text",
    model: "gemini-2.5-flash" 
  },
  "gemini-2.5-pro-think": { 
    endpoint: "https://api2.sider.ai/api/v3/completion/text",
    model: "gemini-2.5-pro-think" 
  },
  "gemini-2.5-flash-think": { 
    endpoint: "https://api2.sider.ai/api/v3/completion/text",
    model: "gemini-2.5-flash-think" 
  }
};

// 模型列表
const MODELS = Object.keys(MODEL_MAPPING).map(modelId => ({
  id: modelId,
  object: "model",
  owned_by: "sider",
  permission: ["read"]
}));

// 主页处理器
function indexHandler(): Response {
  return new Response("🚀 Sider2API服务已启动！", {
    headers: { 
      "Content-Type": "text/html; charset=utf-8",
      "Access-Control-Allow-Origin": "*"
    }
  });
}

// 处理模型列表请求
function handleModelsList(): Response {
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

// 认证中间件
function authMiddleware(handler: (req: Request) => Promise<Response>): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    // 从环境变量获取 AUTH_TOKEN
    const AUTH_TOKEN = Deno.env.get("AUTH_TOKEN");

    // 如果未配置 AUTH_TOKEN，允许所有请求（测试用）
    if (!AUTH_TOKEN) {
      console.warn("⚠️ 未配置 AUTH_TOKEN，所有请求将被允许！");
      return handler(req);
    }

    // 获取请求头中的授权信息
    const authHeader = req.headers.get("Authorization");
    
    // 验证授权
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return new Response("Unauthorized: Missing or invalid Authorization header", { 
        status: 401,
        headers: { "Access-Control-Allow-Origin": "*" }
      });
    }

    const token = authHeader.split(" ")[1];
    
    if (token !== AUTH_TOKEN) {
      return new Response("Unauthorized: Invalid token", { 
        status: 401,
        headers: { "Access-Control-Allow-Origin": "*" }
      });
    }

    // 通过验证，执行实际处理器
    return handler(req);
  };
}

// 转发请求到 Sider
async function forwardToSider(req: Request): Promise<Response> {
  try {
    // 读取请求体
    const requestBody = await req.json();
    console.log("收到请求体:", JSON.stringify(requestBody));

    // 确定模型和终端
    const modelName = requestBody.model || "gpt-4o";
    const modelConfig = MODEL_MAPPING[modelName as keyof typeof MODEL_MAPPING] || MODEL_MAPPING["gpt-4o"];

    // 深拷贝默认模板
    const requestTemplate = JSON.parse(JSON.stringify(DEFAULT_JSON_TEMPLATE));

    // 添加模型特定配置
    requestTemplate.model = modelConfig.model;
    requestTemplate.stream = requestBody.stream || false;

    // 设置 prompt
    const lastMessage = requestBody.messages[requestBody.messages.length - 1];
    requestTemplate.prompt = lastMessage.content;

    console.log("发送到 Sider 的请求体:", JSON.stringify(requestTemplate));

    // 获取 Sider API Token
    const SIDER_AUTH_TOKEN = Deno.env.get("SIDER_AUTH_TOKEN");
    if (!SIDER_AUTH_TOKEN) {
      return new Response("Sider authorization token not configured", { status: 401 });
    }

    // 发送请求到 Sider
    const siderResponse = await fetch(modelConfig.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SIDER_AUTH_TOKEN}`,
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"
      },
      body: JSON.stringify(requestTemplate)
    });

    console.log("Sider 响应状态:", siderResponse.status);

    // 如果是非流式响应
    if (!requestBody.stream) {
      const responseText = await siderResponse.text();
      console.log("Sider 响应内容:", responseText);

      const siderResponseData = JSON.parse(responseText);

      // 构造 OpenAI 格式响应
      const openAIResponse = {
        id: `chatcmpl-${Date.now()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: modelName,
        choices: [{
          message: {
            role: "assistant",
            content: siderResponseData.data?.text || "无法获取响应"
          },
          finish_reason: "stop",
          index: 0
        }],
        usage: {
          prompt_tokens: lastMessage.content.length,
          completion_tokens: siderResponseData.data?.text?.length || 0,
          total_tokens: lastMessage.content.length + (siderResponseData.data?.text?.length || 0)
        }
      };

      return new Response(JSON.stringify(openAIResponse), {
        headers: { 
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }

    // 流式响应（如果需要）
    // TODO: 实现流式响应处理
    return new Response("Stream not implemented", { status: 501 });

  } catch (error) {
    console.error("处理请求时发生错误:", error);
    return new Response(`服务器内部错误: ${error.message}`, { 
      status: 500,
      headers: { 
        "Content-Type": "text/plain",
        "Access-Control-Allow-Origin": "*" 
      }
    });
  }
}

// 主处理函数
async function handleRequest(req: Request): Promise<Response> {
  // 处理主页
  if (req.method === "GET" && new URL(req.url).pathname === "/") {
    return indexHandler();
  }

  // 处理跨域预检请求
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization"
      }
    });
  }

  // 处理模型列表请求
  if (req.method === "GET" && new URL(req.url).pathname === "/v1/models") {
    return handleModelsList();
  }

  // 处理聊天请求
  if (req.method === "POST" && new URL(req.url).pathname === "/v1/chat/completions") {
    return authMiddleware(forwardToSider)(req);
  }

  // 不支持的方法
  return new Response("Method Not Allowed", { 
    status: 405,
    headers: { 
      "Allow": "POST, GET, OPTIONS",
      "Access-Control-Allow-Origin": "*"
    }
  });
}

// 启动服务
serve(handleRequest, { port: 8000 });
