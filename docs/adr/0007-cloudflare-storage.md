# ADR 0007：Cloudflare 上的审计与白名单

- 状态：已接受
- 日期：2026-11-01

## 背景

P0-08 要把审计和白名单放到 Cloudflare 免费套餐里。`docs/limits.md` 里 D1 每天大约 10 万行写，KV 每天 1,000 次写。热路径不能为了规则或白名单去打 D1。允许动作和 dry-run 不该写审计。存储失败不能让 Webhook 变成 500。

仓库里的 `wrangler.jsonc` 必须在没有人粘贴 database id 的情况下仍能 `wrangler deploy`。

## 决策

- 审计和规则文档放 D1。表只有主键：`audits` 是 `(tenant_id, chat_id, event_id)`，`rule_sets` 是 `(tenant_id, chat_id)`。不建二级索引，因为索引列会计入 D1 行写。
- 迁移语句同时导出为 `storageMigrationStatements` 和 `packages/adapters-cloudflare/migrations/0001_storage.sql`。语句是 `CREATE TABLE IF NOT EXISTS`，可以重复执行。Worker 不在每条消息上跑迁移：一个 isolate 第一次拿到 `DB` 时创建一次存储，由这次创建负责迁移。失败会清掉这次尝试，下一条消息再试。
- 白名单继续走已有的 `createKvPolicyStore`。Worker 在 `POLICY_KV` 存在时使用它，否则用内存。
- `loadRuleSet` 仍然只读缓存和包内 JSON，不调用 `Storage.getRuleSet`。
- `DB` 和 `POLICY_KV` 都是可选绑定。没配时审计和白名单留在 isolate 内存，最多 200 条审计。
- 适配器只接受一个窄的 `SqlDatabase`。Worker 把 `D1Database` 包进去。core 不出现 Workers 类型。
- allow 和 dry-run 仍由流水线在调用 `appendAudit` 之前返回。`appendAudit` 抛错时决策保持不变，日志代码是 `storage_failed`，不写异常文本。
- 同一事件主键再插入一次会失败。流水线把它当成存储失败，不改决策。内存适配器仍允许同一事件 id 出现多次。共享行为测试不要求两边在这件事上一致。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 把审计放进 KV | 免费计划每天 1,000 次写。`docs/limits.md` 把 KV 留给读多写少的白名单和热配置。 |
| 在提交的 `wrangler.jsonc` 里写占位 database id | 全新账号的 `wrangler deploy` 和 dry-run 会在 id 无效时失败。 |
| 每条消息用 `Storage.getRuleSet` 读规则 | 热路径变成 D1 读，和 `loadRuleSet` 的缓存设计相反。 |

## 后果

- 配了 `DB` 之后，每条非 allow、非 dry-run 的决策写一行审计。
- 冷 isolate 的第一笔存储调用多付两条建表语句。
- 审计列表按 `rowid` 从旧到新，靠主键过滤租户和群，不靠额外索引。
- 规则文档可以经 `putRuleSet` 写到 D1，但当前检测热路径不读它。
- 30 天清理和导出删除仍是 P0-09。这一轮不删除旧行。
