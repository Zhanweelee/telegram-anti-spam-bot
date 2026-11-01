# ADR 0006：私聊管理命令

- 状态：已接受
- 日期：2026-11-01

## 背景

P0-06 要让配置中的管理员在私聊里查看规则、白名单、审计，并开关某个群的 dry-run。群聊里的斜杠文本不能改配置。回复要送到 Telegram，但 core 不能认识 Bot API。ADR 0001 把 grammY 留到命令路由确实需要它的时候。

## 决策

- 事件增加可选字段 `direct`。只有 `chat.type === "private"` 时为 true。缺省表示共享会话。
- `runOperatorCommand` 在 core 里。`direct !== true` 时直接返回 skip，不读存储、不写存储。调用方继续走检测流水线。
- 权限只看调用方传入的管理员 id 列表（Worker 的 `ADMIN_USER_IDS`），不看 `actor.isAdmin`。不在列表里的私聊命令得到固定回复「没有权限」，参数不会被抄回去。
- 已实现的命令是 `/help`、`/rules`、`/whitelist`、`/logs`、`/dryrun`。chat id 和 actor id 只接受整数形式，避免把一句垃圾文本当成 id。
- 白名单写入走 `savePolicy`：先 `put`，再覆盖同一条策略缓存，下一条消息就能看见。失败时回复「参数无效」，日志不带异常文本。
- dry-run 放在新的 `RuntimeStore`，按 tenant + chat 保存。检测时读它，读失败则照常执行动作。
- `/logs` 只拼时间、事件 id、动作、分数、规则 id 和原因。不输出证据摘要。超过 80 字符或含换行的片段写成 `redacted`。
- 回复走 `ReplyPort`。Telegram 实现是一次 `sendMessage` fetch，不用 grammY。未配置 `TELEGRAM_BOT_TOKEN` 时不发请求，Webhook 仍返回 200，日志代码是 `reply_failed`。
- Worker 的审计、策略和 dry-run 目前放在 isolate 内存里，最多留 200 条审计。D1 / KV 绑定仍是 P0-08。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 引入 grammY 做命令路由 | 五个命令的解析不值得增加依赖和包体积。传输继续用 fetch。 |
| 群里的斜杠命令只忽略、不检测 | 垃圾消息可以伪装成 `/whitelist` 绕过流水线。 |
| 把 dry-run 放进 `PrefilterPolicy` | 预过滤和处罚开关会缠在一份文档里。 |

## 后果

- 没把用户 id 写进 `ADMIN_USER_IDS` 时，没有人能改配置。
- 群消息里的命令文本仍会打分。它不会改白名单，也不会改 dry-run。
- 私聊回复在 token 配好之前只有日志，没有 Telegram 消息。
- `savePolicy` 会刷新策略缓存。只调用 `PolicyStore.put` 的其它路径仍要等 TTL。
