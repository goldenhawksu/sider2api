package handler // IMPORTANT: package name is 'handler'

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

// 用户请求的结构
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

func forwardToSider(w http.ResponseWriter, r *http.Request, userStream bool, prompt string, model string) { // Pass userStream, prompt, model as arguments
	fmt.Printf("收到新请求: %s %s\n", r.Method, r.URL.Path)

	// 设置CORS头
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")

	// 解析默认模板
	var defaultConfig map[string]interface{}
	if err := json.Unmarshal(defaultJsonTemplate, &defaultConfig); err != nil {
		fmt.Printf("解析默认配置失败: %v\n", err)
		http.Error(w, "服务器配置错误", http.StatusInternalServerError)
		return
	}

	fmt.Printf("处理的prompt: %s\n", prompt)
	fmt.Printf("使用的模型: %s\n", model)


	// Add prompt, model and stream to config
	defaultConfig["prompt"] = prompt
	defaultConfig["model"] = model
	defaultConfig["stream"] = userStream // Use the passed userStream value


	// 转换回JSON
	finalBody, err := json.Marshal(defaultConfig)
	if err != nil {
		fmt.Printf("生成最终请求体失败: %v\n", err)
		http.Error(w, "处理请求失败", http.StatusInternalServerError)
		return
	}

	fmt.Printf("发送到Sider的请求体: %s\n", string(finalBody))

	// 创建转发到Sider的请求
	url := "https://api2.sider.ai/api/v3/completion/text"
	req, err := http.NewRequest("POST", url, bytes.NewBuffer(finalBody))
	if err != nil {
		fmt.Printf("创建Sider请求失败: %v\n", err)
		http.Error(w, "创建请求失败", http.StatusInternalServerError)
		return
	}

	// 获取环境变量中的 Authorization Key
	authorizationKey := os.Getenv("SIDER_AUTHORIZATION_KEY")
	if authorizationKey == "" {
		fmt.Println("环境变量 SIDER_AUTHORIZATION_KEY 未设置")
		http.Error(w, "服务器配置错误: Authorization Key 未设置", http.StatusInternalServerError)
		return
	}

	// 设置请求头
	req.Header.Set("accept", "*/*")
	req.Header.Set("accept-language", "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6")
	req.Header.Set("authorization", "Bearer "+authorizationKey) // 使用环境变量
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


	if !userStream { // Check the passed userStream argument
		// Non-流式响应
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
			Model:   model, // Use the passed model argument
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

	// 流式响应 - This branch should NOT be reached on Vercel due to forced stream=false
	w.Header().Set("Content-Type", "text/event-stream")
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
			// Conditionally Flush - Keep this for non-Vercel environments if needed
			if flusher, ok := w.(http.Flusher); ok {
				flusher.Flush()
			} else {
				fmt.Println("ResponseWriter does not support Flush (still logged, but should not cause error on Vercel)")
			}
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
			Model:   model, // Use the passed model argument
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
		// Conditionally Flush - Keep this for non-Vercel environments if needed
		if flusher, ok := w.(http.Flusher); ok {
			flusher.Flush()
		} else {
			fmt.Println("ResponseWriter does not support Flush (still logged, but should not cause error on Vercel)")
		}
	}
}

// CompletionsHandler is the exported handler for Vercel
func CompletionsHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method == "OPTIONS" {
		handleOptions(w, r)
		return
	}

	userReq := &UserRequest{}
	bodyBytes, _ := io.ReadAll(r.Body)
	r.Body.Close()
	if err := json.Unmarshal(bodyBytes, userReq); err != nil {
		fmt.Println("Error unmarshaling request body:", err)
		http.Error(w, "Bad Request", http.StatusBadRequest)
		return
	}
	r.Body = io.NopCloser(bytes.NewBuffer(bodyBytes)) // Restore body

	userStream := userReq.Stream // Get user's requested stream value
	prompt := "你好" // default prompt
	if len(userReq.Messages) > 0 {
		prompt = userReq.Messages[len(userReq.Messages)-1].Content
	}
	model := "gpt-4o" // default model
	if userReq.Model != "" {
		model = userReq.Model
	}


	// Detect Vercel and FORCE stream=false
	if os.Getenv("VERCEL") != "" {
		fmt.Println("Vercel environment detected, forcing stream=false")
		userStream = false // Override user's stream request to false
	}


	forwardToSider(w, r, userStream, prompt, model) // Pass userStream, prompt, model as arguments
}


func main() {
	// Vercel will call CompletionsHandler for requests to /v1/chat/completions.
	fmt.Println("Server starting (Vercel managed port)")
}
