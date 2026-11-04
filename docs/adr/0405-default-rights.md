# ADR 0405：私聊可以设置这个 bot 的默认管理员权限

- 状态：已接受
- 日期：2026-11-04

## 背景

bot 被加为管理员时，Telegram 会建议一份默认权限。用户在加入前仍可修改。官方调用是 `setMyDefaultAdministratorRights`。

参数 `rights` 可选。不送 `rights` 会清掉默认权限。`for_channels` 为 true 时改的是频道。不送时改的是群和超级群。

这不会立刻提升某个成员，也不会改已经加入的群。`promoteChatMember` 仍不提供。

## 决策

- 私聊命令 `/myrights [channels] <clear|right...>`。第一个参数是 `channels` 时改频道，否则改群和超级群。`clear` 单独出现时不送 `rights`。其余参数是权限名。群聊里的同样文本不执行。
- 权限名是 `anonymous`、`manage_chat`、`delete_messages`、`manage_video_chats`、`restrict_members`、`promote_members`、`change_info`、`invite_users`、`post_stories`、`edit_stories`、`delete_stories`、`post_messages`、`edit_messages`、`pin_messages`、`manage_topics`、`manage_direct_messages`、`manage_tags`、`send_welcome_messages`。点名的送 true，没点名的送 false。十八项全部送出。
- 不认识的名字、重复的名字，或 `clear` 和其它名字混在一起，都不发出请求。
- 只有配置里的管理员可以改。接入目录里的人即使管着自己的群也不能改。这是 bot 自己的默认值，不是某一个群的设置。
- 调用 `ModerationPort.setDefaultRights`。适配器调用 `setMyDefaultAdministratorRights`。频道才带 `for_channels: true`。
- 回复不重复权限名。设置时写明加入前仍可修改。清掉和设置都写明已有群不受影响。
- 没有 token、没有这个方法，或调用失败时回复「参数无效」。日志只写 `operator_rejected`，带上 eventId、chatId 和命令名 `myrights`。不写异常文本、token 或原文。
- 没有 token 的 Worker 不把内存记录回复成已经设置。
- 不调用 `promoteChatMember` 或 `getMyDefaultAdministratorRights`。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 只送点名的 true | 省略的布尔值可能被 Telegram 补成另一套默认。十八项写全，请求本身就是完整说明。 |
| 用全 false 表示清掉 | 官方写明不送 `rights` 才是清掉。全 false 是另一份明确的默认值。 |
| 接入目录里的群管理员也能改 | 这会改这个 bot 以后加入任何群时的建议权限，不是某一个群的设置。 |
| 同时提供读取命令 | 读取是另一条调用。这一次只设置或清掉。 |

## 后果

- 成功只表示 Telegram 接受了这一次 `setMyDefaultAdministratorRights`。已有群的管理员权限不变。以后把 bot 加为管理员时，对方仍可改这份建议。
- 一次设置是一次 Telegram 子请求。封禁、禁言和黑名单都不变。
- 30 天保留期不动。
