# ADR 0399：私聊可以修改一个话题的名字

- 状态：已接受
- 日期：2026-11-04

## 背景

管理员想改一个已经建好的话题的名字。官方有一次同时改名字和图标的调用。

`editForumTopic` 修改论坛超级群或与用户的私聊里一个话题的名字和图标。超级群里，bot 必须是管理员并有 `can_manage_topics`，除非它是这个话题的创建者。成功时返回 True。

必填参数是 `chat_id` 和 `message_thread_id`。可选的 `name` 长度 0 到 128。不写，或者写成空字符串，都会保留现在的名字。可选的 `icon_custom_emoji_id` 不写时保留现在的图标。空字符串会去掉图标。

通用话题另有 `editGeneralForumTopic`。这次不把话题号 `1` 改写成那一次调用。

名字不能进回复或日志。没有 token 时不能把内存记录回复成已经修改。

## 决策

- 私聊命令 `/rentopic <chatId> <threadId> <name>`。群 id 匹配 `^-?\d{1,20}$`。话题号是不带前导零的正安全整数，`1` 原样送出。名字是其余参数按空白折叠后拼起来的字符串。不写名字时不发出请求。长度超过 128 时不发出请求。群聊里的同样文本不执行。
- 配置中的管理员可以操作任意群。接入目录里的人只能操作自己的群。
- 调用 `ModerationPort.renameTopic`。适配器调用 `editForumTopic`，带 `chat_id`、`message_thread_id` 和 `name`。不送 `icon_custom_emoji_id`。
- 回复不重复名字，并写明消息还在、其它话题还在。
- 没有 token、没有这个方法，编号或名字不合法，或调用失败时回复「参数无效」。日志只写 `operator_rejected`，带上 eventId、chatId 和命令名。不写异常文本、token、名字或原文。
- 没有 token 的 Worker 不把内存记录回复成已经修改。
- 不调用 `editGeneralForumTopic`、`createForumTopic` 或 `getForumTopicIconStickers`。不修改黑名单、白名单、封禁或禁言。不读取消息正文。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 不写名字时送出空字符串 | 文档写明空名字会保留现在的名字。回复不能说已经修改。 |
| 话题号 `1` 改走 `editGeneralForumTopic` | 其它话题命令把 `1` 原样送出。通用话题的改名仍是另一次调用。 |
| 回复里重复新名字 | 名字可能是管理员刚粘贴的原文。回复只确认这一次请求。 |

## 后果

- 成功只表示 Telegram 接受了这一次 `editForumTopic`。缺少权限或话题不存在时，回复是「参数无效」。
- 消息还在。其它话题还在。图标还是原来的。
- 一次修改是一次 Telegram 子请求。封禁、禁言和黑名单都不变。
- 30 天保留期不动。
