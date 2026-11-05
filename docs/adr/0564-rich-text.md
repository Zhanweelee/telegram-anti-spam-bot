# ADR 0564：富文本段落也走关键词和默认正则

- 状态：已接受
- 日期：2026-11-05

## 背景

ADR 0076 在没有 `text` 和 `caption` 时，用富文本里看得见的字当正文。已经有 `text` 或 `caption` 时，正文和哈希不变。段落、列表标签、表格、媒体说明和自定义表情的替代文字仍只抽出主机名。「免费领取」和「加微x」可以整段留在这些字上。关键词看不见。

没有别的段落时，按钮上看得见的字会成为正文。已经有正文时，这些按钮字同样留在外面。已有段落时，按钮文字仍不并进正文，这次也不并进新字段。

公式源码、语言标签、表情编号、复制句子、`callback_data`、邮箱、电话和银行卡号仍不进事件。文件名仍留在 `richName`。

## 决策

- 已有别的正文，且富文本里看得见的字去掉两端空白后仍有字，这一截自己不是正文时，另留前 4096 字。没有这样的字时不设这个字段。
- 看得见的字沿用 ADR 0076：段落、标题、列表标签、表格、说明和详情按原来的空格拼起来。没有这些字时，才用按钮上看得见的字。已有段落时，按钮文字不进入这个字段。
- 字段名是 `richText`。正文和 `textSha256` 仍按 ADR 0076。这段不进入正文。
- 第 4097 字起不进事件。主机名仍从整段原文抽取，包括被截掉的尾巴。
- 不读取公式源码、代码语言标签、表情编号、锚点名字、提及用户、银行卡号、邮箱、电话、`copy_text` 的句子和 `callback_data`。文件名、音频标题和表演者仍留在 `richName`。
- 关键词和 `regex` 同时看正文、`senderTag`、`buttonText`、`authorSignature`、`mirrorSignature`、`pollOption`、`checklistTask`、`mediaName`、`performer`、`gameText`、`invoiceText`、`venueAddress`、`pollExplanation`、`pollQuestion`、`prizeText`、`checklistTitle`、`gameTitle`、`invoiceTitle`、`venueTitle`、`webAppButtonText`、`quoteText`、`giftText`、`giftLabel`、`topicName`、`declineComment`、`addedText`、`hiddenName`、`memberName`、`sharedName`、`managedName`、`accessName`、`gameFile`、`audioFile`、`paidFile`、`richName`、`pollMedia`、`pollDescription`、`richText` 和 `profile`。证据仍是原来的摘要。这段原文不进证据，也不进日志。审计仍只留 `textSha256`。
- `regex` 命中时带上 `places`。`richText` 加入这份名单。`rich_text_regex` 只在 `places` 含有这个字段时算命中。检测器没有 `places` 时仍按分数。
- 规则条件增加 `richText: true`。消息上有这个字段时为真。
- 规则默认打开。条件是这个字段，检测器是现有的 `regex`，命中后 `delete`。
- 「免费领取」和「加微信」仍走已经打开的关键词规则。正文里的关键词仍走原来的规则，不算进 `rich_text_regex`。
- `regex_hint` 仍默认关闭。正文里的「加微x」不会因为旁边有干净的段落就被删掉。这段和正文是同一截时不设这个字段，正文上的「加微x」仍要打开 `regex_hint`。
- 不改 ADR 0026 的基础检测器名单。`keyword` 和 `regex` 已经在里面，超额后这条仍会跑。
- `chats.json` 整份替换的群不会自动带上这条规则。
- 不新增命令。菜单仍是 99 条。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 默认打开 `regex_hint` | 普通消息会被同一份模式删除。这次要读的是正文旁边的富文本。 |
| 把富文本拼进正文 | 会改变 `textSha256`。ADR 0076 已经拒绝。 |
| 已有段落时把按钮文字也拼进来 | 按钮文字已经有自己的规则。这次先补正文旁边的段落。 |
| 连公式和语言标签一起读 | 这些原文按既有决定留在事件外面。 |

## 后果

- 富文本里看得见的字含「免费领取」或「加微信」时按关键词删除。含 `t.me/+`、「加微x」或「加微X」时按 `rich_text_regex` 删除。证据不含这段原文。
- 这段干净时消息留下。和正文同一截时不设这个字段，「加微x」仍要打开 `regex_hint`。正文里的「加微x」旁边有干净的段落仍留下。
- 正文里的关键词仍按原来的规则删除，并且不把这次命中算进 `rich_text_regex`。
- 第 4097 字起不进事件。主机名仍从整段抽取。写在段落里的路径会留在这个字段，不进审计。
- 公式源码、语言标签、表情编号、复制句子和 `callback_data` 仍不进这个字段。文件名仍留在 `richName`。
- 关掉 `rich_text_regex` 后，这种段落回到只看关键词和短链。`poll_description_regex` 和 `rich_name_regex` 不受影响。
- 整份替换规则的群要自己加上这条，才会删除富文本段落上的「加微x」。
- 30 天保留期没有改。
- `places` 后来加上 `richButton`。已有段落时，富文本按钮另留。见 ADR 0565。
