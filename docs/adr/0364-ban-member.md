# ADR 0364：私聊可以封禁一个成员

- 状态：已接受
- 日期：2026-11-04

## 背景

规则命中之后会调用 `banChatMember`。管理员从 `/logs` 看到一个 actor id，仍然要到 Telegram 客户端里封禁。`/blocklist` 只在下一次检测时生效，人可以继续留在群里。`/unban` 已经能解除封禁，对面的封禁命令还没有。

`banChatMember` 的官方说明：调用之后，超级群和频道里的人不能自己再加入，除非先解除封禁。`until_date` 不传就是永久封禁。`revoke_messages` 为 true 会删掉这个人的历史消息；超级群和频道上这个参数始终为 true。ADR 0020 把自动封禁的 `revoke_messages` 固定为 false，并且不带 `until_date`。

没有 token 时，流水线的 `banActor` 记在内存里。私聊如果复用这次成功，回复会写成已经封禁。

## 决策

- 私聊命令 `/ban <chatId> <actorId>`。两个 id 都要匹配 `^-?\d{1,20}$`。群聊里的同样文本不执行。
- 配置中的管理员可以操作任意群。接入目录里的人只能操作自己的群。
- 命令调用 `ModerationPort.banActor`。配了 token 时，Telegram 适配器仍调用 `banChatMember`，参数只有 `chat_id`、`user_id` 和 `revoke_messages: false`。
- 没有 token、没有这个方法，或调用失败时回复「参数无效」。日志只写 `operator_rejected`，带上 eventId、chatId 和命令名。不写异常文本、token 或姓名。
- 没有 token 的 Worker 不把内存里的封禁记录回复成已经成功。流水线在没有 token 时仍按 ADR 0020 记在内存里。
- 不修改黑名单、白名单或禁言。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 没有 token 时也回复「已封禁」 | 人还在群里。管理员会以为封禁已经生效。 |
| 顺带把 `revoke_messages` 设为 true | 会要求删掉历史消息。ADR 0004 要求 ban 不隐含 delete。 |
| 先加入黑名单 | 黑名单是另一份名单。`/unban` 也不改它。 |

## 后果

- 误封之后仍用 `/unban` 解除。人要自己再加入。
- 超级群和频道上，Telegram 仍可能删掉这个人的历史消息。请求里的 `revoke_messages` 保持 false。
- 限时封禁是另一条命令 `/banfor`，见 ADR 0431。这条永久封禁仍不带 `until_date`。
- 一次封禁是一次 Telegram 子请求。
- 30 天保留期不动。
