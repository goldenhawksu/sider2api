# 对比测评报告：sider2pro vs sider2claude（Deno Deploy 生产实例）

> 测评日期：2026-08-22
> 被测实例：
> - sider2pro    `https://sider2pro.asu.deno.net`（本项目 deno_pro.ts）
> - sider2claude `https://sider2claude.asu.deno.net`（参考项目 sider2claude）
> 测试脚本：`test/bench_compare.py`（可复跑）

## 一、测评方法与公平性设计

**统一协议**：两个服务都用 OpenAI 兼容 `POST /v1/chat/completions`（两边都支持），
相同模型、相同 prompt、相同请求体。s2claude 内部会转成 Anthropic 协议再调上游，
s2pro 直接翻译到 sider 上游——这是各自的实现路径，测评测的是"面向终端的端到端表现"。

**模型**：取两服务模型清单交集，按家族选代表：`claude-haiku-4.5`（Anthropic）、
`gpt-5.5`（OpenAI）、`sider`（智能路由）、`deepseek-v4-pro`（DeepSeek）。
每个模型每种模式取 2~3 次采样，报告均值。

**会话管理**：双方各自用自己的机制（s2pro: 消息指纹推导 session；s2claude: 消息指纹），
测评脚本不手动传 session header，两轮之间用完整历史实现对话记忆。

**消耗**：每次请求消耗真实 sider 额度；s2claude 有混合路由（sider + deepseek fallback），
若发生 fallback 会影响延迟，已在结果中注明。

## 二、结果总表

| 模型 | 服务 | 非流式(ms) | TTFT(ms) | 流式总耗时(ms) | 输出字符 | 吞吐(字符/s) | 记忆 |
|---|---|---|---|---|---|---|---|
| claude-haiku-4.5 | s2pro | 2616 | 1996 | 3359 | 172 | 128 | ✅ |
| claude-haiku-4.5 | s2claude | **1613** | **1946** | **3127** | 152 | 133 | ✅ |
| gpt-5.5 | s2pro | 3382 | 1614 | 2578 | 148 | 156 | ✅ |
| gpt-5.5 | s2claude | **2234** | **1462** | **2168** | 156 | **220** | ✅ |
| sider | s2pro | 2418 | 3040 | 3816 | 149 | **206** | ✅ |
| sider | s2claude | **1880** | **1908** | **3262** | 182 | 134 | ✅ |
| deepseek-v4-pro | s2pro | 3226 | **1886** | 4056 | **458** | **214** | ✅ |
| deepseek-v4-pro | s2claude | **2972** | 1962 | **3116** | 187 | 165 | ✅ |

（加粗 = 该项更优；字符数越高不一定越优，见分析）

## 三、分维度分析

### 1. 非流式延迟（端到端）

**s2claude 全面更快**，4 个模型均领先：

| 模型 | s2pro | s2claude | 差距 |
|---|---|---|---|
| claude-haiku-4.5 | 2616ms | 1613ms | -38% |
| gpt-5.5 | 3382ms | 2234ms | -34% |
| sider | 2418ms | 1880ms | -22% |
| deepseek-v4-pro | 3226ms | 2972ms | -8% |

s2pro 的非流式路径是"消费完整上游 SSE 流→聚合→一次性返回"，需等上游
最后一个 `[DONE]` 才回包；s2claude 同样聚合后返回，但实测更快，可能与
上游请求模板细节（如 s2claude 的 hybrid 路由预判）或实例地域有关。
差距在短输出上最明显（haiku 38%），长输出收敛（deepseek 8%）。

> 注：s2claude 单次采样出现过 368ms 的极值（上游缓存/实例预热），波动范围
> 大于 s2pro，均值仍稳定领先。

### 2. 流式 TTFT（首字延迟）

**基本打平，s2claude 略优**：

- gpt-5.5：1462 vs 1614（s2claude -9%）
- sider：1908 vs 3040（s2claude **-37%**，优势最大）
- deepseek-v4-pro：1886 vs 1962（s2pro -4%）
- claude-haiku-4.5：1946 vs 1996（约平）

sider 智能路由上 s2claude 的 TTFT 优势显著，可能与它对"简单对话优先走 sider"
的路由预判（`PREFER_SIDER_FOR_CHAT`）有关，能更快命中直连路径。

### 3. 流式总耗时与吞吐

**总耗时 s2claude 普遍更低**（3/4 模型），但**吞吐各有胜负**：

- 总耗时：gpt-5.5 2168 vs 2578、sider 3262 vs 3816、deepseek 3116 vs 4056、
  haiku 3127 vs 3359 —— s2claude 全部领先（-12% ~ -23%）。
- 吞吐（字符/s）：s2pro 在 sider(206 vs 134) 和 deepseek(214 vs 165) 更高；
  s2claude 在 gpt-5.5(220 vs 156) 更高。与输出内容长度和 chunk 切分粒度有关。

**chunk 粒度差异**：claude-haiku 上 s2pro 返回 7 块、s2claude 30 块。
s2claude 逐条转发上游 text 事件（更细粒度，客户端感知更平滑）；
s2pro 的 OpenAI 流式也逐块转发但块数较少。两者都正确完成 `[DONE]` 收尾。

### 4. 输出内容长度（重要差异）

同一 prompt 下两侧输出字符数差异明显，尤其 deepseek：

| 模型 | s2pro 输出 | s2claude 输出 |
|---|---|---|
| deepseek-v4-pro | **458** | 187 |
| sider | 149 | 182 |
| gpt-5.5 | 148 | 156 |
| claude-haiku-4.5 | 172 | 152 |

deepseek 上 s2pro 输出是 s2claude 的 **2.4 倍**。可能原因：
- 两侧上游请求模板/上下文拼接方式不同（s2pro 注入了完整历史 + system 结构，s2claude 可能精简）；
- s2pro 对 deepseek 的上下文截断策略更宽松。

影响：s2pro 输出更长 → 单次字符多，绝对吞吐（字符/s）更高，但延迟也更高、
成本更高。s2claude 输出更精简 → 快但信息量可能少。**这一维度不判优劣，需按业务需要取舍。**

### 5. 对话记忆（3 轮连续对话）

**两侧都完美通过**：第 1 轮"记住代号 AURORA-7"→ 第 2 轮"收到"→ 第 3 轮问代号，
两服务都正确回答 `AURORA-7`，且第 3 轮延迟最低（s2pro 1274ms、s2claude 1115ms，
说明会话复用生效，未重复全量重算）。

| 服务 | 第1轮 | 第2轮 | 第3轮 | 记忆判定 |
|---|---|---|---|---|
| s2pro | ✅ 2339ms | ✅ 1289ms | ✅ 1274ms | ✅ 记得 AURORA-7 |
| s2claude | ✅ 2802ms | ✅ 1330ms | ✅ 1115ms | ✅ 记得 AURORA-7 |

两侧会话记忆机制（消息指纹）都可靠，第 2/3 轮明显快于第 1 轮（命中既有会话）。

## 四、汇总结论

| 维度 | 胜者 | 幅度 |
|---|---|---|
| 非流式延迟 | **s2claude** | 全面领先 8%~38% |
| 流式 TTFT | **s2claude**（略优） | 多数模型领先，sider 达 -37% |
| 流式总耗时 | **s2claude** | 领先 12%~23% |
| 吞吐（字符/s） | 各有胜负 | s2pro 在 sider/deepseek 更高，s2claude 在 gpt-5.5 更高 |
| 对话记忆 | 平 | 两侧都可靠复用会话 |
| 输出长度 | 各有所长 | s2pro 更长（deepseek 2.4x），s2claude 更精简 |

**总体：面向终端的响应速度（非流式延迟/TTFT/总耗时）s2claude 全面小幅领先，
对话记忆能力平手；s2pro 在长输出模型（deepseek）上吞吐更高但延迟也更长。**

## 五、局限与说明

1. **架构差异**：s2claude 是混合路由（sider 主 + deepseek 兜底），s2pro 是
   单上游 sider 直译。延迟差异部分来自路由层，不纯粹是代码性能。
2. **上游抖动**：s2claude 单次出现过 368ms 极值（波动范围 > s2pro），
   均值结论受样本数影响（每项 2~3 次）。
3. **输出内容差异**：两侧对同一 prompt 的输出长度/措辞不同，吞吐与延迟的
   对比会受内容差异影响，非严格等量对比。
4. **地域/实例**：Deno Deploy 多地域边缘实例，两侧冷热实例状态不同，
   可能引入偏差。
5. **消耗**：本次测评共约 24 次真实上游请求，消耗 sider 额度。

## 六、附：复跑命令

```bash
# 单模型全维度（默认 claude-haiku-4.5, 3 次取样）
python test/bench_compare.py

# 多模型批量对比表
python test/bench_compare.py --models gpt-5.5,sider,deepseek-v4-pro --rounds 2

# 只测对话记忆
python test/bench_compare.py --memory-only
```
