# TASB

Telegram 反垃圾 bot。同一套核心，两种部署：自己放到 Cloudflare Workers，或接入维护者的公共 bot。

检测流水线是：

`Event → 预过滤 → Detector → 聚合 → Decision → Action`

核心不认识 Telegram，也不认识 Cloudflare。自部署和云服务的差别只留在适配层。

## 30 秒

| 你想做的事 | 去哪里 |
| --- | --- |
| 看架构边界 | [docs/architecture.md](docs/architecture.md) |
| 看现在该做什么 | [ROADMAP.md](ROADMAP.md) |
| 给 Agent / 贡献者的规矩 | [AGENTS.md](AGENTS.md) |
| 免费额度对设计的约束 | [docs/limits.md](docs/limits.md) |
| 跑一条最小检测 | [examples/minimal-pipeline](examples/minimal-pipeline) |
| 看 webhook 怎么收事件 | [examples/telegram-webhook](examples/telegram-webhook) |
| 看私聊命令怎么改配置 | [examples/operator-commands](examples/operator-commands) |
| 部署到自己的 Cloudflare | [docs/deploy.md](docs/deploy.md) |

Webhook 已经能校验 Telegram 的 `secret_token`，并把普通消息和 `chat_member` 归一化成内部事件。默认规则在 `apps/worker/rules/default.json`，某个群可以在 `chats.json` 里整份替换。热路径先读缓存，不读 D1。规则 schema 失败时该群放行。白名单和管理员豁免按租户和群存放；没有记录时仍豁免管理员，某个群可以关掉豁免。配了 KV 之后白名单进 KV，配了 D1 之后审计进 D1。两个绑定都可以不填，那时数据留在 isolate 内存里。配置中的管理员可以在私聊使用 `/help`、`/rules`、`/whitelist`、`/logs`、`/dryrun`、`/export`、`/forget`。群聊里的这些文本不会改配置。默认流水线不会调用 Telegram 的删除、禁言或封禁接口。规则可以写 `mute` 或 `ban`，严重度是 ban > mute > delete > captcha。新成员入群后，在点「我不是机器人」之前不能发言。按钮回调要能送到 bot，`allowed_updates` 需要包含 `callback_query`。没有 bot token 时不会限制这个人。同一人 10 秒内第 5 条消息，或同一内容哈希 60 秒内第 3 次，会被删掉。这个计数在 isolate 内存里，超额时跳过，不拖住请求。见 ADR 0010。

## 10 分钟跑通

需要 Node.js 22、pnpm 10、一个 Cloudflare 免费账号，以及 BotFather 的 token。不需要信用卡。

```sh
pnpm install
cd apps/worker
pnpm exec wrangler login
pnpm exec wrangler d1 create tasb
pnpm exec wrangler kv namespace create POLICY_KV
```

把打印出来的 id 按 [docs/deploy.md](docs/deploy.md) 写进 `wrangler.jsonc` 的 `DB` 和 `POLICY_KV`，然后执行可重复的迁移。绑定可以先不填。没填时审计和白名单留在 isolate 内存里，`wrangler deploy` 仍然成功。

```sh
pnpm exec wrangler d1 execute tasb --remote --file=../../packages/adapters-cloudflare/migrations/0001_storage.sql
printf '%s' "$WEBHOOK_SECRET" | pnpm exec wrangler secret put WEBHOOK_SECRET
printf '%s' "$TELEGRAM_BOT_TOKEN" | pnpm exec wrangler secret put TELEGRAM_BOT_TOKEN
pnpm exec wrangler deploy
```

`WEBHOOK_SECRET` 用 `openssl rand -hex 32` 生成。Telegram 只接受字母、数字、下划线和短横线。部署打印出的 `https://tasb.<子域>.workers.dev` 就是访问地址。

设置 Webhook，并确认 `/health` 与一次更新：

```sh
curl -sS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -H 'content-type: application/json' \
  -d "{\"url\":\"https://tasb.<子域>.workers.dev/telegram/webhook\",\"secret_token\":\"${WEBHOOK_SECRET}\",\"allowed_updates\":[\"message\",\"chat_member\",\"callback_query\"],\"drop_pending_updates\":true}"

curl -sS "https://tasb.<子域>.workers.dev/health"
TASB_URL="https://tasb.<子域>.workers.dev" pnpm smoke
```

`/health` 返回 `{"ok":true,"service":"tasb","deploymentMode":"self-host"}`。`pnpm smoke` 不带密钥时期望 401，带密钥的消息更新期望 200，响应里没有原文。完整说明、管理员 id 和本地预览在 [docs/deploy.md](docs/deploy.md)。

## 本地开发

```sh
pnpm check
```

`pnpm check` 会做依赖边界检查、类型检查、lint、全部测试、core 覆盖率（门槛 90%）和关键词评测。

```sh
pnpm --filter @tasb/example-minimal-pipeline test
pnpm eval
pnpm --filter @tasb/worker dev
WEBHOOK_SECRET='你的hex' pnpm smoke
```

密钥放在 `apps/worker/.dev.vars`，不要写进 `wrangler.jsonc`。生产环境用上面的 `wrangler secret put`。

## 仓库地图

```text
packages/core                 领域逻辑。零 I/O，零平台 SDK
packages/detectors-keyword    内置关键词检测器
packages/detectors-join       入群检测器
packages/detectors-rate       洪泛与重复。窗口在 isolate 内存
packages/actions              内置动作（delete / mute / ban / captcha）
packages/adapters-memory      测试用存储、策略、处罚和回复
packages/adapters-cloudflare  D1 审计 / 规则文档，KV 白名单
packages/platform-telegram    Telegram webhook 校验与 Update → Event
packages/sdk                  插件作者的测试帮手
apps/worker                   Workers 入口。self-host / cloud 共用
apps/cloud                    云服务租户模块。计费尚未实现
examples/minimal-pipeline     内存端到端例子
evals                         评测集与回归
docs                          架构、ADR、额度
```

## 许可

许可证尚未选定。在维护者确认之前，不要把本仓库当作已经采用 MIT 或其他许可证。
