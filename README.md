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

Webhook 已经能校验 Telegram 的 `secret_token`，并把普通消息和 `chat_member` 归一化成内部事件。默认规则在 `apps/worker/rules/default.json`，某个群可以在 `chats.json` 里整份替换。热路径先读缓存，不读 D1。规则 schema 失败时该群放行。删除接口、D1 和一键部署还在后面的 P0 任务里。默认流水线不会调用 Telegram 的删除、禁言或封禁接口。规则可以写 `mute` 或 `ban`，严重度是 ban > mute > delete。

## 10 分钟跑通

需要 Node.js 22 和 pnpm 10。

```sh
pnpm install
pnpm check
```

`pnpm check` 会做依赖边界检查、类型检查、lint、全部测试、core 覆盖率（门槛 90%）和关键词评测。

只看最小例子：

```sh
pnpm --filter @tasb/example-minimal-pipeline test
pnpm eval
```

本地看 Worker：

```sh
pnpm --filter @tasb/worker dev
```

`/health` 的 `deploymentMode` 来自 Wrangler 变量，默认 `self-host`。

Webhook 密钥不要写进 `wrangler.jsonc`。在 `apps/worker/.dev.vars`（已 gitignore）里放：

```sh
WEBHOOK_SECRET=dev-secret
```

然后：

```sh
curl -s -X POST http://127.0.0.1:8787/telegram/webhook \
  -H "content-type: application/json" \
  -d '{"update_id":1}'
```

没带密钥时应为 401。带上 `X-Telegram-Bot-Api-Secret-Token: dev-secret` 且正文是一条 `message` 时为 200。生产环境用 `wrangler secret put WEBHOOK_SECRET`。

只看归一化示例：

```sh
pnpm --filter @tasb/example-telegram-webhook test
```

## 仓库地图

```text
packages/core                 领域逻辑。零 I/O，零平台 SDK
packages/detectors-keyword    内置关键词检测器
packages/actions              内置动作（目前是 delete）
packages/adapters-memory      测试用存储和处罚端口
packages/adapters-cloudflare  Cloudflare 绑定适配层（骨架）
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
