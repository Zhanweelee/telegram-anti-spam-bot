# ADR 0370：私聊可以禁止一个频道代发

- 状态：已接受
- 日期：2026-11-04

## 背景

`/ban` 调用 `banChatMember`，封的是用户。频道可以用自己的身份往超级群里发消息。官方 `banChatSenderChat` 禁止的是这个发送者聊天：bot 必须是该超级群或频道的管理员，并有相应的管理员权限。成功时返回 True。参数只有 `chat_id` 和 `sender_chat_id`。

官方还写明：直到这次禁止被解除，被禁频道的主人不能再以名下任何频道代发。这比封一个用户更大。

没有 token 时，内存适配器可以把一次禁止记下来。私聊如果复用这次成功，回复会写成已经禁止。

## 决策

- 私聊命令 `/bansender <chatId> <senderChatId>`。两个 id 都匹配 `^-?\d{1,20}$`。群聊里的同样文本不执行。
- 配置中的管理员可以操作任意群。接入目录里的人只能操作自己的群。
- 命令调用 `ModerationPort.banSenderChat`，只带 tenant、chat 和 senderChat。适配器调用 `banChatSenderChat`。不调用 `banChatMember`，不带 `user_id`，也不带 `revoke_messages`。
- 回复写明：直到解除，该频道主人不能再以名下任何频道代发。
- 不读取频道标题或消息原文。内存记录只留 tenant、chat 和 senderChat。
- 没有 token、没有这个方法，或调用失败时回复「参数无效」。日志只写 `operator_rejected`，带上 eventId、chatId 和命令名。不写异常文本、token 或标题。
- 没有 token 的 Worker 不把内存里的记录回复成已经成功。流水线在没有 token 时仍按 ADR 0020 把删除、禁言和用户封禁记在内存里。这条命令不进入检测流水线，也不改转发检测器。
- 不修改黑名单、白名单、用户封禁或禁言。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 复用 `/ban` 和 `banChatMember` | 用户封禁封不住频道代发。两个方法的参数也不一样。 |
| 顺带删除这个频道已经发出的消息 | 官方这个方法没有 `revoke_messages`。删消息仍走 `/delete`。 |
| 命中转发规则时自动禁止频道 | 会把讨论组或关联频道一起挡住。先留给管理员手工执行。 |
| 没有 token 时也回复「已禁止」 | 频道可能还在代发。管理员会以为 Telegram 已经禁止。 |

## 后果

- 成功只表示 Telegram 接受了这一次 `banChatSenderChat`。bot 缺少权限，或目标不是可禁止的发送者聊天时，回复是「参数无效」。
- 直到解除，该频道主人不能再以名下任何频道代发。现有消息还在。用户封禁和禁言不变。解除走私聊 `/unbansender`，见 ADR 0371。
- 一次禁止是一次 Telegram 子请求。
- 30 天保留期不动。
