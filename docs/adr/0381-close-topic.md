# ADR 0381：私聊可以关闭论坛话题

- 状态：已接受
- 日期：2026-11-04

## 背景

`/untopic` 只撤下话题里的置顶。话题仍然开着，新人还可以继续往里面发消息。诈骗话题钉完之后，下一步是让这个话题不再接收新消息。

官方 `closeGeneralForumTopic` 关闭通用话题。参数只有 `chat_id`。`closeForumTopic` 关闭一个指定话题，还要 `message_thread_id`。两边都要求 bot 是管理员，并且有 `can_manage_topics`。指定话题的创建者可以没有这项权限。成功时返回 True。

这两次调用都不删除消息，也不撤置顶。隐藏通用话题是另一条方法，它会顺带把还开着的通用话题关掉。

没有 token 时，内存适配器可以把这次请求记下来。私聊如果复用这次成功，回复会写成话题已经关闭。

## 决策

- 私聊命令 `/closetopic <chatId> [threadId]`。群 id 匹配 `^-?\d{1,20}$`。话题号和消息号使用同一条规则：`/^[1-9]\d{0,15}$/`，并且是安全整数。群聊里的同样文本不执行。
- 配置中的管理员可以操作任意群。接入目录里的人只能操作自己的群。
- 不带话题号时调用 `ModerationPort.closeTopic`，不带 `threadId`。适配器调用 `closeGeneralForumTopic`。
- 带话题号时，同一次请求调用 `closeForumTopic`，只带这个 `message_thread_id`。不把 `1` 改写成通用话题的方法。
- 不调用 `hideGeneralForumTopic`、`unpinAllForumTopicMessages`、`unpinAllGeneralForumTopicMessages` 或 `deleteForumTopic`。不带消息号。
- 回复写明消息还在。不带话题号时写明其它话题不在这次里。
- 没有 token、没有这个方法，话题号不合法，或调用失败时回复「参数无效」。日志只写 `operator_rejected`，带上 eventId、chatId 和命令名。不写异常文本或 token。
- 没有 token 的 Worker 不把内存里的记录回复成已经成功。
- 不修改黑名单、白名单、封禁或禁言。不读取消息正文。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 把话题号 `1` 当成通用话题 | 通用话题有自己的方法，不接收话题号。两条接口的范围官方是分开写的。 |
| 关闭时顺带隐藏通用话题 | `hideGeneralForumTopic` 会先把开着的通用话题关掉，范围比这一次更大。 |
| 关闭时删除话题和消息 | `deleteForumTopic` 会删掉这个话题里的全部消息。删除仍走 `/delete` 和 `/deletes`。 |
| 回复写成消息已经不在 | 成功只表示这个话题被关掉。消息正文还在。 |
| 没有 token 时也回复「已关闭」 | 话题还开着。管理员会以为新人已经发不进来。 |

## 后果

- 成功只表示 Telegram 接受了这一次关闭。缺少 `can_manage_topics`，或这个群不是论坛时，回复是「参数无效」。指定话题的创建者可以没有这项权限，由 Telegram 判断。
- 不带话题号时，其它话题还开着。带话题号时，通用话题和别的话题还开着。置顶也不在这次里。
- 一次关闭是一次 Telegram 子请求。封禁、禁言和黑名单都不变。
- 30 天保留期不动。
