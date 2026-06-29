# 开发报告：基于上游探针的功能优化 + Gemini 格式端点 TDD

> 时间: 2026-06-29
> 基准探针: `upstream_capabilities_20260628_230138`
> 产出: 3 次提交 / 4 文件变更 / ~600 行新增

## 探针驱动对照表

探针→需求→实现→验证，逐条闭环：

| # | 探针发现 | 现状/缺口 | 优化动作 | 验证 |
|---|---|---|---|---|
| 1 | `nano_banana_lite` 返回 `code:1000` | `detectImageQuality()` 映射到非法值 | 替换为 `nano_banana_2` + `handleImageGeneration` 补齐 `quality=fast` 映射 | 本地/生产 pytest 通过 |
| 2 | `reasoning_content` SUPPORTED | 流式/非流式均未处理 | 新增 case + 转发，非流式注入 `message.reasoning_content`，流式注入 `delta.reasoning_content` | curl 确认 / 生产 pytest 通过 |
| 3 | `code:1135` 限流 `"try again after 69 minutes"` | 上游错误统一抛 500 | 4 类错误码翻译: 603→400, 1001→401, 1101/1135→429 | 生产 pytest 通过 |
| 4 | 流内 SSE 顶层 `{code,msg}` 未检测 | 流式只解析 `data` 字段 | 流式循环末尾新增 code 检测 + 错误 chunk | 逻辑验证通过 |
| 5 | Gemini 格式端口为零 | marker `gemini` 已注册但无端点 | TDD: 写红灯→实现端点→转绿 | 6/6 PASS |
| 6 | 探针每次用同一 prompt | 硬编码 prompt 重复 | prompt_bank.py 7 维题库随机选题 | 探针报告已产出 |

## 文件变更清单

| 文件 | 变更量 | 主要内容 |
|---|---|---|
| `deno_pro.ts` | +~400 行 | 5 项优化 + Gemini 端点 |
| `test/prompt_bank.py` | 新增 151 行 | 7 维度 × 12-15 题随机题库 |
| `test/helpers.py` | +38 行 | `extract_reasoning` / `_delta_reasoning` / `parse_stream` 扩展 |
| `test/test_think.py` | 重写 | 非流式+流式推理验证，retry+skip 容错 |
| `test/test_gemini_format.py` | 新增 169 行 | Gemini 格式 6 条用例 |

## Commit 历史

```
754d1a9 feat(gemini): Gemini 格式端口 TDD + nano_banana_2 映射补齐
0d98279 feat(deno_pro): 基于上游探针的5项功能优化 + 测试增强
ebd9fea feat(probe): 引入随机题库 + 修复错误码递归收集 + 校正图像质量级别
```

## 回归测试结果

| 环境 | 通过/总数 | 说明 |
|---|---|---|
| 生产 (`sider2pro.asu.deno.net`) | **11/11** | chat+think 全绿，reasoning_content 确认转发 |
| 本地 (`localhost:8000`) 冒烟 | **7/7** | metadata + error 契约全绿 |
| 本地 全量回归(不含perf) | **27/28** | 1 flaky: think流式上游限频后空响应 |
| 本地 Gemini 格式 | **6/6** | 非流式/systemInstruction/think/流式/多轮/回退全绿 |

## 已知局限与后续

1. **流式 `reasoning_content` 非标准**: OpenAI API 不定义此 delta 字段，以扩展字段暴露
2. **Gemini `thought` 字段**: 非标准扩展，正式 Gemini API 无此字段，供 aware 前端用
3. **Gemini inlineData/fileData 不支持**: 图像/二进制 parts 因上游不支持视觉输入，统一返回 `not_supported`
4. **生产尚未推送最新 Gemini 端点**: ✅ 已推送（`fe053aa`），所有端点已在生产运行

## 下一步（按优先级）— 2026-06-29 回顾

1. ✅ **推送上线** → `fe053aa` 已推送，含 Gemini + Anthropic + Responses + Tools + Vision 全部端点
2. ✅ **Anthropic 格式端口** → 已实现 (`3bcbe7f`)，7/7 PASS
3. ✅ **Tools / Function Calling** → 探针确认上游不支持自定义 function calling，已实现降级门控 (`a3f5741`)
4. ✅ **Vision 输入** → 探针确认上游不支持视觉输入，已实现 `not_supported` 门控 (`a8e6e61`)
5. **流式 `finish_reason:"stop"` 终止块** → 低优先级兼容缺口，主流 SDK 已兼容 `[DONE]` 终结
