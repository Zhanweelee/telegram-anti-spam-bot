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
| 看插件清单怎么准入 | [examples/plugin-manifest](examples/plugin-manifest) |
| 部署到自己的 Cloudflare | [docs/deploy.md](docs/deploy.md) |
| 看哪些字会进检测 | [docs/message-surface.md](docs/message-surface.md) |

默认会处理关键词、短链、裸 IP、邀请链接、频道转发、洪泛和重复消息。新成员先验证。消息原文不落盘。配置里的管理员在私聊用 `/help` 管理规则、白名单、日志、额度和已接入的群。群聊里的同样文本继续检测。配了 `TELEGRAM_BOT_TOKEN` 之后，删除、禁言和封禁会发给 Telegram。哪些字会进检测，见 [docs/message-surface.md](docs/message-surface.md)。

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
  -d "{\"url\":\"https://tasb.<子域>.workers.dev/telegram/webhook\",\"secret_token\":\"${WEBHOOK_SECRET}\",\"allowed_updates\":[\"message\",\"edited_message\",\"chat_member\",\"chat_join_request\",\"callback_query\",\"my_chat_member\"],\"drop_pending_updates\":true}"

curl -sS "https://tasb.<子域>.workers.dev/health"
TASB_URL="https://tasb.<子域>.workers.dev" pnpm smoke
```

`/health` 返回 `{"ok":true,"service":"tasb","deploymentMode":"self-host"}`。`pnpm smoke` 不带密钥时期望 401，带密钥的消息更新期望 200，响应里没有原文。完整说明、管理员 id 和本地预览在 [docs/deploy.md](docs/deploy.md)。

## 本地开发

```sh
pnpm check
```

`pnpm check` 会做依赖边界检查、README 与部署说明的入口检查、类型检查、lint、全部测试和 core 覆盖率（门槛 90%）。关键词评测是单独的 `pnpm eval`。

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
packages/detectors-regex      正则检测器。默认关闭，证据只记 regex:hit
packages/detectors-forward     转发来源。默认删除频道转发
packages/detectors-join       入群检测器
packages/detectors-rate       洪泛与重复。窗口在 isolate 内存。无正文的文件、没有说明的富文本媒体和付费媒体按摘要计重复
packages/detectors-link       短链接、裸 IP、邀请。折叠规则见 docs/message-surface.md
packages/detectors-blocklist  跨群黑名单。默认关闭，只存标识或哈希。配了 KV 后留在 POLICY_KV
packages/actions              内置动作（delete / mute / ban / captcha）
packages/adapters-memory      测试用存储、策略、处罚和回复
packages/adapters-cloudflare  D1 审计 / 规则文档，KV 白名单
packages/platform-telegram    Telegram webhook 校验与 Update → Event。可见字段见 docs/message-surface.md
packages/sdk                  插件作者的测试帮手
apps/worker                   Workers 入口。self-host / cloud 共用
apps/cloud                    云租户模块。免费额度配置在这里，支付未实现
examples/minimal-pipeline     内存端到端例子
evals                         评测集与回归
docs                          架构、ADR、额度
```

## 许可

许可证尚未选定。在维护者确认之前，不要把本仓库当作已经采用 MIT 或其他许可证。
