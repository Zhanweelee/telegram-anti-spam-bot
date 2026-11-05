# ADR 0561：富文本媒体名称也走关键词和默认正则

- 状态：已接受
- 日期：2026-11-05

## 背景

ADR 0108 从富文本的动图、视频、普通文件的 `file_name`，以及音频的标题、文件名和表演者抽出主机名。这些名称不进入正文，也不改内容哈希。短链会删。「免费领取」和「加微x」可以整段留在名称上。关键词看不见。

Bot API 没有写这些名称的长度。旁路字段用 4096。说明、照片、语音和文件编号仍不是这些名称。

名称自己不会变成正文。没有别的正文时，「加微x」仍留在这个字段上，默认正则可以删。正文里已经有同一截时不重复存放。

## 决策

- 按块顺序收集富文本里 `animation`、`video`、`document` 的 `file_name`，以及 `audio` 的 `title`、`file_name`、`performer`。列表、引用、拼贴、幻灯片和详情里的块同样收集。
- 去掉两端空白后仍有字，且这一截自己不是正文、也不是 `mediaLabel` 选中的名称时，用一个普通空格拼起来，另留前 4096 字。没有这样的名称时不设这个字段。
- 字段名是 `richName`。正文和 `textSha256` 仍按 ADR 0108。这些名称不进入正文。
- 第 4097 字起不进事件。主机名仍从每一段原文抽取，包括被截掉的尾巴。
- 不读取说明、照片、语音、`file_id`、`file_unique_id` 和 `mime_type`。
- 关键词和 `regex` 同时看正文、`senderTag`、`buttonText`、`authorSignature`、`mirrorSignature`、`pollOption`、`checklistTask`、`mediaName`、`performer`、`gameText`、`invoiceText`、`venueAddress`、`pollExplanation`、`pollQuestion`、`prizeText`、`checklistTitle`、`gameTitle`、`invoiceTitle`、`venueTitle`、`webAppButtonText`、`quoteText`、`giftText`、`giftLabel`、`topicName`、`declineComment`、`addedText`、`hiddenName`、`memberName`、`sharedName`、`managedName`、`accessName`、`gameFile`、`audioFile`、`paidFile`、`richName` 和 `profile`。证据仍是原来的摘要。名称原文不进证据，也不进日志。审计仍只留 `textSha256`。
- `regex` 命中时带上 `places`。`richName` 加入这份名单。`rich_name_regex` 只在 `places` 含有这个字段时算命中。检测器没有 `places` 时仍按分数。
- 规则条件增加 `richName: true`。消息上有这个字段时为真。
- 规则默认打开。条件是这个字段，检测器是现有的 `regex`，命中后 `delete`。
- 「免费领取」和「加微信」仍走已经打开的关键词规则。正文里的关键词仍走原来的规则，不算进 `rich_name_regex`。
- `regex_hint` 仍默认关闭。正文里的「加微x」不会因为旁边有干净的名称就被删掉。名称和正文是同一截时不设这个字段，正文上的「加微x」仍要打开 `regex_hint`。没有别的正文时，名称留在这个字段，默认正则会删除「加微x」。
- 不改 ADR 0026 的基础检测器名单。`keyword` 和 `regex` 已经在里面，超额后这条仍会跑。
- `chats.json` 整份替换的群不会自动带上这条规则。
- 不新增命令。菜单仍是 99 条。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 默认打开 `regex_hint` | 普通消息会被同一份模式删除。这次要读的是富文本里的名称。 |
| 把名称拼进正文 | 会改变 `textSha256`。ADR 0108 已经拒绝。 |
| 并进 `mediaName` | 那条规则看的是消息上的文件名。富文本块是另一处。 |
| 连照片和语音一起读 | 它们没有可当句子的名称。文件编号仍不是句子。 |

## 后果

- 富文本媒体名称含「免费领取」或「加微信」时按关键词删除。含 `t.me/+`、「加微x」或「加微X」时按 `rich_name_regex` 删除。证据不含名称原文。
- 名称干净时消息留下。没有别的正文时，「加微x」仍按这条规则删除。和正文同一截时不设这个字段，「加微x」仍要打开 `regex_hint`。正文里的「加微x」旁边有干净的名称仍留下。
- 正文里的关键词仍按原来的规则删除，并且不把这次命中算进 `rich_name_regex`。
- 第 4097 字起不进事件。主机名仍从每一段抽取。写在名称里的路径会留在这个字段，不进审计。
- 说明、照片、语音和文件编号仍不进这个字段。
- 关掉 `rich_name_regex` 后，这种名称回到只看关键词和短链。`paid_file_regex` 和 `media_name_regex` 不受影响。
- 整份替换规则的群要自己加上这条，才会删除富文本名称上的「加微x」。
- 30 天保留期没有改。
