# ADR 0400：私聊可以修改通用话题的名字

- 状态：已接受
- 日期：2026-11-04

## 背景

管理员想改论坛超级群里「General」话题的名字。官方有一次只改这个话题的调用。

`editGeneralForumTopic` 修改论坛超级群里通用话题的名字。bot 必须是管理员并有 `can_manage_topics`。成功时返回 True。

必填参数是 `chat_id` 和 `name`。名字长度 1 到 128。这次调用没有 `message_thread_id`。

`/rentopic` 已经把话题号 `1` 原样送给 `editForumTopic`。这次不把通用话题改名改写成那一次调用。

名字不能进回复或日志。没有 token 时不能把内存记录回复成已经修改。

## 决策

- 私聊命令 `/rengeneral <chatId> <name>`。群 id 匹配 `^-?\d{1,20}$`。名字是其余参数按空白折叠后拼起来的字符串。不写名字时不发出请求。长度超过 128 时不发出请求。群聊里的同样文本不执行。
- 配置中的管理员可以操作任意群。接入目录里的人只能操作自己的群。
- 调用 `ModerationPort.renameGeneral`。适配器调用 `editGeneralForumTopic`，只带 `chat_id` 和 `name`。不送 `message_thread_id`。
- 回复不重复名字，并写明其它话题还在、消息还在。
- 没有 token、没有这个方法，群号或名字不合法，或调用失败时回复「参数无效」。日志只写 `operator_rejected`，带上 eventId、chatId 和命令名。不写异常文本、token、名字或原文。
- 没有 token 的 Worker 不把内存记录回复成已经修改。
- 不调用 `editForumTopic`、`createForumTopic` 或 `getForumTopicIconStickers`。不修改黑名单、白名单、封禁或禁言。不读取消息正文。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 把话题号 `1` 送给 `editForumTopic` | 通用话题另有一次调用。`/rentopic` 已经把 `1` 原样送出。 |
| 省略名字 | `name` 是必填的，长度 1 到 128。 |
| 回复里重复新名字 | 名字可能是管理员刚粘贴的原文。回复只确认这一次请求。 |

## 后果

- 成功只表示 Telegram 接受了这一次 `editGeneralForumTopic`。缺少权限或这个群不是论坛时，回复是「参数无效」。
- 其它话题还在。消息还在。
- 一次修改是一次 Telegram 子请求。封禁、禁言和黑名单都不变。
- 30 天保留期不动。
