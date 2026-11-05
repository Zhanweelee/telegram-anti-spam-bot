# ADR 0560：后面的付费视频文件名也走关键词和默认正则

- 状态：已接受
- 日期：2026-11-05

## 背景

ADR 0090 从每段付费视频的 `file_name` 抽出主机名。没有更前面的正文时，第一段非空文件名成为正文。ADR 0539 在已有正文时把这第一段留在 `mediaName`。一条付费消息可以带多段视频。后面的文件名仍只留主机名。第一段是普通课名时，「免费领取」和「加微x」可以整段留在下一段上。短链会删，关键词看不见。

Bot API 没有写这个文件名的长度。正文回退把名称截到 4096。拼起来的字段用同一个上限。星星数量、文件编号、MIME、照片、实况照片和预览仍不是文件名。

第一段自己成为名称或正文时，关键词和短链已经能删。`regex_hint` 仍默认关闭，所以单独成文的「加微x」继续留下。

## 决策

- 已有名称或别的正文时，按数组顺序收集付费视频的 `file_name`。去掉两端空白后仍有字，且这一段自己不是正文、也不是 `mediaLabel` 选中的名称时，用一个普通空格拼起来，另留前 4096 字。没有这样的后段时不设这个字段。
- 字段名是 `paidFile`。正文和 `textSha256` 仍按 ADR 0090。第一段仍按 ADR 0539 留在 `mediaName` 或成为正文，不重复放进这个字段。
- 第 4097 字起不进事件。主机名仍从每一段原文抽取，包括被截掉的尾巴。
- 不读取 `star_count`、`file_id`、`file_unique_id`、`mime_type`、照片、实况照片和预览。
- 关键词和 `regex` 同时看正文、`senderTag`、`buttonText`、`authorSignature`、`mirrorSignature`、`pollOption`、`checklistTask`、`mediaName`、`performer`、`gameText`、`invoiceText`、`venueAddress`、`pollExplanation`、`pollQuestion`、`prizeText`、`checklistTitle`、`gameTitle`、`invoiceTitle`、`venueTitle`、`webAppButtonText`、`quoteText`、`giftText`、`giftLabel`、`topicName`、`declineComment`、`addedText`、`hiddenName`、`memberName`、`sharedName`、`managedName`、`accessName`、`gameFile`、`audioFile`、`paidFile` 和 `profile`。证据仍是原来的摘要。文件名原文不进证据，也不进日志。审计仍只留 `textSha256`。
- `regex` 命中时带上 `places`。`paidFile` 加入这份名单。`paid_file_regex` 只在 `places` 含有这个字段时算命中。检测器没有 `places` 时仍按分数。
- 规则条件增加 `paidFile: true`。消息上有这个字段时为真。
- 规则默认打开。条件是这个字段，检测器是现有的 `regex`，命中后 `delete`。
- 「免费领取」和「加微信」仍走已经打开的关键词规则。第一段里的关键词仍走原来的规则，不算进 `paid_file_regex`。只有第一段时，文件名仍算 `media_name_regex`。
- `regex_hint` 仍默认关闭。正文里的「加微x」不会因为旁边有干净的文件名就被删掉。第一段自己就是正文时，「加微x」仍要打开 `regex_hint`。
- 不改 ADR 0026 的基础检测器名单。`keyword` 和 `regex` 已经在里面，超额后这条仍会跑。
- `chats.json` 整份替换的群不会自动带上这条规则。
- 不新增命令。菜单仍是 99 条。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 默认打开 `regex_hint` | 普通消息会被同一份模式删除。这次要读的是被第一段挤开的付费视频文件名。 |
| 把后面的文件名拼进正文 | 会改变 `textSha256`。ADR 0090 已经拒绝。 |
| 并进 `mediaName` | 那条规则已经占住第一段。后面的文件名是另一处。 |
| 连星星数量或照片一起读 | 星星数量不是文件名。照片没有文件名。 |

## 后果

- 后面的付费视频文件名含「免费领取」或「加微信」时按关键词删除。含 `t.me/+`、「加微x」或「加微X」时按 `paid_file_regex` 删除。证据不含文件名原文。
- 后面的文件名干净时消息留下。只有第一段，且它自己就是名称或正文时，不设这个字段，「加微x」仍要打开 `regex_hint`。正文里的「加微x」旁边有干净的后段仍留下。
- 第一段里的关键词仍按原来的规则删除，并且不把这次命中算进 `paid_file_regex`。只有第一段时，文件名仍按 `media_name_regex` 删除。
- 第 4097 字起不进事件。主机名仍从每一段抽取。写在文件名里的路径会留在这个字段，不进审计。
- 星星数量、文件编号、MIME、照片、实况照片和预览仍不进这个字段。
- 关掉 `paid_file_regex` 后，这种文件名回到只看关键词和短链。`media_name_regex` 和 `audio_file_regex` 不受影响。
- 整份替换规则的群要自己加上这条，才会删除后面文件名上的「加微x」。
- 30 天保留期没有改。
