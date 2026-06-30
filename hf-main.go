package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// UserRequest, Message, SiderResponse, OpenAIResponse, OpenAIStreamResponse structs remain the same...

type UserRequest struct {
	Messages  []Message `json:"messages"`
	Model     string    `json:"model"`
	Stream    bool      `json:"stream"`
	MaxTokens int       `json:"max_tokens"`
}

type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

var defaultJsonTemplate = []byte(`{
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
}`)

// Sider响应结构
type SiderResponse struct {
	Code int    `json:"code"`
	Msg  string `json:"msg"`
	Data struct {
		Type      string `json:"type"`
		Text      string `json:"text"`
		ChatModel string `json:"chat_model"`
	} `json:"data"`
}

// OpenAI响应结构
type OpenAIResponse struct {
	ID      string `json:"id"`
	Object  string `json:"object"`
	Created int64  `json:"created"`
	Model   string `json:"model"`
	Choices []struct {
		Message struct {
			Role    string `json:"role"`
			Content string `json:"content"`
		} `json:"message"`
		FinishReason string `json:"finish_reason"`
		Index        int    `json:"index"`
	} `json:"choices"`
	Usage struct {
		PromptTokens     int `json:"prompt_tokens"`
		CompletionTokens int `json:"completion_tokens"`
		TotalTokens      int `json:"total_tokens"`
	} `json:"usage"`
}

// OpenAI流式响应结构
type OpenAIStreamResponse struct {
	ID      string `json:"id"`
	Object  string `json:"object"`
	Created int64  `json:"created"`
	Model   string `json:"model"`
	Choices []struct {
		Delta struct {
			Content string `json:"content"`
		} `json:"delta"`
		FinishReason string `json:"finish_reason"`
		Index        int    `json:"index"`
	} `json:"choices"`
}

func handleOptions(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
	w.WriteHeader(http.StatusOK)
}

// authMiddleware 认证中间件
func authMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		authToken := os.Getenv("AUTH_TOKEN")
		if authToken == "" {
			http.Error(w, "Authentication token not configured", http.StatusUnauthorized)
			return
		}

		authHeader := r.Header.Get("Authorization")
		if authHeader == "" {
			http.Error(w, "Authorization header is required", http.StatusUnauthorized)
			return
		}

		parts := strings.Split(authHeader, " ")
		if len(parts) != 2 || strings.ToLower(parts[0]) != "bearer" || parts[1] != authToken {
			http.Error(w, "Invalid authorization token", http.StatusUnauthorized)
			return
		}

		next(w, r)
	}
}

func forwardToSider(w http.ResponseWriter, r *http.Request) {
	fmt.Printf("收到新请求: %s %s\n", r.Method, r.URL.Path)

	// 设置CORS头
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")

	// 读取请求体
	body, err := io.ReadAll(r.Body)
	if err != nil {
		fmt.Printf("读取请求体失败: %v\n", err)
		http.Error(w, "读取请求失败", http.StatusBadRequest)
		return
	}
	defer r.Body.Close()

	fmt.Printf("收到请求体: %s\n", string(body))

	// 解析用户请求
	var userReq UserRequest
	if err := json.Unmarshal(body, &userReq); err != nil {
		fmt.Printf("解析请求体失败: %v\n", err)
		http.Error(w, "解析请求失败", http.StatusBadRequest)
		return
	}

	// 解析默认模板
	var defaultConfig map[string]interface{}
	if err := json.Unmarshal(defaultJsonTemplate, &defaultConfig); err != nil {
		fmt.Printf("解析默认配置失败: %v\n", err)
		http.Error(w, "服务器配置错误", http.StatusInternalServerError)
		return
	}

	// 获取用户消息内容
	prompt := "你好" // 默认提示词
	if len(userReq.Messages) > 0 {
		prompt = userReq.Messages[len(userReq.Messages)-1].Content
	}
	fmt.Printf("处理的prompt: %s\n", prompt)

	// 添加prompt到配置中
	defaultConfig["prompt"] = prompt

	// 添加model到配置中
	if userReq.Model != "" {
		defaultConfig["model"] = userReq.Model
	} else {
		defaultConfig["model"] = "gpt-4o" // 默认模型
	}

	// 设置stream参数
	defaultConfig["stream"] = userReq.Stream

	fmt.Printf("使用的模型: %s\n", defaultConfig["model"])

	// 转换回JSON
	finalBody, err := json.Marshal(defaultConfig)
	if err != nil {
		fmt.Printf("生成最终请求体失败: %v\n", err)
		http.Error(w, "处理请求失败", http.StatusInternalServerError)
		return
	}

	fmt.Printf("发送到Sider的请求体: %s\n", string(finalBody))

	// Get Sider API URL from environment variable
	siderAPIURL := os.Getenv("SIDER_API_URL")
	if siderAPIURL == "" {
		siderAPIURL = "https://api2.sider.ai/api/v3/completion/text" // Default value
	}

	// 创建转发到Sider的请求
	req, err := http.NewRequest("POST", siderAPIURL, bytes.NewBuffer(finalBody))
	if err != nil {
		fmt.Printf("创建Sider请求失败: %v\n", err)
		http.Error(w, "创建请求失败", http.StatusInternalServerError)
		return
	}

	// 设置请求头
	req.Header.Set("accept", "*/*")
	req.Header.Set("accept-language", "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6")

	// Get authorization token from environment variable
	authToken := os.Getenv("SIDER_AUTH_TOKEN")
	if authToken == "" {
		fmt.Println("Error: SIDER_AUTH_TOKEN environment variable not set.")
		http.Error(w, "Authorization token not configured", http.StatusUnauthorized)
		return
	}
	req.Header.Set("authorization", "Bearer "+authToken)

	req.Header.Set("content-type", "application/json")
	req.Header.Set("origin", "chrome-extension://dhoenijjpgpeimemopealfcbiecgceod")
	req.Header.Set("user-agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0")

	// 发送请求到Sider
	client := &http.Client{}
	resp, err := client.Do(req)
	if err != nil {
		fmt.Printf("发送到Sider请求失败: %v\n", err)
		http.Error(w, "发送请求失败", http.StatusInternalServerError)
		return
	}
	defer resp.Body.Close()

	fmt.Printf("Sider响应状态码: %d\n", resp.StatusCode)

	if !userReq.Stream {
		// 非流式响应
		w.Header().Set("Content-Type", "application/json")
		fullResponse := ""
		reader := bufio.NewReader(resp.Body)

		for {
			line, err := reader.ReadString('\n')
			if err != nil {
				if err == io.EOF {
					break
				}
				http.Error(w, "读取响应失败", http.StatusInternalServerError)
				return
			}

			line = strings.TrimSpace(line)
			line = strings.TrimPrefix(line, "data:")

			if line == "" || line == "[DONE]" {
				continue
			}

			var siderResp SiderResponse
			if err := json.Unmarshal([]byte(line), &siderResp); err != nil {
				continue
			}

			fullResponse += siderResp.Data.Text
		}

		openAIResp := OpenAIResponse{
			ID:      "chatcmpl-" + time.Now().Format("20060102150405"),
			Object:  "chat.completion",
			Created: time.Now().Unix(),
			Model:   userReq.Model,
			Choices: []struct {
				Message struct {
					Role    string `json:"role"`
					Content string `json:"content"`
				} `json:"message"`
				FinishReason string `json:"finish_reason"`
				Index        int    `json:"index"`
			}{
				{
					Message: struct {
						Role    string `json:"role"`
						Content string `json:"content"`
					}{
						Role:    "assistant",
						Content: fullResponse,
					},
					FinishReason: "stop",
					Index:        0,
				},
			},
			Usage: struct {
				PromptTokens     int `json:"prompt_tokens"`
				CompletionTokens int `json:"completion_tokens"`
				TotalTokens      int `json:"total_tokens"`
			}{
				PromptTokens:     len(prompt),
				CompletionTokens: len(fullResponse),
				TotalTokens:      len(prompt) + len(fullResponse),
			},
		}

		json.NewEncoder(w).Encode(openAIResp)
		return
	}

	// 流式响应
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)

	// 使用bufio.Reader来读取流式响应
	reader := bufio.NewReader(resp.Body)

	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			if err == io.EOF {
				fmt.Println("响应结束")
				break
			}
			fmt.Printf("读取响应失败: %v\n", err)
			return
		}

		// 去除前缀和空白字符
		line = strings.TrimSpace(line)
		line = strings.TrimPrefix(line, "data:")

		// 跳过空行
		if line == "" {
			continue
		}

		// 如果是[DONE]，发送OpenAI格式的[DONE]
		if line == "[DONE]" {
			_, err = w.Write([]byte("data: [DONE]\n\n"))
			if err != nil {
				fmt.Printf("写入DONE失败: %v\n", err)
			}
			w.(http.Flusher).Flush()
			break
		}

		// 解析Sider响应
		var siderResp SiderResponse
		if err := json.Unmarshal([]byte(line), &siderResp); err != nil {
			fmt.Printf("解析Sider响应失败: %v\n", err)
			continue
		}

		// 转换为OpenAI格式
		openAIResp := OpenAIStreamResponse{
			ID:      "chatcmpl-" + siderResp.Data.ChatModel,
			Object:  "chat.completion.chunk",
			Created: time.Now().Unix(),
			Model:   siderResp.Data.ChatModel,
			Choices: []struct {
				Delta struct {
					Content string `json:"content"`
				} `json:"delta"`
				FinishReason string `json:"finish_reason"`
				Index        int    `json:"index"`
			}{
				{
					Delta: struct {
						Content string `json:"content"`
					}{
						Content: siderResp.Data.Text,
					},
					FinishReason: "",
					Index:        0,
				},
			},
		}

		// 转换为JSON
		openAIJSON, err := json.Marshal(openAIResp)
		if err != nil {
			fmt.Printf("转换OpenAI格式失败: %v\n", err)
			continue
		}

		// 发送OpenAI格式的响应
		_, err = w.Write([]byte("data: " + string(openAIJSON) + "\n\n"))
		if err != nil {
			fmt.Printf("写入响应失败: %v\n", err)
			return
		}
		w.(http.Flusher).Flush()
	}
}

func indexHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	fmt.Fprintf(w, "🚀服务已启动！")
}

type Model struct {
	ID string `json:"id"`
	Object string `json:"object"`
	OwnedBy string `json:"owned_by"`
	Permission []string `json:"permission"`
}

type ModelListResponse struct {
	Object string `json:"object"`
	Data []Model `json:"data"`
}

func listModelsHandler(w http.ResponseWriter, r *http.Request) {
    w.Header().Set("Access-Control-Allow-Origin", "*")
    w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
    w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")

    if r.Method == "OPTIONS" {
        w.WriteHeader(http.StatusOK)
        return
    }
    authMiddleware(func(w http.ResponseWriter, r *http.Request){
        models := []Model{
			{ID: "gpt-4o", Object: "model", OwnedBy: "sider", Permission: []string{"read"}},
			{ID: "gpt-4.1", Object: "model", OwnedBy: "sider", Permission: []string{"read"}},
            		{ID: "gpt-4.5", Object: "model", OwnedBy: "sider", Permission: []string{"read"}},
			{ID: "gpt-4.1-mini", Object: "model", OwnedBy: "sider", Permission: []string{"read"}},
			{ID: "claude-3.7-sonnet", Object: "model", OwnedBy: "sider", Permission: []string{"read"}},
			{ID: "claude-4-sonnet", Object: "model", OwnedBy: "sider", Permission: []string{"read"}},
			{ID: "claude-4-sonnet-think", Object: "model", OwnedBy: "sider", Permission: []string{"read"}},
			{ID: "claude-4-opus", Object: "model", OwnedBy: "sider", Permission: []string{"read"}},
			{ID: "claude-4-opus-think", Object: "model", OwnedBy: "sider", Permission: []string{"read"}},
			{ID: "deepseek-reasoner", Object: "model", OwnedBy: "sider", Permission: []string{"read"}},
			{ID: "o1", Object: "model", OwnedBy: "sider", Permission: []string{"read"}},
			{ID: "o3", Object: "model", OwnedBy: "sider", Permission: []string{"read"}},
            		{ID: "o3-mini", Object: "model", OwnedBy: "sider", Permission: []string{"read"}},
			{ID: "o4-mini", Object: "model", OwnedBy: "sider", Permission: []string{"read"}},
			{ID: "llama-3.1-405b", Object: "model", OwnedBy: "sider", Permission: []string{"read"}},
			{ID: "gemini-2.0-pro", Object: "model", OwnedBy: "sider", Permission: []string{"read"}},
			{ID: "gemini-2.5-pro", Object: "model", OwnedBy: "sider", Permission: []string{"read"}},
            		{ID: "gemini-2.5-flash", Object: "model", OwnedBy: "sider", Permission: []string{"read"}},
			{ID: "gemini-2.5-pro-think", Object: "model", OwnedBy: "sider", Permission: []string{"read"}},
            		{ID: "gemini-2.5-flash-think", Object: "model", OwnedBy: "sider", Permission: []string{"read"}},            
        }

        response := ModelListResponse{
            Object: "list",
            Data: models,
        }

        w.Header().Set("Content-Type", "application/json")
        json.NewEncoder(w).Encode(response)
    })(w,r)
}

func main() {
	// 注册路由处理函数
	http.HandleFunc("/", indexHandler) // 添加主页路由

	http.HandleFunc("/hf/v1/chat/completions", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "OPTIONS" {
			handleOptions(w, r)
			return
		}
		// 添加认证中间件
		authMiddleware(forwardToSider)(w, r)
	})

    http.HandleFunc("/hf/v1/models", listModelsHandler)


	fmt.Println("服务已启动！")
	fmt.Println("支持的模型: gpt-4o, claude-3.5-sonnet, claude-3.7-sonnet, deepseek-reasoner，o3-mini，o1,llama-3.1-405b,gemini-2.0-pro,gemini-2.5-pro, gpt-4.1, gpt-4.1-mini")
	// Use 0.0.0.0 to listen on all interfaces
	if err := http.ListenAndServe("0.0.0.0:7055", nil); err != nil {
		fmt.Printf("服务器启动失败: %v\n", err)
	}
}
