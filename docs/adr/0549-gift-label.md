# ADR 0549：独特礼物收藏名也走关键词和默认正则

- 状态：已接受
- 日期：2026-11-05

## 背景

ADR 0324 在没有更前面的正文时，把独特礼物卡片上的收藏名当成正文。已有正文或附言时，这些名字只贡献主机名。被挤开之后，「免费领取」和「加微x」仍整段留在外面。短链会删，关键词看不见。

Android 始终画出 `base_name`。没有附言时，型号、符号和背景的名字也在卡片上。有附言时这三行不再画出。短名 `name` 是 `t.me/nft` 用的，不是这行副标题。

Bot API 把 `UniqueGift.base_name`、`UniqueGiftModel.name`、`UniqueGiftSymbol.name` 和 `UniqueGiftBackdrop.name` 都写成字符串，没有再写长度。ADR 0324 已经把拼好的名字截到 4096。

## 决策

- 已有别的正文时，把 ADR 0324 那串看得见的名字另留前 4096 字。字段名是 `giftLabel`。这段自己就是正文时不设这个字段。
- 名字来自 `unique_gift.gift.base_name`。附言长度为 0 时，再按型号、符号、背景的顺序拼上各自的 `name`。几段去掉两端空白，用一个普通空格分开。附言长度大于 0 时不读这三行，包括只含空白的附言。
- 第 4097 字起不进事件。主机名仍从整段拼接抽取，包括被截掉的尾巴。
- 不读取短名、编号、`gift_id`、贴纸、星星、`publisher_chat`、`owned_gift_id`、成交币种和金额。
- 关键词和 `regex` 同时看正文、`senderTag`、`buttonText`、`authorSignature`、`mirrorSignature`、`pollOption`、`checklistTask`、`mediaName`、`performer`、`gameText`、`invoiceText`、`venueAddress`、`pollExplanation`、`pollQuestion`、`prizeText`、`checklistTitle`、`gameTitle`、`invoiceTitle`、`venueTitle`、`webAppButtonText`、`quoteText`、`giftText`、`giftLabel` 和 `profile`。证据仍是原来的摘要。收藏名原文不进证据，也不进日志。审计仍只留 `textSha256`。
- `regex` 命中时带上 `places`。`giftLabel` 加入这份名单。`gift_label_regex` 只在 `places` 含有这个字段时算命中。检测器没有 `places` 时仍按分数。
- 规则条件增加 `giftLabel: true`。消息上有这个字段时为真。
- 规则默认打开。条件是这个字段，检测器是现有的 `regex`，命中后 `delete`。
- 「免费领取」和「加微信」仍走已经打开的关键词规则。
- `regex_hint` 仍默认关闭。正文里的「加微x」不会因为旁边有干净的收藏名就被删掉。
- 不改 ADR 0026 的基础检测器名单。`keyword` 和 `regex` 已经在里面，超额后这条仍会跑。
- `chats.json` 整份替换的群不会自动带上这条规则。
- 不新增命令。菜单仍是 99 条。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 默认打开 `regex_hint` | 普通消息会被同一份模式删除。这次要读的是被别的正文挤开的收藏名。 |
| 把收藏名拼进已有正文 | 会改变 `textSha256`。ADR 0324 已经拒绝。 |
| 收藏名和型号各做一个字段 | 没有附言时它们是同一张卡片上的几行。有附言时型号本来就不画。 |
| 按更短的上限留下 | Bot API 没有写更短的长度。ADR 0324 已经用 4096。 |
| 连短名和发布者一起收 | 短名不是副标题。发布者标题不在这张卡片上。 |

## 后果

- 收藏名含「免费领取」或「加微信」时按关键词删除。含 `t.me/+`、「加微x」或「加微X」时按 `gift_label_regex` 删除。证据不含收藏名原文。
- 收藏名干净时消息留下。它自己就是正文时，「加微x」仍要打开 `regex_hint`。
- 第 4097 字起不进事件。主机名仍从整段抽取。写在收藏名里的路径会留在这个字段，不进审计。
- 有附言时型号、符号和背景仍不进事件。短名、编号、贴纸、星星、发布者和成交金额仍不进事件。
- 关掉 `gift_label_regex` 后，这种收藏名回到只看关键词和短链。别的旁路字段不受影响。
- 整份替换规则的群要自己加上这条，才会删除收藏名上的「加微x」。
- 30 天保留期没有改。
