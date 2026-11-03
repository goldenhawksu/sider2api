# Sider2API

一个强大的 Sider.ai API 代理服务,提供 OpenAI 兼容的 API 接口。

## 🎯 项目描述

Sider2API 是一个高性能的 API 代理服务,可将 Sider.ai 的功能转换为 OpenAI 兼容的 API 格式。支持文本对话、图像生成、多轮对话、Think 模式等完整功能。

**推荐版本**: [deno_pro.ts](deno_pro.ts) ⭐ (最新功能,完全支持)

### 版本说明

| 文件 | 用途 | 状态 |
|------|------|------|
| **deno_pro.ts** | 🌟 **推荐** - Deno 完整版,支持图像生成、Web管理界面、认证 | ✅ 生产就绪 |
| deno.ts | Deno 基础版 | ⚠️ 功能受限 |
| hf-main.go | Hugging Face 部署版 | ✅ 可用 |
| origin-main.go | Linux 终端直接运行版 | ✅ 可用 |
| socks-main.go | 带 SOCKS 代理功能版 | ✅ 可用 |
| main.go | Vercel 部署版 | ❌ 不推荐 (60s超时) |

## ✨ 功能特点 (deno_pro.ts)

### 核心功能
- ✅ **文本对话** - 支持流式和非流式响应
- ✅ **图像生成** - 3种方式(自动检测/Chat接口/专用接口)
- ✅ **多轮对话** - Session-ID 会话管理
- ✅ **Think 模式** - 深度思考推理
- ✅ **29+ 模型** - GPT/Claude/Gemini/DeepSeek等

### 管理功能
- ✅ **Web 管理界面** - 直观的模型管理
- ✅ **自定义模型映射** - 动态添加/编辑模型
- ✅ **认证保护** - Bearer Token 认证 🆕
- ✅ **统计面板** - 实时监控服务状态

### 部署支持
- ✅ **本地部署** - 完整功能
- ✅ **Deno Deploy** - 全球边缘网络
- ✅ **Docker** - 容器化部署
- ✅ **VPS** - systemd 服务

## 🚀 快速开始 (deno_pro.ts)

### 1. 安装 Deno

```bash
# macOS/Linux
curl -fsSL https://deno.land/install.sh | sh

# Windows (PowerShell)
irm https://deno.land/install.ps1 | iex
```

### 2. 获取 Token

1. 安装 [Sider Chrome 扩展](https://sider.ai/)
2. 打开浏览器开发者工具 (F12)
3. 导航到:应用程序 → 存储 → 扩展存储 → Sider:ChatGPT侧边栏
4. 复制 `token` 字段的值

### 3. 配置环境变量

```bash
# 必需
export SIDER_AUTH_TOKEN="你的_Sider_Token"

# 必需 - 业务 API 认证；未配置时默认拒绝请求
export AUTH_TOKEN="your-secret-key"
```

### 4. 启动服务

```bash
cd sider2api
deno run --allow-net --allow-env --allow-read --allow-write deno_pro.ts
```

### 5. 访问服务

- **API 端点**: http://localhost:8000
- **管理界面**: http://localhost:8000/admin
- **模型列表**: http://localhost:8000/v1/models

## 🔒 安全认证 (新功能)

### 启用管理界面认证

配置 `AUTH_TOKEN` 环境变量后,管理界面和所有管理 API 都将受到保护:

```bash
export AUTH_TOKEN="your-secure-password-here"
deno run --allow-net --allow-env --allow-read --allow-write deno_pro.ts
```

**认证流程**:
1. 访问 `/admin` 看到登录表单
2. 输入 `AUTH_TOKEN` 的值
3. 认证成功后可访问所有管理功能
4. Token 保存在 localStorage,刷新页面无需重新登录

### API 认证

当前版本要求配置 `AUTH_TOKEN`。管理 API 使用 `ADMIN_TOKEN`，未单独设置时沿用 `AUTH_TOKEN`；只读看板可使用 `STATS_TOKEN`，浏览器登录后可自动刷新。详细配置与迁移说明见 [上游更新移植报告](上游更新移植与验证报告_20261103.md)。

配置 `AUTH_TOKEN` 后,所有管理 API 请求都需要携带 Bearer Token:

```bash
curl -H "Authorization: Bearer YOUR_AUTH_TOKEN" \
     http://localhost:8000/api/admin/stats
```

**受保护的端点**:
- `GET /api/admin/stats` - 服务统计
- `GET /api/admin/models` - 模型列表
- `POST /api/admin/models` - 添加模型
- `PUT /api/admin/models` - 更新模型
- `DELETE /api/admin/models/:id` - 删除模型

详见: [管理界面认证功能文档](docs/管理界面认证功能完成总结.md)

## 📖 完整文档

- **[简单部署指南](docs/简单部署指南.md)** - 快速开始部署 🆕
- **[deno_pro 完整功能指南](docs/deno_pro完整功能指南.md)** - 所有功能详细说明
- **[Deno Deploy 部署指南](docs/Deno_Deploy部署指南.md)** - 云端部署教程
- **[管理界面认证功能](docs/管理界面认证功能完成总结.md)** - 认证功能详解
- **[优化工作总结](docs/优化工作总结报告.md)** - 版本迭代历史

## 📊 API 使用示例

### 文本对话

```bash
curl http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_AUTH_TOKEN" \
  -d '{
    "model": "claude-4.5-sonnet",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": false
  }'
```

### 图像生成

```bash
curl http://localhost:8000/v1/images/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_AUTH_TOKEN" \
  -d '{
    "prompt": "一只可爱的小猫",
    "n": 1,
    "size": "1024x1024",
    "quality": "standard"
  }'
```

## 🌐 VPS 部署

使用 systemd 服务运行:

```bash
#!/bin/bash

# 1. 安装 Deno
curl -fsSL https://deno.land/install.sh | sh
export PATH="$HOME/.deno/bin:$PATH"

# 2. 创建服务目录
mkdir -p /opt/sider2api
cd /opt/sider2api
git clone https://github.com/goldenhawksu/sider2api.git .

# 3. 设置环境变量
cat > .env << EOF
SIDER_AUTH_TOKEN=your_sider_token_here
AUTH_TOKEN=your_auth_token_here
PORT=8000
EOF

# 4. 创建 systemd 服务
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
ExecStart=/root/.deno/bin/deno run --allow-net --allow-env --allow-read --allow-write deno_pro.ts
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

# 5. 启动服务
systemctl daemon-reload
systemctl enable sider2api
systemctl start sider2api

echo "✅ 服务已启动,监听端口 8000"
echo "访问地址: http://your-vps-ip:8000"
```

## 🎨 支持的模型

| 类别 | 模型 | 备注 |
|------|------|------|
| GPT | gpt-4.1, gpt-4o, gpt-4.1-mini | OpenAI 系列 |
| Claude | claude-4.5-sonnet, claude-4.1-opus, claude-haiku-4.5 | Anthropic 系列 |
| Gemini | gemini-2.5-pro, gemini-2.5-flash | Google 系列 |
| DeepSeek | deepseek-v3.1, deepseek-reasoner | DeepSeek 系列 |
| Think 模式 | *-think 后缀 | 支持深度思考 |

完整列表见: [docs/deno_pro完整功能指南.md](docs/deno_pro完整功能指南.md)

## 🤝 贡献指南

欢迎提交 Pull Request 或创建 Issue!

## 📄 许可证

本项目采用 MIT 许可证 - 详见 [LICENSE](LICENSE) 文件

## 📞 联系方式

如有任何问题或建议,请通过 [GitHub Issues](https://github.com/goldenhawksu/sider2api/issues) 与我们联系。

---

**🎉 享受使用 Sider2API!**
