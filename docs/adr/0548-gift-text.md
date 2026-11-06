# ADR 0548：礼物附言也走关键词和默认正则

- 状态：已接受
- 日期：2026-11-05

## 背景

ADR 0087 在已有别的正文时，只从礼物附言里抽出主机名。普通礼物、唯一礼物和升级购买都可以带这段附言。被别的正文挤开时，「免费领取」和「加微x」仍整段留在外面。短链会删，关键词看不见。

Bot API 的 `sendGift` 写明附言是 0 到 128 字。`GiftInfo.text` 和 `UniqueGiftInfo.text` 没有再写长度。正文回退本来就截到 4096。贴纸、星星、收藏名和成交金额仍不进这段附言。

## 决策

- 已有别的正文时，按 `gift.text`、`unique_gift.text`、`gift_upgrade_sent.text` 的顺序看。某一段去掉两端空白后仍有字，且自己不是正文时，另留前 128 字。这段自己就是正文时改看下一种。三段都是正文或都是空的，就不设这个字段。
- 字段名是 `giftText`。正文和 `textSha256` 仍按 ADR 0087，没有更前面的正文时第一段非空附言成为正文。
- 第 129 字起不进事件。主机名仍从整段附言抽取，包括被截掉的尾巴。
- `is_private` 不改变这一点。贴纸、`file_id`、`set_name`、星星数量、`owned_gift_id`、唯一礼物的 `name`、型号、符号、背景、发布者、成交币种和金额不进这个字段。
- 关键词和 `regex` 同时看正文、`senderTag`、`buttonText`、`authorSignature`、`mirrorSignature`、`pollOption`、`checklistTask`、`mediaName`、`performer`、`gameText`、`invoiceText`、`venueAddress`、`pollExplanation`、`pollQuestion`、`prizeText`、`checklistTitle`、`gameTitle`、`invoiceTitle`、`venueTitle`、`webAppButtonText`、`quoteText`、`giftText` 和 `profile`。证据仍是原来的摘要。附言原文不进证据，也不进日志。审计仍只留 `textSha256`。
- `regex` 命中时带上 `places`。`giftText` 加入这份名单。`gift_text_regex` 只在 `places` 含有这个字段时算命中。检测器没有 `places` 时仍按分数。
- 规则条件增加 `giftText: true`。消息上有这个字段时为真。
- 规则默认打开。条件是这个字段，检测器是现有的 `regex`，命中后 `delete`。
- 「免费领取」和「加微信」仍走已经打开的关键词规则。
- `regex_hint` 仍默认关闭。正文里的「加微x」不会因为旁边有干净的附言就被删掉。
- 不改 ADR 0026 的基础检测器名单。`keyword` 和 `regex` 已经在里面，超额后这条仍会跑。
- `chats.json` 整份替换的群不会自动带上这条规则。
- 不新增命令。菜单仍是 99 条。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 默认打开 `regex_hint` | 普通消息会被同一份模式删除。这次要读的是被别的正文挤开的附言。 |
| 把附言拼进已有正文 | 会改变 `textSha256`。ADR 0087 已经拒绝。 |
| 三种附言各做一个字段 | 上限都是 128。关掉其中一种时，另外两种还是同一段看得见的附言。 |
| 按正文的 4096 字留下 | `sendGift` 写明 128。更长的尾巴仍参与主机名抽取。 |
| 连收藏名和星星一起收 | 收藏名是另一段可见文字。星星和成交金额不是附言。 |

## 后果

- 礼物附言含「免费领取」或「加微信」时按关键词删除。含 `t.me/+`、「加微x」或「加微X」时按 `gift_text_regex` 删除。证据不含附言原文。
- 附言干净时消息留下。它自己就是正文时，「加微x」仍要打开 `regex_hint`。后面另一种附言仍可以单独命中。
- 第 129 字起不进事件。主机名仍从整段抽取。写在附言里的路径会留在这个字段，不进审计。
- 附言上的文字链接后来由 ADR 0734 要求起点小于这段附言。附言里直接写出的网址仍从整段抽取。
- 贴纸、星星、发布者和成交金额仍不进这段附言。收藏名后来另见 ADR 0549。`is_private` 仍不隐藏这段附言。
- 关掉 `gift_text_regex` 后，这种附言回到只看关键词和短链。别的旁路字段不受影响。
- 整份替换规则的群要自己加上这条，才会删除附言上的「加微x」。
- 30 天保留期没有改。
- `places` 后来由 ADR 0549 加上 `giftLabel`。收藏名的规则只认自己的字段。
