# ADR 0014：误判申诉进入审核队列

- 状态：已接受
- 日期：2026-11-01

## 背景

P1-06 要求管理员把一条审计标成误判或确认。记录不能含原文。样本进入待审核队列，不能自动改规则。P2-02 才会把这些样本导出成评测集。

## 决策

- 新增端口 `ReviewQueue`。一条样本是 `tenantId`、`chatId`、`eventId`、`label`（`false_positive` 或 `confirmed`）、可选 `textSha256`、`action`、`score`、`reasons`、`ruleIds`、`createdAt`。不复制 `evidence` 和 `messageId`。
- `buildReviewSample` 把超过 80 字符或含换行的 reason 写成 `redacted`。schema 是 strict object，带 `text` 的对象会被拒绝。
- 私聊命令 `/appeal <chatId> <eventId> false|confirm`。租户取事件上的 `tenantId`。先用 `Storage.getAudit` 读这一条审计。没有审计就不入队。同一条审计再次标记会改标签，不会多出一行。
- 命令不调用 `putRuleSet`，也不改白名单或 dry-run。`/forget` 只删审计，队列还在。
- 每个租户最多 256 条。满了之后新的事件被拒绝，已有事件仍可改标签。配了 `DB` 时队列在 D1 的 `review_samples`，语句写在可重复执行的 `0001_storage.sql`。没配 `DB` 时用 isolate 内存，重启会丢。
- 这一步是管理员命令，不在消息热路径上。一次标记是一次按主键的审计读取，加上一次队列写入。额度见 `docs/limits.md` 的 D1 行读和行写。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 在审计行上加标签列 | 导出会变，`/forget` 会把反馈一起删掉。审核样本和审计不是同一份记录。 |
| 用 Cloudflare Queues 当审核队列 | 这里要的是可查询的样本，不是异步消息。Queues 仍按 ADR 0007 先不用。 |
| 标记之后直接改规则或检测器 | 验收要求样本待审核，不自动改规则。导出成评测集是 P2-02。 |

## 后果

- 每个 `ReviewQueue` 跑 `bindReviewQueueContract`。每个 `Storage` 增加 `getAudit`。
- 已有 D1 再执行一次 `0001_storage.sql` 只会补上 `review_samples`。回滚语句是 `DROP TABLE IF EXISTS review_samples`，不自动执行。
- 没有 `DB` 时，isolate 重启会丢掉尚未导出的样本。
- 验证按钮和检测规则都不读这个队列。
