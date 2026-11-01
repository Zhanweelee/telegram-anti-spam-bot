# Changelog

包版本由 Changesets 在发布时生成。这里记录已经落地的轮次，方便不看 PR 的人了解仓库状态。

## Unreleased

### P0-01

- `POST /telegram/webhook` 校验 `X-Telegram-Bot-Api-Secret-Token`。密钥未配置或不匹配时返回 401，不进入流水线。
- `message` 更新在 `platform-telegram` 里归一化成 `Event`。无文本、caption、匿名管理员和 `ADMIN_USER_IDS` 有 fixture 或单测。
- Worker 默认用关键词规则在当次请求的内存里做判定。尚未调用 Telegram 的删除接口。

### Round 0

- 建立 pnpm monorepo、TypeScript strict、Biome、Vitest、Wrangler、Changesets 和 CI。
- 增加 core 流水线：Event、规则、检测器、聚合、决策、动作、审计。
- 增加关键词检测器、删除动作、内存适配器，以及 `examples/minimal-pipeline`。
- 记录架构、三份 ADR，以及查证过的 Cloudflare 免费额度。
