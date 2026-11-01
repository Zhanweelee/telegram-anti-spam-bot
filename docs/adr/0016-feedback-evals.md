# ADR 0016：申诉导出为评测样本

- 状态：已接受
- 日期：2026-11-01

## 背景

P2-02 要求把确认和误判记录导出成 eval 样本。ADR 0003 禁止默认保存消息原文。维护者还没有同意把原文写进评测集，所以这一步只能导出哈希、特征和标签。

## 决策

- 纯函数 `buildFeedbackCase` 把一条 `ReviewSample` 收成评测样本。`confirmed` 映射为 `spam`，`false_positive` 映射为 `ham`。字段是 `id`、`chatId`、`label`、可选 `textSha256`、`action`、`score`、`reasons`、`ruleIds`。不复制 `evidence`、`messageId` 和 `createdAt`。
- 每条样本保留 `chatId`。整租户导出时，不同群的样本不会掉进同一个没有群标识的袋子。
- 文档形状是 `{ tenantId, chatId?, cases }`。schema 是 strict object。带 `text`、`body`、`caption`、`raw`、`messageText` 或 `content` 的对象会被拒绝。`cases` 最多 256 条，和审核队列的上限一致。
- 私聊命令 `/evals [chatId]` 只给配置中的管理员。租户取事件上的 `tenantId`。它读取 `ReviewQueue.list`，不读审计正文，也不调用 `putRuleSet`。没有队列、schema 失败或存储抛错时回复「参数无效」，日志是 `operator_rejected`，不写异常文本。JSON 超过 3500 字符时只回复条数。
- 群聊里的同样文本不导出。`/forget` 仍然只删审计，评测导出走的是队列，所以删审计之后样本还在。
- `evals/cases/feedback.json` 只放哈希、特征和标签。这些样本没有原文，不能送进关键词或 LLM 检测器重放。等维护者明确同意保存原文，再另写 ADR。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 把样本塞进 `/export` 的审计数组 | 审计和评测是两份文档。审计还带着证据摘要，评测样本故意不带。 |
| 把消息原文写进 `evals/cases` | 维护者还没有同意保存原文。 |
| 导出时丢掉 `chatId` | 一次导出整个租户时，无法分辨样本来自哪个群。 |

## 后果

- 公共导出增加 `FeedbackCase` 和 `feedbackEvalDocument`。命令目录增加 `command.evals.*`。
- 现有检测器的 precision / recall 不变。这批样本不参与检测器重放。
- 没有 `DB` 时，队列在 isolate 内存里，重启后 `/evals` 是空文档。
- 私聊长度上限会截断大导出。完整导出留到以后的文件下发，不在这一步做。
