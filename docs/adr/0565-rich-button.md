# ADR 0565：富文本按钮也走关键词和默认正则

- 状态：已接受
- 日期：2026-11-05

## 背景

ADR 0076 在没有别的可见文字时，用富文本按钮上的字当正文。已经有段落时，这些按钮不并进正文。ADR 0564 把正文旁边的段落留在 `richText`。没有段落时，按钮字会留在正文或 `richText`。已经有段落时，按钮上的「免费领取」和「加微x」仍看不见。短链会删，关键词看不见。

复制句子、`callback_data`、登录替换文字和内联查询仍不是按钮上看得见的字。内联键盘仍留在 `buttonText`。

## 决策

- 已有段落，且富文本按钮上看得见的字去掉两端空白后仍有字，这一截自己不是正文、也还没留在 `richText` 时，另留前 4096 字。没有这样的按钮时不设这个字段。
- 按钮之间用一个普通空格分开。列表、引用、拼贴和详情里的按钮块同样读取。
- 字段名是 `richButton`。正文和 `textSha256` 仍按 ADR 0076。这段不进入正文，也不并进 `richText` 或 `buttonText`。
- 没有段落时，按钮字仍按 ADR 0076 和 ADR 0564 留在正文或 `richText`，不重复放进这个字段。
- 第 4097 字起不进事件。主机名仍从整段原文抽取，包括被截掉的尾巴。
- 不读取 `copy_text` 的句子、`callback_data`、`login_url.forward_text` 和内联查询。`url` 仍只留主机名。
- 关键词和 `regex` 同时看正文、`senderTag`、`buttonText`、`authorSignature`、`mirrorSignature`、`pollOption`、`checklistTask`、`mediaName`、`performer`、`gameText`、`invoiceText`、`venueAddress`、`pollExplanation`、`pollQuestion`、`prizeText`、`checklistTitle`、`gameTitle`、`invoiceTitle`、`venueTitle`、`webAppButtonText`、`quoteText`、`giftText`、`giftLabel`、`topicName`、`declineComment`、`addedText`、`hiddenName`、`memberName`、`sharedName`、`managedName`、`accessName`、`gameFile`、`audioFile`、`paidFile`、`richName`、`pollMedia`、`pollDescription`、`richText`、`richButton` 和 `profile`。证据仍是原来的摘要。按钮原文不进证据，也不进日志。审计仍只留 `textSha256`。
- `regex` 命中时带上 `places`。`richButton` 加入这份名单。`rich_button_regex` 只在 `places` 含有这个字段时算命中。检测器没有 `places` 时仍按分数。
- 规则条件增加 `richButton: true`。消息上有这个字段时为真。
- 规则默认打开。条件是这个字段，检测器是现有的 `regex`，命中后 `delete`。
- 「免费领取」和「加微信」仍走已经打开的关键词规则。段落里的关键词仍走原来的规则，不算进 `rich_button_regex`。没有段落时，按钮上的「加微x」仍按 `rich_text_regex` 或正文规则，不算进 `rich_button_regex`。
- `regex_hint` 仍默认关闭。正文里的「加微x」不会因为旁边有干净的按钮就被删掉。按钮和正文是同一截时不设这个字段。
- 不改 ADR 0026 的基础检测器名单。`keyword` 和 `regex` 已经在里面，超额后这条仍会跑。
- `chats.json` 整份替换的群不会自动带上这条规则。
- 不新增命令。菜单仍是 99 条。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 默认打开 `regex_hint` | 普通消息会被同一份模式删除。这次要读的是段落旁边的按钮。 |
| 把按钮拼进段落 | 会改变 `textSha256`。ADR 0076 已经拒绝。 |
| 并进 `buttonText` | 那条规则看的是内联键盘。富文本按钮是另一处。 |
| 没有段落时也再存一份 | 那些字已经在正文或 `richText` 里。重复存放会让两条规则一起命中。 |

## 后果

- 段落旁边的富文本按钮含「免费领取」或「加微信」时按关键词删除。含 `t.me/+`、「加微x」或「加微X」时按 `rich_button_regex` 删除。证据不含按钮原文。
- 按钮干净时消息留下。没有段落时，按钮仍留在正文或 `richText`，不设这个字段。正文里的「加微x」旁边有干净的按钮仍留下。
- 段落里的关键词仍按原来的规则删除，并且不把这次命中算进 `rich_button_regex`。
- 第 4097 字起不进事件。主机名仍从整段抽取。写在按钮上的路径会留在这个字段，不进审计。
- 复制句子、`callback_data` 和内联查询仍不进这个字段。
- 关掉 `rich_button_regex` 后，这种按钮回到只看关键词和短链。`rich_text_regex` 和 `button_text_regex` 不受影响。
- 整份替换规则的群要自己加上这条，才会删除富文本按钮上的「加微x」。
- 30 天保留期没有改。
