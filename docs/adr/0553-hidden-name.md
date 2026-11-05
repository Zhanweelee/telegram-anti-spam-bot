# ADR 0553：隐藏转发显示名也走关键词和默认正则

- 状态：已接受
- 日期：2026-11-05

## 背景

ADR 0091 在已有别的正文时，只从隐藏转发的显示名里抽出主机名。`MessageOriginHiddenUser.sender_user_name` 和旧字段 `forward_sender_name` 被别的正文挤开时，「免费领取」和「加微x」仍整段留在外面。短链会删，关键词看不见。

这两个字段都没有写长度。`User.first_name` 的类型页也没有写 64。正文回退本来就截到 4096。猜一个更短的客户端上限会漏掉后面的关键词。频道标题、来源上的作者签名、真实用户姓名和外部回复仍不是这条消息自己的隐藏显示名。

## 决策

- 已有别的正文时，先看 `forward_origin.type === "hidden_user"` 的 `sender_user_name`，再看旧字段 `forward_sender_name`。某一段去掉两端空白后仍有字，且自己不是正文时，另留前 4096 字。前面一段自己就是正文或去掉空白后是空的，就改看下一种。两段都不可用时不设这个字段。
- 字段名是 `hiddenName`。正文和 `textSha256` 仍按 ADR 0091。没有更前面的正文时，第一段非空隐藏显示名成为正文。
- 第 4097 字起不进事件。主机名仍从整段原文抽取，包括被截掉的尾巴。
- 不读取频道和群的标题、转发来源上的 `author_signature`、`forward_from` 的姓名、`external_reply.origin`。`type === "user"` 上的 `sender_user_name` 不进这个字段。
- 关键词和 `regex` 同时看正文、`senderTag`、`buttonText`、`authorSignature`、`mirrorSignature`、`pollOption`、`checklistTask`、`mediaName`、`performer`、`gameText`、`invoiceText`、`venueAddress`、`pollExplanation`、`pollQuestion`、`prizeText`、`checklistTitle`、`gameTitle`、`invoiceTitle`、`venueTitle`、`webAppButtonText`、`quoteText`、`giftText`、`giftLabel`、`topicName`、`declineComment`、`addedText`、`hiddenName` 和 `profile`。证据仍是原来的摘要。显示名原文不进证据，也不进日志。审计仍只留 `textSha256`。
- `regex` 命中时带上 `places`。`hiddenName` 加入这份名单。`hidden_name_regex` 只在 `places` 含有这个字段时算命中。检测器没有 `places` 时仍按分数。
- 规则条件增加 `hiddenName: true`。消息上有这个字段时为真。
- 规则默认打开。条件是这个字段，检测器是现有的 `regex`，命中后 `delete`。
- 「免费领取」和「加微信」仍走已经打开的关键词规则。
- `regex_hint` 仍默认关闭。正文里的「加微x」不会因为旁边有干净的隐藏显示名就被删掉。
- `hidden_forward` 仍默认关闭。那条规则会删掉没有广告文字的隐藏转发。
- 不改 ADR 0026 的基础检测器名单。`keyword` 和 `regex` 已经在里面，超额后这条仍会跑。
- `chats.json` 整份替换的群不会自动带上这条规则。
- 不新增命令。菜单仍是 99 条。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 默认打开 `hidden_forward` | 干净的隐藏转发也会被删。这次只删显示名里的关键词和默认正则。 |
| 默认打开 `regex_hint` | 普通消息会被同一份模式删除。这次要读的是被别的正文挤开的显示名。 |
| 把显示名拼进已有正文 | 会改变 `textSha256`。ADR 0091 已经拒绝。 |
| 按 64 或 129 字截断 | 类型页没有写这个长度。猜短了会漏掉后面的关键词。主机名仍从整段抽取。 |
| 连频道标题或真实姓名一起读 | 频道转发已经由 `channel_forward` 删除。真实姓名和外部回复仍留在事件外面。 |

## 后果

- 隐藏显示名含「免费领取」或「加微信」时按关键词删除。含 `t.me/+`、「加微x」或「加微X」时按 `hidden_name_regex` 删除。证据不含显示名原文。
- 显示名干净时消息留下。它自己就是正文时，「加微x」仍要打开 `regex_hint`。前面一段自己就是正文时，后面另一种仍可以单独命中。
- 第 4097 字起不进事件。主机名仍从整段抽取。写在显示名里的路径会留在这个字段，不进审计。
- 频道标题、真实用户姓名、来源签名和外部回复仍不进这个字段。频道转发仍由 `channel_forward` 删除。
- 关掉 `hidden_name_regex` 后，这种显示名回到只看关键词和短链。`hidden_forward` 仍默认关闭。
- 整份替换规则的群要自己加上这条，才会删除隐藏显示名上的「加微x」。
- 30 天保留期没有改。
