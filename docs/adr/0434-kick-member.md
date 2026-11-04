# ADR 0434：私聊可以移出还能再加入的成员

- 状态：已接受
- 日期：2026-11-04

## 背景

`/ban` 是永久封禁。在超级群和频道里，Telegram 仍会删掉这个人的历史消息。`/unban` 带 `only_if_banned`，只解除已经存在的封禁，不会把还在群里的人移出。见 ADR 0362 和 ADR 0364。

管理员从 `/logs` 看到一个人还在群里发广告，想把人移出，并让对方以后还能用邀请链接回来。这不是封禁，也不该顺手解除一份已经存在的封禁。

`unbanChatMember` 不带 `only_if_banned` 时，调用之后这个人不再是群成员，但可以再加入。人如果还在群里，也会被移出。人如果已经被封禁，同一次调用会解除封禁。

## 决策

- 私聊命令 `/kick <chatId> <actorId>`。两个 id 都要匹配 `^-?\d{1,20}$`。多出来的参数不发出请求。群聊里的同样文本不执行。
- 配置中的管理员可以操作任意群。接入目录里的人只能操作自己的群。
- 命令调用 `ModerationPort.kickActor`。配了 token 时，先调用 `getChatMember`，参数只有 `chat_id` 和 `user_id`。
- 返回的 `user.id` 必须是安全整数，并且和请求的成员号一致。名字不进入回复，也不进入日志。
- 状态是 `member` 时，再调用 `unbanChatMember`，参数只有 `chat_id` 和 `user_id`。不带 `only_if_banned`。不调用 `banChatMember`。回复已经移出。
- 状态是 `restricted` 时，缺 `is_member` 或 `is_member` 为 true，按还在群里处理，同样移出。`is_member` 为 false 时不调用第二次，回复不在群里。`is_member` 不是布尔值时，整份回复是「参数无效」，不调用 `unbanChatMember`。
- 状态是 `left` 或 `kicked` 时，不调用 `unbanChatMember`。回复不在群里。已经封禁的人仍被封禁。
- 状态是 `creator` 或 `administrator` 时，不调用 `unbanChatMember`。回复是管理员。
- 用户号对不上，或状态不认识时，整份回复是「参数无效」，不调用 `unbanChatMember`。
- 没有处罚端口、没有 token，或调用失败时，回复「参数无效」。日志是 `operator_rejected`，不写异常文本，也不写 token。
- 没有 token 的 Worker 不把这次调用记成已经移出。内存适配器只给测试和示例记录目标，并且不记进封禁或解封名单。
- 不修改黑名单、白名单、禁言、永久封禁或 `/unban`。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 先 `banChatMember` 再 `/unban` | 超级群和频道会删掉历史消息。移出不应该带上这份删除。 |
| 对任何状态都调用不带 `only_if_banned` 的 `unbanChatMember` | 已经封禁的人会被解除封禁。 |
| 给 `/unban` 增加一个参数 | ADR 0362 把 `only_if_banned` 固定为 true。移出是另一条命令。 |

## 后果

- 成功只表示 Telegram 接受了这次移出。人不会自动回到群里，可以再加入。
- 已经封禁、已经离开或是管理员时，没有第二次请求。封禁仍在。要放回来用 `/unban`。
- 一次移出最多是两次 Telegram 子请求。管理员、黑名单和禁言都不变。
- `/ban` 和 `/unban` 的请求体不变。
- 30 天保留期不动。
