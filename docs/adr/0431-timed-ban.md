# ADR 0431：私聊可以限时封禁一个成员

- 状态：已接受
- 日期：2026-11-04

## 背景

`/ban` 按 ADR 0364 调用 `banChatMember`，不带 `until_date`，所以是永久封禁。`/mute` 已经能按秒数限制发言。管理员有时只想把一个人请出群一段时间，到期后 Telegram 自己解除。

`banChatMember` 的 `until_date` 是 Unix 时间。官方说明里，距离现在短于 30 秒或长于 366 天的封禁会被当成永久，并且只对超级群和频道生效。`revoke_messages` 在超级群和频道上始终为 true。ADR 0020 和 ADR 0364 把请求里的 `revoke_messages` 固定为 false。

没有 token 时，流水线的 `banActor` 记在内存里。限时封禁如果复用这次成功，回复会写成已经封禁。

## 决策

- 私聊命令 `/banfor <chatId> <actorId> <seconds>`。两个 id 都要匹配 `^-?\d{1,20}$`。秒数必须写出，并且是 30 到 `366 * 24 * 60 * 60` 之间的整数。少了、多了、不是这个形式，或多出来的参数，都不发出请求。群聊里的同样文本不执行。
- 配置中的管理员可以操作任意群。接入目录里的人只能操作自己的群。
- 命令调用 `ModerationPort.banActorFor`。配了 token 时，Telegram 适配器调用 `banChatMember`，参数是 `chat_id`、`user_id`、`revoke_messages: false` 和 `until_date`。`until_date` 是当前秒加上这段时长。
- 永久 `/ban` 仍只调用 `banActor`，请求里不带 `until_date`。
- 没有 token、没有这个方法，或调用失败时回复「参数无效」。日志只写 `operator_rejected`，带上 eventId、chatId 和命令名。不写异常文本、token 或姓名。
- 没有 token 的 Worker 不把内存里的限时封禁记录回复成已经成功。流水线在没有 token 时仍按 ADR 0020 把永久封禁记在内存里。限时封禁单独记一份，不写进永久封禁名单。
- 不修改黑名单、白名单或禁言。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 给 `/ban` 增加可选秒数 | 少写秒数的人会从永久封禁变成限时封禁，或者反过来。两条命令的回复要对得上各自的请求。 |
| 把短于 30 秒或长于 366 天的秒数收成永久 | Telegram 会把这种 `until_date` 当成永久。回复却写着一段秒数，管理员会以为到期会解除。 |
| 没有 token 时也回复「已限时封禁」 | 人还在群里。管理员会以为封禁已经生效。 |
| 顺带把 `revoke_messages` 设为 true | 会要求删掉历史消息。ADR 0004 要求 ban 不隐含 delete。 |

## 后果

- 到期后由 Telegram 解除。`/unban` 仍可提前解除。人要自己再加入。
- 超级群和频道上，Telegram 仍可能删掉这个人的历史消息。请求里的 `revoke_messages` 保持 false。
- 一次限时封禁是一次 Telegram 子请求。
- 30 天保留期不动。
