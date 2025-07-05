# Sider2API

一个用 Go 语言编写的现代化 API 服务。

## 项目描述

Sider2API 是一个基于 Go 语言开发的高性能 API 服务框架。该项目旨在提供一个简单、高效、可扩展的 API 开发解决方案。

hf-main.go 用于部署在huggingface上

origin-main.go 用于在linux terminal 里直接启动运行

main.go+vercel.json+go.mod 用于部署在vercel (不建议，对话会被vercel的免费60s限制截断，导致无法正常运行)

deno.ts 用于在deno.com上部署

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

## 贡献指南

欢迎提交 Pull Request 或创建 Issue！

## 许可证

本项目采用 MIT 许可证 - 详见 [LICENSE](LICENSE) 文件

## 联系方式

如有任何问题或建议，请通过 Issue 与我们联系。
