# ADR 0425：私聊可以查看能否更换群贴纸包

- 状态：已接受
- 日期：2026-11-04

## 背景

更换或删除群贴纸包之前，官方文档要求先看 `getChat` 返回的 `can_set_sticker_set`。这个字段是可选的 `True`：返回 `true` 才表示这个 bot 可以调用 `setChatStickerSet` 和 `deleteChatStickerSet`。

`/stickers` 和 `/delstickers` 已经是这两次写入。贴纸包名字和自定义表情贴纸包名字可能带原文，不进这次回复。

## 决策

- 私聊命令 `/canstickers <chatId>`。群 id 匹配 `^-?\d{1,20}$`。多出来的参数不发出请求。群聊里的同样文本不执行。
- 配置里的管理员可以看任意群。接入目录里的人只能看自己的群。
- 调用 `ModerationPort.readStickerSetRight`。适配器调用 `getChat`，只带 `chat_id`。
- 回复两行：群号、能否更换贴纸包。缺字段写未知。`true` 写 on，`false` 写 off。
- 不是布尔值，或返回的群号和请求不一致时，整份回复是「参数无效」，不露出已经读到的字段。
- 贴纸包名字、自定义表情贴纸包名字、标题和邀请链接不进回复，也不进日志。
- 日志只写 `operator_rejected` 或命令名，带上 eventId、chatId 和命令名 `canstickers`。不写名字、异常文本或 token。
- 没有 token 的 Worker 不编一个开关。
- 不调用 `setChatStickerSet` 或 `deleteChatStickerSet`，也不改黑名单、封禁或禁言。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 并进 `/guard` | `/guard` 已经是一长串开关。能否更换贴纸包是另一件事。 |
| 并进 `/stickers` | `/stickers` 是写入。先看开关不应该顺带改贴纸包。 |
| 缺字段写成 off | 文档把这个字段标成可选。没返回和明确不能更换不是同一件事。 |

## 后果

- 成功只表示 Telegram 返回了这个 bot 当前能否更换该群的贴纸包，或这个字段没有返回。
- 一次查看是一次 Telegram 子请求。`/stickers` 和 `/delstickers` 仍是各自的写入。封禁、禁言和黑名单都不变。
- 30 天保留期不动。
