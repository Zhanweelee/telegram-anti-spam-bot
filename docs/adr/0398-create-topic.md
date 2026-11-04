# ADR 0398：私聊可以新建一个话题

- 状态：已接受
- 日期：2026-11-04

## 背景

管理员想在论坛超级群或私聊里新建一个话题。官方有一次创建调用。

`createForumTopic` 在论坛超级群或与用户的私聊里建一个话题。超级群里，bot 必须是管理员，并有 `can_manage_topics`。成功时返回一个 `ForumTopic`。

必填参数是 `chat_id` 和 `name`。名字长度 1 到 128 个字符。可选的 `icon_color` 只能是文档列出的六种颜色。可选的 `icon_custom_emoji_id` 要先从 `getForumTopicIconStickers` 取允许的自定义表情。

`ForumTopic` 带话题号、名字、图标颜色，以及可选的自定义表情号。名字不能进回复或日志。没有 token 时不能编一个话题号。

## 决策

- 私聊命令 `/newtopic <chatId> <name>`。群 id 匹配 `^-?\d{1,20}$`。名字是其余参数按空白折叠后拼起来的字符串。不写名字时不发出请求。长度超过 128 时不发出请求。群聊里的同样文本不执行。
- 正数编号也原样送出。私聊也可以建话题。
- 配置中的管理员可以操作任意群。接入目录里的人只能操作自己的群。
- 调用 `ModerationPort.createTopic`。适配器调用 `createForumTopic`，只带 `chat_id` 和 `name`。不送 `icon_color`，也不送 `icon_custom_emoji_id`。
- 只读取 `result.message_thread_id`。它必须是大于 0 的安全整数。话题号 `1` 原样写进回复。缺少这个字段、不是整数，或不是正数时，回复「参数无效」。
- 回复只写这个话题号，并写明其它话题还在。不写名字、图标颜色或自定义表情。
- 端口交回来的话题号如果不是不带前导零的正安全整数，回复「参数无效」，并且不把这个值写进回复。
- 没有 token、没有这个方法，编号或名字不合法，或调用失败时回复「参数无效」。日志只写 `operator_rejected`，带上 eventId、chatId 和命令名。不写异常文本、token、名字或原文。
- 没有 token 的 Worker 不编一个话题号。内存适配器同样抛出 `newtopic_unavailable`。
- 不调用 `editForumTopic`、`editGeneralForumTopic` 或 `getForumTopicIconStickers`。不修改黑名单、白名单、封禁或禁言。不读取消息正文。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 回复里重复新名字 | 名字可能是管理员刚粘贴的原文。管理员要的是话题号。 |
| 默认送一种图标颜色 | 六种颜色都是可选的。这次命令不选颜色。 |
| 先调用 `getForumTopicIconStickers` | 那一次调用返回贴纸对象，里面有文件号。这次不设置自定义表情。 |
| 没有 token 时回复话题号 1 | 管理员会以为话题已经建好。 |

## 后果

- 成功只表示 Telegram 返回了一个正整数话题号。缺少管理权限时，回复是「参数无效」。
- 回复只有话题号。其它话题还在。
- 一次创建是一次 Telegram 子请求。封禁、禁言和黑名单都不变。
- 30 天保留期不动。
