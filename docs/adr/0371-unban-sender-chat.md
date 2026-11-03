# ADR 0371：私聊可以解除频道代发禁止

- 状态：已接受
- 日期：2026-11-04

## 背景

`/bansender` 调用 `banChatSenderChat`。官方说明：直到这次禁止被解除，被禁频道的主人不能再以名下任何频道代发。见 ADR 0370。管理员要解除时，仍然要打开 Telegram。

官方 `unbanChatSenderChat` 解除一个先前被禁止的频道聊天。bot 必须是该超级群或频道的管理员，并有相应的管理员权限。成功时返回 True。参数只有 `chat_id` 和 `sender_chat_id`。

`/unban` 调用的是 `unbanChatMember`，带 `only_if_banned`，解的是用户封禁。

没有 token 时，内存适配器可以把一次解除记下来。私聊如果复用这次成功，回复会写成已经解除。

## 决策

- 私聊命令 `/unbansender <chatId> <senderChatId>`。两个 id 都匹配 `^-?\d{1,20}$`。群聊里的同样文本不执行。
- 配置中的管理员可以操作任意群。接入目录里的人只能操作自己的群。
- 命令调用 `ModerationPort.unbanSenderChat`，只带 tenant、chat 和 senderChat。适配器调用 `unbanChatSenderChat`。不调用 `unbanChatMember`，不带 `user_id`，也不带 `only_if_banned`。
- 不读取频道标题或消息原文。内存记录只留 tenant、chat 和 senderChat。
- 没有 token、没有这个方法，或调用失败时回复「参数无效」。日志只写 `operator_rejected`，带上 eventId、chatId 和命令名。不写异常文本、token 或标题。
- 没有 token 的 Worker 不把内存里的记录回复成已经成功。
- 不修改黑名单、白名单、用户封禁或禁言。不解除另一个频道号上的禁止。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 复用 `/unban` 和 `unbanChatMember` | 用户解封解不开频道代发禁止。`only_if_banned` 也不属于这个方法。 |
| 回复成频道主人的全部分频道都已放开 | 另一个频道号上的禁止还在。这次调用只解除这一条。 |
| 没有 token 时也回复「已解除」 | 禁止可能还在。管理员会以为 Telegram 已经解除。 |

## 后果

- 成功只表示 Telegram 接受了这一次 `unbanChatSenderChat`。bot 缺少权限时，回复是「参数无效」。
- 这一条代发禁止被解除。另一个频道号上的禁止仍留着。用户封禁和禁言不变。
- 一次解除是一次 Telegram 子请求。
- 30 天保留期不动。
