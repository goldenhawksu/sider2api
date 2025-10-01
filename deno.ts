
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
  "gpt-4": { 
    endpoint: "https://api2.sider.ai/api/v3/completion/text",
    model: "gpt-4" 
  },
  "gpt-4.5": { 
    endpoint: "https://api2.sider.ai/api/v3/completion/text",
    model: "gpt-4.5" 
  },
  "gpt-5": { 
    endpoint: "https://api2.sider.ai/api/v3/completion/text",
    model: "gpt-5" 
  },
  "gpt-5-think": { 
    endpoint: "https://api2.sider.ai/api/v3/completion/text",
    model: "gpt-5-think" 
  },
  "gpt-5-mini": { 
    endpoint: "https://api2.sider.ai/api/v3/completion/text",
    model: "gpt-5-mini" 
  },
  "claude-3.5-sonnet": { 
    endpoint: "https://api2.sider.ai/api/v3/completion/text",
    model: "claude-3.5-sonnet" 
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
  "claude-4.1-opus": { 
    endpoint: "https://api2.sider.ai/api/v3/completion/text",
    model: "claude-4.1-opus" 
  },
  "claude-4.1-opus-think": { 
    endpoint: "https://api2.sider.ai/api/v3/completion/text",
    model: "claude-4.1-opus-think" 
  },
  "claude-4.5-sonnet": { 
    endpoint: "https://api2.sider.ai/api/v3/completion/text",
    model: "claude-4.5-sonnet" 
  },
  "claude-4.5-sonnet-think": { 
    endpoint: "https://api2.sider.ai/api/v3/completion/text",
    model: "claude-4.5-sonnet-think" 
  },  
  "deepseek-reasoner": { 
    endpoint: "https://api2.sider.ai/api/v3/completion/text",
    model: "deepseek-reasoner" 
  },
  "deepseek-v3.1": { 
    endpoint: "https://api2.sider.ai/api/v3/completion/text",
    model: "deepseek-v3.1" 
  },
  "deepseek-v3.1-think": { 
    endpoint: "https://api2.sider.ai/api/v3/completion/text",
    model: "deepseek-v3.1-think" 
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
  },
  "grok-4": { 
    endpoint: "https://api2.sider.ai/api/v3/completion/text",
    model: "grok-4" 
  },
  "kimi-k2": { 
    endpoint: "https://api2.sider.ai/api/v3/completion/text",
    model: "kimi-k2" 
  },
  "llama-3.1-405b": { 
    endpoint: "https://api2.sider.ai/api/v3/completion/text",
    model: "llama-3.1-405b" 
  },
  "o1-mini": { 
    endpoint: "https://api2.sider.ai/api/v3/completion/text",
    model: "o1-mini" 
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

// SSE 行读取器
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
    
    // 处理剩余的缓冲区内容
    if (this.buffer) {
      yield this.buffer;
    }
  }
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
    const isStreaming = requestBody.stream || false;

    // 深拷贝默认模板
    const requestTemplate = JSON.parse(JSON.stringify(DEFAULT_JSON_TEMPLATE));

    // 添加模型特定配置
    requestTemplate.model = modelConfig.model;
    requestTemplate.stream = isStreaming;

    // 设置 prompt
    const lastMessage = requestBody.messages[requestBody.messages.length - 1];
    requestTemplate.prompt = lastMessage.content;

    console.log("发送到 Sider 的请求体:", JSON.stringify(requestTemplate));

    // 获取 Sider API Token
    const SIDER_AUTH_TOKEN = Deno.env.get("SIDER_AUTH_TOKEN");
    if (!SIDER_AUTH_TOKEN) {
      return new Response("Sider authorization token not configured", { 
        status: 401,
        headers: { "Access-Control-Allow-Origin": "*" }
      });
    }

    // 发送请求到 Sider
    const siderResponse = await fetch(modelConfig.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SIDER_AUTH_TOKEN}`,
        "Accept": "*/*",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",
        "Origin": "chrome-extension://dhoenijjpgpeimemopealfcbiecgceod",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0"
      },
      body: JSON.stringify(requestTemplate)
    });

    console.log("Sider 响应状态:", siderResponse.status);

    // 非流式响应
    if (!isStreaming) {
      let fullResponse = "";
      const reader = siderResponse.body?.getReader();
      
      if (!reader) {
        throw new Error("无法获取响应流");
      }

      const lineReader = new SSELineReader();
      
      // 逐行读取响应
      for await (const line of lineReader.readLines(reader)) {
        const trimmedLine = line.trim();
        const dataLine = trimmedLine.startsWith('data:') ? trimmedLine.substring(5).trim() : trimmedLine;
        
        if (!dataLine || dataLine === '[DONE]') {
          continue;
        }

        try {
          const siderData = JSON.parse(dataLine);
          if (siderData.data && siderData.data.text) {
            fullResponse += siderData.data.text;
          }
        } catch (parseError) {
          console.warn("解析 Sider 响应失败:", parseError);
          continue;
        }
      }

      // 构造 OpenAI 格式响应
      const openAIResponse = {
        id: `chatcmpl-${Date.now()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: modelName,
        choices: [{
          message: {
            role: "assistant",
            content: fullResponse || "无法获取响应"
          },
          finish_reason: "stop",
          index: 0
        }],
        usage: {
          prompt_tokens: lastMessage.content.length,
          completion_tokens: fullResponse.length,
          total_tokens: lastMessage.content.length + fullResponse.length
        }
      };

      return new Response(JSON.stringify(openAIResponse), {
        headers: { 
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }

    // 流式响应处理
    const stream = new ReadableStream({
      async start(controller) {
        const reader = siderResponse.body?.getReader();
        
        if (!reader) {
          controller.error(new Error("无法获取响应流"));
          return;
        }

        const lineReader = new SSELineReader();
        
        try {
          for await (const line of lineReader.readLines(reader)) {
            const trimmedLine = line.trim();
            const dataLine = trimmedLine.startsWith('data:') ? trimmedLine.substring(5).trim() : trimmedLine;
            
            // 跳过空行
            if (!dataLine) {
              continue;
            }

            // 处理结束信号
            if (dataLine === '[DONE]') {
              controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
              controller.close();
              return;
            }

            try {
              const siderData = JSON.parse(dataLine);
              
              if (siderData.data && siderData.data.text) {
                // 转换为 OpenAI 流式响应格式
                const openAIStreamResponse = {
                  id: `chatcmpl-${siderData.data.chat_model || modelName}`,
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model: siderData.data.chat_model || modelName,
                  choices: [{
                    delta: {
                      content: siderData.data.text
                    },
                    finish_reason: null,
                    index: 0
                  }]
                };

                const chunk = `data: ${JSON.stringify(openAIStreamResponse)}\n\n`;
                controller.enqueue(new TextEncoder().encode(chunk));
              }
            } catch (parseError) {
              console.warn("解析 Sider 流式响应失败:", parseError);
              continue;
            }
          }
        } catch (error) {
          console.error("流式响应处理错误:", error);
          controller.error(error);
        }
      }
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*"
      }
    });

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
console.log("🚀 启动 Sider2API 代理服务器...");
console.log("📍 监听端口: 8000");
console.log("🔗 主页: http://localhost:8000");
console.log("🤖 支持的模型:", Object.keys(MODEL_MAPPING).join(", "));
console.log("💡 流式响应: ✅ 已支持");

serve(handleRequest, { port: 8000 });
