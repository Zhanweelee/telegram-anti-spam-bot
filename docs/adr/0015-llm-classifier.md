# ADR 0015：LLM 分类默认关闭

- 状态：已接受
- 日期：2026-11-01

## 背景

P2-01 要求一个可插拔的分类器。Workers AI 额度错误或超时时跳过。模型名和免费计划可用性要写进 ADR。付费模型不能当默认。

查证日期 2026-11-01。来源是 [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)（页面标注 2026-10-20）、[2026-07-28 部分模型需要付费计划](https://developers.cloudflare.com/changelog/post/2026-07-28-models-require-workers-paid/)，以及模型页 [distilbert-sst-2-int8](https://developers.cloudflare.com/workers-ai/models/distilbert-sst-2-int8/)。免费计划每天 10,000 Neurons，用尽返回 HTTP 429，内部码 3036。免费计划不能继续付费使用。

## 决策

- core 只放端口 `LlmClassifier`。它返回 `{ label, score }`。core 不发请求。
- 检测器 `llm` 在 `packages/detectors-llm`。没有分类器时直接返回未命中，不写日志。分类器抛错或超过 `timeoutMs`（默认 800，上限 1000）时记 `llm_failed` 并返回未命中。日志只有 `eventId`、`chatId`、`detectorId`。
- 默认模型是 `@cf/huggingface/distilbert-sst-2-int8`。定价页写的是 2394 neurons / 1,000,000 input tokens。它做的是情感分类，标签是 `NEGATIVE` 和 `POSITIVE`，不是垃圾消息模型。只有 `NEGATIVE` 且分数不低于 0.9 才记一条 `llm` 命中。证据是 `llm:NEGATIVE`，不含原文。
- 这些模型在免费计划上会 403（内部码 5035），适配器拒绝调用它们：`@cf/moonshotai/kimi-k2.6`、`@cf/moonshotai/kimi-k2.7-code`、`@cf/zai-org/glm-5.2`、`@cf/zai-org/glm-5.3`、`@cf/zai-org/glm-5.3-flash`、`@cf/deepseek-ai/deepseek-v4-flash-0731`、`@cf/deepseek-ai/deepseek-v4-pro-0813`。名单来自 2026-07-28 之后的 changelog，不是完整目录。
- 默认规则 `llm_hint` 的 `enabled` 是 false。提交的 `wrangler.jsonc` 不绑定 `AI`。两条都打开之后，下一条消息才会调用模型。`chats.json` 整份替换的群不会自动带上这条规则。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 用 `@cf/zai-org/glm-4.7-flash` 做生成式判断 | 免费计划还能用，但生成式模型更贵，也更容易把原文送进更长的提示。情感分类已经能当最后一级。 |
| 默认打开，每条消息都分类 | 免费 Neurons 是 10,000 / 天。误判也会直接删消息。验收要求默认关闭。 |
| 把付费模型设成默认，403 再跳过 | 验收禁止。适配器在调用前就拒绝已知的付费模型。 |

## 后果

- 默认部署不消耗 Neurons，dry-run 绑定也不增加 `AI`。
- 打开之后，情感为负的普通抱怨可能被删。这是模型能力的上限，不是垃圾消息专用模型。
- 额度、超时、坏响应和付费模型都放过这条消息。请求不会变成 500。
- 发给模型的文本最多 512 字符，不写入审计，也不写入日志。
