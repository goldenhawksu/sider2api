# Sider2API

一个用 Go 语言编写的现代化 API 服务。

## 项目描述

Sider2API 是一个基于 Go 语言开发的高性能 API 服务框架。该项目旨在提供一个简单、高效、可扩展的 API 开发解决方案。

hf-main.go 用于部署在huggingface上

origin-main.go 用于在linux terminal 里直接启动运行

main.go+vercel.json+go.mod 用于部署在vercel (不建议，对话会被vercel的免费60s限制截断，导致无法正常运行)

deno.ts 用于在deno.com上部署 (deno_stream.ts是未经完全测试的流式响应支持版本)

socks-main.go是在origin-main.go基础上添加了socks代理功能

## 功能特点

- 高性能的 Go 语言实现
- RESTful API 设计
- 简单易用的配置系统
- 完善的错误处理机制
- 内置日志系统

## 安装要求

- Go 1.16 或更高版本
- 其他依赖将通过 Go modules 自动安装

## 快速开始

1. 克隆项目
```bash
git clone https://github.com/goldenhawksu/sider2api.git
cd sider2api
```

2. 安装依赖
```bash
go mod tidy
```

3. 运行服务
```bash
go run main.go
```

4. 退出服务
```bash
ps aux | grep main.go
kill nnn
```

## 配置说明


项目配置文件位于 `config` 目录下，支持以下配置项：

- 服务端口
- 数据库连接
- 日志级别
- 其他自定义配置

AUTH_TOKEN: 用于访问本服务的API Key, 用于填写New-API的新建渠道

SIDER_AUTH_TOKEN: Chrome->F12->应用程序->存储->扩展存储->Sider:ChatGPT侧边栏->本地->“密钥”栏->token


## API 文档
```
const MODEL_MAPPING = {
  "gpt-4o": { 
    endpoint: "https://api2.sider.ai/api/v3/completion/text",
    model: "gpt-4o" 
  },
```

endpoint(?)：Chrome->F12->应用程序->存储->扩展存储->Sider:ChatGPT侧边栏->本地->“密钥”栏-> domainPool

model: Chrome->F12->应用程序->存储->扩展存储->Sider:ChatGPT侧边栏->本地->“密钥”栏-> siderModels -> name


# 模型列表（按创建者归类）

| category | creator | level | name | is_think_model | replaceBy |
|---|---|---|---|---|---|
| 1 | | 1 | slides-agent | 否 | |
| 1 | | 1 | slides-editor | 否 | |
| 1 | | 1 | dalle_3_HD | 否 | |
| 1 | | 1 | ideogram_v2 | 否 | |
| 1 | | 1 | sdxlV1.0 | 否 | |
| 1 | | 1 | flux-pro-1.1 | 否 | |
| 1 | | 1 | flux-pro-1.1-ultra | 否 | |
| 1 | Google | 1 | gemini-2.0-flash | 否 | gemini-2.5-flash |
| 1 | SD | 1 | sd3.5-large | 否 | |
| 1 | anthropic | 1 | claude-3.5-haiku | 否 | |
| 1 | anthropic | 1 | claude-3-haiku | 否 | sider |
| 1 | anthropic | 1 | claude-instant | 否 | |
| 2 | anthropic | 2 | claude-3.7-sonnet | 否 | |
| 2 | anthropic | 2 | claude-4-sonnet | 否 | |
| 3 | anthropic | 2 | claude-3.7-sonnet-think | 是 | |
| 3 | anthropic | 2 | claude-4-sonnet-think | 是 | |
| 3 | anthropic | 2 | claude-4-opus | 否 | |
| 3 | anthropic | 2 | claude-4-opus-think | 是 | |
| 2 | anthropic | 2 | claude-3.5-sonnet | 否 | |
| 2 | anthropic | 2 | claude2 | 否 | |
| 2 | anthropic | 2 | claude-3-sonnet | 否 | |
| 2 | anthropic | 2 | claude-3-opus | 否 | |
| 1 | deepseek | 1 | deepseek-chat | 否 | |
| 1 | deepseek | 1 | deepseek-r1-distill-llama-70b | 否 | sider |
| 3 | deepseek | 2 | deepseek-reasoner | 是 | |
| 1 | google | 1 | gemini-2.5-flash | 否 | |
| 1 | google | 1 | gemini-1.5-flash | 否 | gemini-2.5-flash |
| 1 | google | 1 | gemini-pro | 否 | |
| 2 | google | 2 | gemini-2.5-pro | 否 | |
| 2 | google | 2 | gemini-2.5-flash-think | 是 | |
| 3 | google | 2 | gemini-2.5-pro-think | 是 | |
| 2 | google | 2 | gemini-2.0-pro | 否 | gemini-2.5-pro |
| 2 | google | 2 | gemini-1.5-pro | 否 | gemini-2.5-pro |
| 1 | meta | 1 | llama-3.3-70b | 否 | sider |
| 1 | meta | 1 | llama-3 | 否 | sider |
| 2 | meta | 2 | llama-3.1-405b | 否 | |
| 1 | openai | 1 | gpt-4.1-mini | 否 | |
| 1 | openai | 1 | gpt-4o-mini | 否 | gpt-4.1-mini |
| 1 | openai | 1 | gpt-3.5 | 否 | gpt-4.1-mini |
| 2 | openai | 2 | gpt-4.1 | 否 | |
| 2 | openai | 2 | gpt-4o | 否 | gpt-4.1 |
| 2 | openai | 2 | gpt-4 | 否 | |
| 3 | openai1 | 2 | o4-mini | 是 | |
| 3 | openai1 | 2 | o3 | 是 | |
| 3 | openai1 | 2 | o1 | 否 | o3 |
| 3 | openai1 | 2 | o3-mini | 否 | o4-mini |
| 3 | openai1 | 2 | gpt-4.5 | 否 | |
| 3 | openai1 | 2 | o1-mini | 否 | o4-mini |
| 1 | sider | 1 | sider | 否 | |



## 贡献指南

欢迎提交 Pull Request 或创建 Issue！

## 许可证

本项目采用 MIT 许可证 - 详见 [LICENSE](LICENSE) 文件

## 联系方式

如有任何问题或建议，请通过 Issue 与我们联系。

## VPS 部署
~~~
#!/bin/bash

# 1. 安装 Deno
echo "安装 Deno..."
curl -fsSL https://deno.land/install.sh | sh
export PATH="$HOME/.deno/bin:$PATH"

# 2. 创建服务目录
mkdir -p /opt/sider2api
cd /opt/sider2api

# 3. 下载您的 Deno 服务代码
# 假设您的代码在 GitHub 上
# git clone https://github.com/goldenhawksu/sider2api.git .
# 或者直接复制代码文件

# 4. 设置环境变量
cat > .env << EOF
SIDER_AUTH_TOKEN=your_sider_token_here
AUTH_TOKEN=your_auth_token_here
PORT=8000
EOF

# 5. 创建 systemd 服务
cat > /etc/systemd/system/sider2api.service << EOF
[Unit]
Description=Sider2API Service
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/sider2api
Environment=SIDER_AUTH_TOKEN=your_sider_token_here
Environment=AUTH_TOKEN=your_auth_token_here
Environment=PORT=8000
ExecStart=/root/.deno/bin/deno run --allow-net --allow-env deno.ts
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

# 6. 启动服务
systemctl daemon-reload
systemctl enable sider2api
systemctl start sider2api

# 7. 检查服务状态
systemctl status sider2api

echo "服务已启动，监听端口 8000"
echo "您可以通过 http://your-vps-ip:8000 访问服务"

