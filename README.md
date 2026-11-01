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

Webhook 已经能校验 Telegram 的 `secret_token`，并把普通消息、编辑后的消息和 `chat_member` 归一化成内部事件。编辑后的消息走同一套规则。见 ADR 0022。默认规则在 `apps/worker/rules/default.json`，某个群可以在 `chats.json` 里整份替换。热路径先读缓存，不读 D1。规则 schema 失败时该群放行。白名单和管理员豁免按租户和群存放；没有记录时仍豁免管理员，某个群可以关掉豁免。配了 KV 之后白名单进 KV，配了 D1 之后审计和入群挑战进 D1。两个绑定都可以不填，那时数据留在 isolate 内存里。配置中的管理员可以在私聊使用 `/help`、`/rules`、`/rule`、`/whitelist`、`/logs`、`/dryrun`、`/export`、`/forget`、`/blocklist`。`/rule` 只改某一个群某一条规则的启用状态。文件规则仍是底稿。没配 `POLICY_KV` 时开关在内存里，重启后回到文件里的 `enabled`。配了之后和 dry-run 一起留在这份 KV 里。见 ADR 0034 和 ADR 0035。群聊里的这些文本不会改配置。配了 `TELEGRAM_BOT_TOKEN` 之后，删除、禁言和封禁各发一次 Telegram 请求。没有 token 时只记在内存里。见 ADR 0020。规则可以写 `log` 或 `report`。上报只含标识和 reason，默认规则不自动发给管理员。见 ADR 0021。规则可以写 `mute` 或 `ban`，严重度是 ban > mute > delete > captcha。新成员入群后，在点「我不是机器人」之前不能发言。昵称、姓氏或用户名里出现关键词时直接封禁，不发验证按钮，日志不含昵称。见 ADR 0028。从群外加入的其它 bot 会被封禁，用户名不进事件。已经在群里的 bot 被提升时保留。见 ADR 0031。共享名片会被删掉。电话、姓名和 vCard 不进事件。见 ADR 0032。经 inline bot 发出的消息默认保留。把规则 `via_inline` 打开后会删除，bot 用户名不进事件。见 ADR 0033。按钮回调要能送到 bot，`allowed_updates` 需要包含 `callback_query`。没有 bot token 时不会限制这个人。同一人 10 秒内第 5 条消息，或同一内容哈希 60 秒内第 3 次，会被删掉。这个计数在 isolate 内存里，超额时跳过，不拖住请求。见 ADR 0010。短链接和裸 IP 会被删掉。普通网址默认保留。信誉查询不在热路径上，超时就放过。见 ADR 0011。正文里看不见的 text_link 只贡献主机名，路径和查询不会进入事件。见 ADR 0029。`t.me`、`telegram.me`、`telegram.dog` 上的 `+`、`joinchat`、`addlist` 邀请会删掉，证据只有 `invite:` 加主机名。公开的 `t.me/名字` 保留。见 ADR 0030。跨群黑名单默认关闭。打开后只共享 actor id 或内容哈希，关掉后下一条消息不再读共享名单。见 ADR 0012。私聊里还可以用 `/blocklist`。`/appeal` 把一条审计标成误判或确认，样本进入审核队列，不改规则。见 ADR 0014。`/evals` 把这些样本导出成评测文档，只有哈希、特征和 spam/ham 标签。见 ADR 0016。LLM 分类默认关闭，也不绑定 Workers AI。打开后额度错误或超时会跳过。见 ADR 0015。正则检测默认关闭。模式在创建时限定长度和量词，命中只记 `regex:hit`。见 ADR 0023。频道转发默认删除，事件里只有类别，没有频道名。转载群可以关掉规则 `channel_forward`。用户转发默认保留。见 ADR 0025。同一群 10 秒内超过 30 条更新时，webhook 返回 200 并且不再检测，避免 Telegram 重试把免费请求额度打满。见 ADR 0024。云模式默认每群每个 UTC 自然月 3000 次检测，超额只留基础规则。自部署默认关闭。管理员私聊 `/quota <chatId>` 只读已用次数。状态行末尾带窗口结束时间。超额时下一行列出基础检测器 id，名单仍是 ADR 0026 的默认值。见 ADR 0026、ADR 0042 和 ADR 0043。把 bot 拉进群并设为管理员后，操作者可以在私聊管理该群，`/chats` 列出群 id。额度打开时每一行带上已用次数和上限，查看不计数；名单放不下私聊时末尾是 `+` 和省略条数。没打开时仍只有群 id。没配 `POLICY_KV` 时这份目录在内存里，重启后要等下一次管理员变更。配了之后目录留在同一份 KV 里，不含群名。见 ADR 0027、ADR 0036 和 ADR 0045。拦截率、动作计数、检测器错误和存储失败从日志汇总，标签只有租户 id 和群 id。见 ADR 0017。外部插件要有完整性摘要和签名。自部署可以显式允许未签名插件，公共 bot 不可以。见 ADR 0018。规则包默认不订阅。私聊 `/packs` 打开后，刷新失败会沿用上一份通过校验的规则。配了 `POLICY_KV` 时订阅指针和上一份通过校验的规则都留在这份 KV 里。规则没变不写，超过 16384 个字符不写。订阅后私聊 `/rules` 列出正在执行的规则，标题带上 pack id，每一行标明 `file` 或 `switch`。超额后，不在基础检测器里的规则会标上 `paused`，标题末尾带上窗口结束时间。见 ADR 0019、ADR 0037、ADR 0038、ADR 0039、ADR 0040、ADR 0041、ADR 0044 和 ADR 0046。命令回复默认中文。`vars` 里写 `LOCALE=en` 后改成英文。见 ADR 0013。

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
  -d "{\"url\":\"https://tasb.<子域>.workers.dev/telegram/webhook\",\"secret_token\":\"${WEBHOOK_SECRET}\",\"allowed_updates\":[\"message\",\"edited_message\",\"chat_member\",\"callback_query\",\"my_chat_member\"],\"drop_pending_updates\":true}"

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
packages/detectors-regex      正则检测器。默认关闭，证据只记 regex:hit
packages/detectors-forward     转发来源。默认删除频道转发
packages/detectors-join       入群检测器
packages/detectors-rate       洪泛与重复。窗口在 isolate 内存。无正文的文件按摘要计重复
packages/detectors-link       短链接、裸 IP、可选信誉源。按钮网址解析前折叠，点状间隔号、一层间隔号编码、全角拉丁字母、七个西里尔字母、乌克兰语 і、%2E、%2F、%2B 和两层字母 %HH 收成原字符。夹在标签里的其余西里尔、希腊、亚美尼亚文和非 ASCII 拉丁字母会去掉。`[.]`、`(.)`、`{.}` 和一层 `%5B.%5D` 收成点。旁路纯文本走和正文相同的主机折叠。`tg://join` 和 `tg://addlist` 记成 `t.me` 邀请
packages/detectors-blocklist  跨群黑名单。默认关闭，只存标识或哈希。配了 KV 后留在 POLICY_KV
packages/actions              内置动作（delete / mute / ban / captcha）
packages/adapters-memory      测试用存储、策略、处罚和回复
packages/adapters-cloudflare  D1 审计 / 规则文档，KV 白名单
packages/platform-telegram    Telegram webhook 校验与 Update → Event。没有正文时用题干、标题、文件名、表演者、按钮文字、富文本、手动引用、礼物附言、论坛话题名、后加的投票选项、清单任务、付费视频文件名、隐藏转发显示名或作者签名。复制句子、富文本、投票、投票媒体链接、投票媒体文件名和场馆、清单、游戏、账单、链接预览、场馆地址、场馆标题、游戏标题、账单标题、投票题干、奖品说明、清单标题、文件名、音频标题、表演者、手动引用、按钮文字、礼物附言、论坛话题名、后加的投票选项、清单任务、付费视频文件名、隐藏转发显示名和作者签名里的网址只留主机名
packages/sdk                  插件作者的测试帮手
apps/worker                   Workers 入口。self-host / cloud 共用
apps/cloud                    云租户模块。免费额度配置在这里，支付未实现
examples/minimal-pipeline     内存端到端例子
evals                         评测集与回归
docs                          架构、ADR、额度
```

## 许可

许可证尚未选定。在维护者确认之前，不要把本仓库当作已经采用 MIT 或其他许可证。
