# ADR 0566：后面的文件名也走关键词和默认正则

- 状态：已接受
- 日期：2026-11-05

## 背景

ADR 0084 从动图、视频、音频标题、音频文件名和普通文件名抽出主机名。没有更前面的正文时，第一段非空名称成为正文。ADR 0539 在已有正文时把这第一段留在 `mediaName`。同一条消息可以再带后面的名称。动图发出时，Bot API 还会为了兼容再带一份普通文件。后面的名称仍只留主机名。第一段是普通课名时，「免费领取」和「加微x」可以整段留在下一段上。短链会删，关键词看不见。

音频文件名已经由 ADR 0559 留在 `audioFile`。付费视频的后段已经由 ADR 0560 留在 `paidFile`。富文本和投票媒体上的名称各自有字段。这次只读顶层动图、视频、被挤开的音频标题和普通文件。

Bot API 没有写这些名称的长度。正文回退把名称截到 4096。拼起来的字段用同一个上限。

## 决策

- 按 ADR 0084 的顺序收集顶层 `animation.file_name`、`video.file_name`、`audio.title` 和 `document.file_name`。去掉两端空白后仍有字，且这一段自己不是正文、也不是 `mediaLabel` 选中的名称时，用一个普通空格拼起来，另留前 4096 字。没有这样的后段时不设这个字段。
- 音频标题去掉空白后和 `audio.file_name` 相同，就不放进这个字段。那一段文件名仍由 `audioFile` 读取。
- 字段名是 `laterName`。正文和 `textSha256` 仍按 ADR 0062。选中的那一段仍按 ADR 0539 留在 `mediaName` 或成为正文，不重复放进这个字段。
- 第 4097 字起不进事件。主机名仍从每一段原文抽取，包括被截掉的尾巴。
- 不读取 `file_id`、`file_unique_id`、`mime_type`、缩略图、表演者、贴纸包名和付费视频。音频文件名不进这个字段。
- 关键词和 `regex` 同时看正文、`senderTag`、`buttonText`、`authorSignature`、`mirrorSignature`、`pollOption`、`checklistTask`、`mediaName`、`performer`、`gameText`、`invoiceText`、`venueAddress`、`pollExplanation`、`pollQuestion`、`prizeText`、`checklistTitle`、`gameTitle`、`invoiceTitle`、`venueTitle`、`webAppButtonText`、`quoteText`、`giftText`、`giftLabel`、`topicName`、`declineComment`、`addedText`、`hiddenName`、`memberName`、`sharedName`、`managedName`、`accessName`、`gameFile`、`audioFile`、`paidFile`、`richName`、`pollMedia`、`pollDescription`、`richText`、`richButton`、`laterName` 和 `profile`。证据仍是原来的摘要。名称原文不进证据，也不进日志。审计仍只留 `textSha256`。
- `regex` 命中时带上 `places`。`laterName` 加入这份名单。`later_name_regex` 只在 `places` 含有这个字段时算命中。检测器没有 `places` 时仍按分数。
- 规则条件增加 `laterName: true`。消息上有这个字段时为真。
- 规则默认打开。条件是这个字段，检测器是现有的 `regex`，命中后 `delete`。
- 「免费领取」和「加微信」仍走已经打开的关键词规则。选中的那一段里的关键词仍走原来的规则，不算进 `later_name_regex`。只有这一段时，名称仍算 `media_name_regex`。
- `regex_hint` 仍默认关闭。正文里的「加微x」不会因为旁边有干净的后段就被删掉。这一段自己就是正文时，「加微x」仍要打开 `regex_hint`。
- 不改 ADR 0026 的基础检测器名单。`keyword` 和 `regex` 已经在里面，超额后这条仍会跑。
- `chats.json` 整份替换的群不会自动带上这条规则。
- 不新增命令。菜单仍是 99 条。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 默认打开 `regex_hint` | 普通消息会被同一份模式删除。这次要读的是被第一段挤开的名称。 |
| 把后面的名称拼进正文 | 会改变 `textSha256`。ADR 0062 已经拒绝。 |
| 并进 `mediaName` | 那条规则已经占住第一段。后面的名称是另一处。 |
| 连音频文件名再存一份 | `audioFile` 已经在读。重复存放会让两条规则一起命中。 |
| 连付费视频一起读 | `paidFile` 已经在读后段。 |

## 后果

- 后面的文件名或被挤开的音频标题含「免费领取」或「加微信」时按关键词删除。含 `t.me/+`、「加微x」或「加微X」时按 `later_name_regex` 删除。证据不含名称原文。
- 后面的名称干净时消息留下。只有选中的那一段，且它自己就是名称或正文时，不设这个字段，「加微x」仍要打开 `regex_hint`。正文里的「加微x」旁边有干净的后段仍留下。
- 选中的那一段里的关键词仍按原来的规则删除，并且不把这次命中算进 `later_name_regex`。只有这一段时，名称仍按 `media_name_regex` 删除。
- 第 4097 字起不进事件。主机名仍从每一段抽取。写在名称里的路径会留在这个字段，不进审计。
- 文件编号、MIME、表演者、音频文件名和付费视频仍不进这个字段。动图附带的同名普通文件不重复存放。
- 关掉 `later_name_regex` 后，这种名称回到只看关键词和短链。`media_name_regex` 和 `audio_file_regex` 不受影响。
- 整份替换规则的群要自己加上这条，才会删除后面名称上的「加微x」。
- 30 天保留期没有改。
