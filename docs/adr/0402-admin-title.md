# ADR 0402：私聊可以设置一个管理员头衔

- 状态：已接受
- 日期：2026-11-04

## 背景

管理员想给超级群里一个管理员换一个短头衔，或把头衔清掉，同时不动权限。官方有一次只改头衔的调用。

`setChatAdministratorCustomTitle` 给超级群里一个由本 bot 提升的管理员设置自定义头衔。成功时返回 True。

必填参数是 `chat_id`、`user_id` 和 `custom_title`。头衔长度 0 到 16，不能用 emoji。

这条调用不提升管理员，也不改成员标签。头衔不能进回复或日志。没有 token 时不能把内存记录回复成已经设置。

## 决策

- 私聊命令 `/admintitle <chatId> <userId> [title]`。群 id 和用户 id 匹配 `^-?\d{1,20}$`。头衔是其余参数按空白折叠后拼起来的字符串。少一个编号不发出请求。群聊里的同样文本不执行。
- 折叠后的长度要落在 0 到 16。超过 16 个字符不发出请求。
- 不写头衔时送出空字符串。请求里始终带 `custom_title`。
- 配置中的管理员可以操作任意群。接入目录里的人只能操作自己的群。
- 调用 `ModerationPort.setAdminTitle`。适配器调用 `setChatAdministratorCustomTitle`，带 `chat_id`、`user_id` 和 `custom_title`。
- 回复不重复头衔，并写明权限还在。
- 没有 token、没有这个方法，编号或头衔不合法，或调用失败时回复「参数无效」。日志只写 `operator_rejected`，带上 eventId、chatId 和命令名。不写异常文本、token、头衔或原文。
- 没有 token 的 Worker 不把内存记录回复成已经设置。
- 不调用 `promoteChatMember`、`setChatMemberTag` 或 `getChat`。不修改黑名单、白名单、封禁或禁言。不读取消息正文。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 省略 `custom_title` 表示清掉 | 这个参数是必填的。空字符串已经在 0–16 里。 |
| 先调用 `promoteChatMember` | 提升会改权限。这次只改头衔。目标不是本 bot 提升的管理员时，由 Telegram 返回失败。 |
| 在本地判断 emoji | 文档只说不能用 emoji，没有给出码位表。含 emoji 时，由 Telegram 返回失败。 |
| 回复里重复头衔 | 头衔可能是管理员刚粘贴的原文。回复只确认这一次请求。 |

## 后果

- 成功只表示 Telegram 接受了这一次 `setChatAdministratorCustomTitle`。目标不是本 bot 提升的管理员、头衔含 emoji，或缺少权限时，回复是「参数无效」。
- 权限还在。成员标签还在。
- 一次设置是一次 Telegram 子请求。封禁、禁言和黑名单都不变。
- 30 天保留期不动。
