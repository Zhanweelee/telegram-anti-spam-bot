# ADR 0520：自定义表情贴纸按群删除

- 状态：已接受
- 日期：2026-11-05

## 背景

群里发出的自定义表情可以是一条贴纸。`sticker.custom_emoji_id` 和看得见的正文不是同一件事。`custom_emoji` 只看消息实体和富文本，看不见这张贴纸。`media_sticker` 会把普通贴纸一起删掉。

贴纸包名和关联的表情字符仍不进事件。

## 决策

- `message.sticker.custom_emoji_id` 去掉空白后非空时，事件带 `asStickerEmoji: true`。
- 空白、空字符串、布尔值和缺编号不带这个标记。普通贴纸不带。遮罩贴纸不带。按钮图标不带。正文里的自定义表情不带。礼物型号不带。论坛话题图标不带。日期时间不带。
- 编号不进事件，也不进证据。贴纸包名和关联表情不进事件。已有 `text` 或 `caption` 时正文不变。没有正文时正文仍是空字符串。
- 这条消息的 `media` 仍是 `sticker`。
- 检测器在 `@tasb/detector-emoji-sticker`，id 是 `sticker_emoji`。只在 `message.asStickerEmoji` 为 true 时返回 score 1。证据是 `sticker:sticker_emoji`。
- 默认规则关闭。私聊 `/rule <chatId> sticker_emoji on` 之后删除这种贴纸，`off` 回到留下。
- 不并进 `custom_emoji`。不并进 `media_sticker`。付费帖仍不删除。
- 不新增命令。菜单仍是 99 条。
- 不改 ADR 0026 的基础检测器名单。`sticker_emoji` 不在里面。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 把编号接到正文后面 | 同一条消息的哈希会变，编号也会进事件。 |
| 把编号写进证据 | 编号不进事件。 |
| 并进自定义表情 | 只想删正文表情的群会把这种贴纸也删掉。 |
| 并进贴纸锁 | 只想删表情贴纸的群会把普通贴纸也删掉。 |
| 默认打开 | 有的群会发表情贴纸。打开之前不改现有群。 |
| 新命令 `/emoji` | 菜单还剩 1 个位置，留给以后的操作命令。 |

## 后果

- 规则关闭时，自定义表情贴纸留下。普通贴纸仍由 `media_sticker` 决定。编号仍不进事件。
- 打开 `sticker_emoji` 后，这个群里的这种贴纸会删除。打开 `custom_emoji` 仍不删除它。打开 `media_sticker` 仍会删除它，因为它仍是贴纸。付费帖仍留下。
- 自部署没有额度，打开后就会删除。云模式超过当月次数后，还要把 `sticker_emoji` 写进 `QUOTA_BASIC`，否则超额时这条规则会停。
- `chats.json` 整份替换的群要自己加上 `sticker_emoji`，否则 `/rule` 会拒绝。
- 30 天保留期没有改。
