// # Sider API 配置  
// # -------------------  
// 
// # SOCKS 代理设置  
// # 设置为 1 或 true 表示启用 SOCKS 代理  
// USE_SOCKS=1  
// # SOCKS 代理服务器地址  
// SOCKS_PROXY=socks.xxx.net:3128  
// 
// # Sider 认证设置  
// # 如果需要使用自己的 Token，取消下面的注释并填入  
// # SIDER_AUTH_TOKEN=your_sider_token_here  
// 
// # 服务器监听设置  
// # 默认为 127.0.0.1:7055，如需改变监听地址，取消下面注释  
// # LISTEN_ADDR=0.0.0.0:7055 


package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	"golang.org/x/net/proxy"
)

// 加载.env文件
func loadEnv() {
	envFile := ".env"
	file, err := os.Open(envFile)
	if err != nil {
		// 如果文件不存在，静默忽略
		if os.IsNotExist(err) {
			return
		}
		fmt.Printf("警告: 无法打开.env文件: %v\n", err)
		return
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := scanner.Text()
		// 跳过空行和注释
		if len(line) == 0 || strings.HasPrefix(line, "#") {
			continue
		}

		// 解析KEY=VALUE格式
		parts := strings.SplitN(line, "=", 2)
		if len(parts) != 2 {
			continue
		}

		key := strings.TrimSpace(parts[0])
		value := strings.TrimSpace(parts[1])

		// 如果值被引号包围，去掉引号
		if len(value) >= 2 && (value[0] == '"' && value[len(value)-1] == '"' || 
			value[0] == '\'' && value[len(value)-1] == '\'') {
			value = value[1 : len(value)-1]
		}

		// 设置环境变量
		os.Setenv(key, value)
	}

	if err := scanner.Err(); err != nil {
		fmt.Printf("警告: 读取.env文件出错: %v\n", err)
	}
}

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

// 获取HTTP客户端（普通或SOCKS代理）
func getHttpClient() *http.Client {
	// 从环境变量获取SOCKS代理配置
	useSocks := os.Getenv("USE_SOCKS") == "1" || os.Getenv("USE_SOCKS") == "true"
	socksProxy := os.Getenv("SOCKS_PROXY")
	
	// 如果没有配置代理地址，使用默认值
	if socksProxy == "" {
		socksProxy = "127.0.0.1:1080"
	}
	
	// 如果不使用SOCKS代理，返回普通客户端
	if !useSocks {
		return &http.Client{
			Timeout: 60 * time.Second,
		}
	}
	
	fmt.Printf("使用SOCKS代理: %s\n", socksProxy)
	
	// 创建SOCKS5拨号器
	dialer, err := proxy.SOCKS5("tcp", socksProxy, nil, proxy.Direct)
	if err != nil {
		fmt.Printf("创建SOCKS5代理失败: %v，将使用直连\n", err)
		return &http.Client{
			Timeout: 60 * time.Second,
		}
	}
	
	// 创建自定义Transport
	httpTransport := &http.Transport{
		Dial: dialer.Dial,
	}
	
	// 返回使用SOCKS代理的客户端
	return &http.Client{
		Transport: httpTransport,
		Timeout: 60 * time.Second,
	}
}

func handleOptions(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
	w.WriteHeader(http.StatusOK)
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

	// 创建转发到Sider的请求
	url := "https://api2.sider.ai/api/v3/completion/text"
	req, err := http.NewRequest("POST", url, bytes.NewBuffer(finalBody))
	if err != nil {
		fmt.Printf("创建Sider请求失败: %v\n", err)
		http.Error(w, "创建请求失败", http.StatusInternalServerError)
		return
	}

	// 设置请求头
	req.Header.Set("accept", "*/*")
	req.Header.Set("accept-language", "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6")
	
	// 从环境变量获取认证Token
	authToken := os.Getenv("SIDER_AUTH_TOKEN")
	if authToken == "" {
		authToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VyX2lkIjoxMDQ3ODEyNywicmVnaXN0ZXJfdHlwZSI6Im9hdXRoMiIsImFwcF9uYW1lIjoiQ2hpdENoYXRfRWRnZV9FeHQiLCJ0b2tlbl9pZCI6IjMyMTRiMDc0LTU2MTMtNDI1ZC04YjM2LTQzNGU4YjBjYjRkOSIsImlzcyI6InNpZGVyLmFpIiwiYXVkIjpbIiJdLCJleHAiOjE3NTA0NzIxMTEsIm5iZiI6MTcxOTM2ODExMSwiaWF0IjoxNzE5MzY4MTExfQ.glb9636RPBhoL0v3F0YzGPKoRaVv4FmTeDW-Swk-JWA"
	}
	req.Header.Set("authorization", "Bearer "+authToken)
	
	req.Header.Set("content-type", "application/json")
	req.Header.Set("origin", "chrome-extension://dhoenijjpgpeimemopealfcbiecgceod")
	req.Header.Set("user-agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0")

	// 使用普通或SOCKS代理客户端
	client := getHttpClient()
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
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.
