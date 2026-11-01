# Changelog

包版本由 Changesets 在发布时生成。这里记录已经落地的轮次，方便不看 PR 的人了解仓库状态。

## Unreleased

### P1-03

- 短链接和裸 IP 默认删除。普通网址保留。见 ADR 0011。
- Worker 不传信誉源，热路径不发远程查询。信誉源超时或抛错时这条检测放过，日志是 `reputation_failed`。
- 评测集 `evals/cases/link.json` 的 precision 和 recall 都是 1。

### P1-02

- 同一人在 10 秒内发到第 5 条，或同一内容哈希在 60 秒内出现第 3 次，默认规则会删除。见 ADR 0010。
- 计数在 isolate 内存里。窗口满了或计数抛错时，这一条检测跳过，请求继续。
- 评测集 `evals/cases/rate.json` 的 precision 和 recall 都是 1。

### P1-01

- 新成员在通过按钮验证前被限制发言。通过和超时都留下不含原文的审计。见 ADR 0009。
- 检测器抛错时默认 fail-open，不会限制这个人。没有 bot token，或按钮发不出去时，挑战会回滚。
- `callback_query` 收成 `kind: "challenge"`。设置 webhook 时要带上 `callback_query`。
- 账号上的那一个 Cron 每 15 分钟清理当前 isolate 里到期的验证。isolate 重启会丢掉未完成的挑战。

### P0-09

- 可以按租户导出审计 JSON，也可以再限定一个群。文档里没有原文键。见 ADR 0008。
- 删除该范围后，再次读取为空。规则和白名单还在。其它租户不受影响。
- 管理员在私聊使用 `/export` 和 `/forget`。超长导出只回复条数。
- 30 天自动清理仍未实现，等维护者确认 ADR 0003 的初始保留期。

### P0-08

- D1 按租户和群保存审计与规则文档。迁移语句可以重复执行。见 ADR 0007。
- allow 和 dry-run 不写审计。`appendAudit` 失败时决策保持不变，日志只有 `storage_failed`。
- 内存适配器与 D1 适配器共用 `@tasb/core/testing` 的 `bindStorageContract`。
- Worker 在 `DB` / `POLICY_KV` 存在时使用它们。两个绑定都可以不填，免费部署仍然成功。

### P0-07

- README 的 10 分钟路径包含设置 secret、`wrangler deploy` 和设置 webhook。
- 当时还没有 D1 适配器，所以那一版部署不创建 D1 或 KV，也不要求付费计划。
- `pnpm smoke` 检查 `/health`，以及不带密钥的 401 和带密钥的 webhook 200。

### P0-06

- 配置中的管理员可以在私聊使用 `/help`、`/rules`、`/whitelist`、`/logs`、`/dryrun`。
- 群聊里的命令不改白名单，也不改 dry-run，消息仍进入检测流水线。
- `/logs` 只返回审计摘要。回复走 `ReplyPort`；未配置 bot token 时不请求 Telegram。见 ADR 0006。

### P0-05

- `PolicyStore` 按 `tenantId` + `chatId` 保存预过滤策略。`loadPolicy` 先读缓存，缺记录时使用调用方的 fallback。
- 管理员豁免可以按群关掉。白名单不跨租户、不跨群。
- 内存适配器与 KV 形态的 Cloudflare 适配器共用 `@tasb/core/testing` 的同一组行为测试。Worker 在绑定 KV 之前使用内存存储。

### P0-04

- `ModerationPort` 增加 `muteActor` 与 `banActor`。说明见 ADR 0004。
- mute 和 ban 在 dry-run 时跳过，缺少 actor 时返回 `failed`。严重度仍是 ban > mute > delete。
- Worker 注册这两个动作。默认规则仍是 delete。尚未调用 Telegram 的处罚接口。

### P0-03

- Worker 从 `apps/worker/rules/default.json` 读取默认 RuleSet，`chats.json` 按 `chatId` 整份覆盖。
- `loadRuleSet` 先读 `Cache`。未命中不调用 `Storage.getRuleSet`。
- 规则 schema 失败或来源抛错时该群 fail-open，日志只有 `rules_invalid`，不含原文或文档内容。

### P0-02

- `chat_member` 更新归一化成 `kind: "chat_member"` 的 Event，不带消息正文。主体是状态变化的用户。
- 没有文本时关键词检测器返回 null，流水线放行且不抛错。

### P0-01

- `POST /telegram/webhook` 校验 `X-Telegram-Bot-Api-Secret-Token`。密钥未配置或不匹配时返回 401，不进入流水线。
- `message` 更新在 `platform-telegram` 里归一化成 `Event`。无文本、caption、匿名管理员和 `ADMIN_USER_IDS` 有 fixture 或单测。
- Worker 默认用关键词规则在当次请求的内存里做判定。尚未调用 Telegram 的删除接口。

### Round 0

- 建立 pnpm monorepo、TypeScript strict、Biome、Vitest、Wrangler、Changesets 和 CI。
- 增加 core 流水线：Event、规则、检测器、聚合、决策、动作、审计。
- 增加关键词检测器、删除动作、内存适配器，以及 `examples/minimal-pipeline`。
- 记录架构、三份 ADR，以及查证过的 Cloudflare 免费额度。
