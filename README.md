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


