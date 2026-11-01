# Changelog

包版本由 Changesets 在发布时生成。这里记录已经落地的轮次，方便不看 PR 的人了解仓库状态。

## Unreleased

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
