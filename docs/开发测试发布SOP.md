# Sider2API 敏捷开发·测试·发布·验证 标准操作指导 (SOP)

> 本文基于 2026-06-28 对 `deno_pro.ts` 的本地功能测试实战提炼,作为后续迭代的标准流程。
> 配套环境约定见根目录 [CLAUDE.md](../CLAUDE.md)。

---

## 0. 角色与铁律

- **本地优先**:所有开发、单元测试、集成回归测试一律在本地 Deno 环境完成后,才考虑推送。
- **推送需授权**:推送主分支 / 远端 **必须经用户明确同意**(推送即触发 deno.com 自动部署)。
- **如实报告**:测试失败要贴出失败输出;跳过的步骤要说明;不臆造"通过"。

---

## 1. 一次性环境准备

### 1.1 Deno 运行时
```bash
# 官方脚本在 git-bash 下 tar 解压会失败,改用 PowerShell:
powershell -NoProfile -Command "
  \$dir=\"\$env:USERPROFILE\.deno\bin\"; New-Item -ItemType Directory -Force -Path \$dir | Out-Null
  \$zip=\"\$env:TEMP\deno.zip\"
  Invoke-WebRequest -Uri 'https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip' -OutFile \$zip
  Expand-Archive -Path \$zip -DestinationPath \$dir -Force; Remove-Item \$zip
  & \"\$dir\deno.exe\" --version"
```
- Deno 可执行:`~/.deno/bin/deno.exe`

### 1.2 Python 测试环境(anaconda3)
- 虚拟环境:`python310`(Python 3.10.18,含 requests),`conda activate python310` 激活后用 `python`。
- ⚠️ 需先 `conda init` 初始化过对应 shell(PowerShell/cmd/bash),重开终端后 `conda activate` 方可用。

### 1.3 凭证 `.env`(已被 .gitignore 排除,切勿提交)
```ini
SIDER_AUTH_TOKEN=<Chrome→F12→应用→扩展存储→Sider侧边栏→本地→密钥栏 token>
ENABLE_AUTO_SEARCH=false   # 测试期关闭,降低 TTFT/长尾
UPSTREAM_TIMEOUT_MS=60000
```

---

## 2. 敏捷迭代主循环

```
用户需求 → 本地开发 → 静态检查 → 本地启动 → 分级测试 → 报告 → (用户同意) → 推送 → 部署 → 远端验证
```

### 步骤 1:本地开发
在 `deno_pro.ts` 修改。保持与现有代码风格一致。

### 步骤 2:静态类型检查(提交前必做)
```bash
~/.deno/bin/deno.exe check deno_pro.ts
```
- 期望 0 error。已知历史告警:`error` 为 `unknown` 类型时访问 `.message`,
  规范写法 `error instanceof Error ? error.message : String(error)`。

### 步骤 3:本地启动服务
```bash
cd /d/Github_repo/sider2api
~/.deno/bin/deno.exe run --allow-net --allow-env --allow-read --env-file=.env deno_pro.ts > server.log 2>&1 &
sleep 5
grep -a "SIDER_AUTH_TOKEN\|监听地址" server.log   # 必须看到 "SIDER_AUTH_TOKEN: ✅ 已配置"
```
- ⚠️ **启动前先清干净旧实例**,否则端口被未加载 token 的旧进程占用,会导致全部 `Invalid Token`:
  ```bash
  taskkill //F //IM deno.exe 2>/dev/null
  curl -s -o /dev/null -w "8000:%{http_code}\n" --max-time 3 http://localhost:8000/   # 期望 000(已释放)
  ```

### 步骤 4:分级测试

**A. 冒烟 / 不依赖上游(curl,秒级):**
```bash
B=http://localhost:8000
curl -s -o /dev/null -w "主页 %{http_code}\n" $B/
curl -s $B/v1/models | python -c "import sys,json;print('模型数',len(json.load(sys.stdin)['data']))"
curl -s -X OPTIONS $B/v1/chat/completions -D - -o /dev/null | grep -i access-control   # CORS
curl -s $B/api/admin/stats                                                              # 管理统计
curl -s -o /dev/null -w "404 %{http_code}\n" $B/nope                                    # 404
```

**B. 真实业务回归(anaconda python310,依赖有效 token):**
```bash
conda activate python310
python test\local_test.py > test\local_test_output.txt 2>&1
```
[test/local_test.py](../test/local_test.py) 覆盖:跨模型非流式、流式 SSE、多轮会话记忆、Think 模式、图像生成。
退出码 0 = 全通过。

### 步骤 5:出报告
将结果写入 `test/本地测试报告_YYYYMMDD.md`,含:环境、静态检查、A/B 测试矩阵、失败排查、结论与待办。

### 步骤 6:推送(需用户明确同意)
```bash
git add <文件>           # 切勿 add .env
git commit -m "<conventional commit>"
git push                 # ← 必须用户同意;push 即触发 deno.com 部署
```

### 步骤 7:部署后远端验证
```bash
sleep 30   # 等待 deno.com 部署(约 30s)
# 用 API_Test.py(指向 .env 配置的 BASE_URL,token 在 deno.com 后台已配)
conda activate python310
python API_Test.py
```
- 模型清单可直接从部署域名 `GET /v1/models` 获取。

---

## 3. 收尾清理(每次测试后)

```bash
taskkill //F //IM deno.exe 2>/dev/null   # 停服务
rm -f server.log
git status --short                        # 确认无意外改动
git check-ignore .env                     # 确认 .env 仍被忽略
cat custom_models.json                     # CRUD 测试后应为 []
```

---

## 4. 故障速查表

| 现象 | 根因 | 处置 |
|---|---|---|
| 全部 `code:1001 Invalid Token` | ①8000 被未加载 token 的旧实例占用;②token 真失效 | 先 `taskkill` 清进程重启;再直连上游验证 token(见下) |
| 直连上游验证 token | — | `curl -X POST https://sider.ai/api/chat/v1/completions -H "Authorization: Bearer $TOKEN" -H "X-App-Name: ChitChat_Edge_Ext" -d '{"stream":false,"model":"sider","multi_content":[{"type":"text","text":"hi","user_input_text":"hi"}]}'` → `code:0` 即 token 有效 |
| python 报 `/dev/stdin` 不存在 | Windows 下不支持 | 用 `sys.stdin` 读取,并设 `PYTHONIOENCODING=utf-8` |
| anaconda 路径忽而找不到 | git-bash 对 D 盘间歇抖动 | 改 `cmd //c` 调用或重试 |
| 中文输出乱码 | 控制台 GBK | 设 `PYTHONIOENCODING=utf-8`;数据正确性不受影响 |
| `deno check` 报 unknown 类型 | 非阻断告警 | 不影响运行/部署,按规范写法修复 |

---

## 5. 关键不变量(回归必查)

- `GET /v1/models` 返回模型数与 `MODEL_MAPPING` 键数一致(当前 44),字段含 `id/object/created/owned_by/permission/root/parent`。
- 多轮:同一 `X-Session-ID` 跨轮复用 Sider `cid`,能记忆上下文。
- `-think` 后缀模型启用 Think 模式。
- 配置 `AUTH_TOKEN` 时:`/v1/chat`、`/api/admin/*` 受保护(401),`/v1/models`、`/` 公开。
- 上游异常时代理优雅返回结构化错误(500/4xx),不崩溃。
