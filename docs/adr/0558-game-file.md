# ADR 0558：游戏动图文件名也走关键词和默认正则

- 状态：已接受
- 日期：2026-11-05

## 背景

ADR 0110 在已有别的正文时，只从 `game.animation.file_name` 抽出主机名。标题或说明是普通句子时，「免费领取」和「加微x」仍整段留在文件名上。短链会删，关键词看不见。

Bot API 没有写这个文件名的长度。正文回退把别的文件名截到 4096。这个字段用同一个上限。封面、文件编号、MIME、宽高和时长仍不是给群成员看的链接。

文件名自己成为正文时，关键词和短链已经能删。`regex_hint` 仍默认关闭，所以单独成文的「加微x」继续留下。

## 决策

- 已有别的正文时，`game.animation.file_name` 去掉两端空白。去掉空白后的整段自己不是正文时，另留前 4096 字。去掉空白后是空的，或自己就是正文时，不设这个字段。
- 字段名是 `gameFile`。正文和 `textSha256` 仍按 ADR 0058 和 ADR 0110。没有更前面的正文时，标题仍成为正文，文件名不改成正文。
- 第 4097 字起不进事件。主机名仍从整段原文抽取，包括被截掉的尾巴。
- 不读取封面、`file_id`、`file_unique_id`、`mime_type`、宽高和时长。
- 关键词和 `regex` 同时看正文、`senderTag`、`buttonText`、`authorSignature`、`mirrorSignature`、`pollOption`、`checklistTask`、`mediaName`、`performer`、`gameText`、`invoiceText`、`venueAddress`、`pollExplanation`、`pollQuestion`、`prizeText`、`checklistTitle`、`gameTitle`、`invoiceTitle`、`venueTitle`、`webAppButtonText`、`quoteText`、`giftText`、`giftLabel`、`topicName`、`declineComment`、`addedText`、`hiddenName`、`memberName`、`sharedName`、`managedName`、`accessName`、`gameFile` 和 `profile`。证据仍是原来的摘要。文件名原文不进证据，也不进日志。审计仍只留 `textSha256`。
- `regex` 命中时带上 `places`。`gameFile` 加入这份名单。`game_file_regex` 只在 `places` 含有这个字段时算命中。检测器没有 `places` 时仍按分数。
- 规则条件增加 `gameFile: true`。消息上有这个字段时为真。
- 规则默认打开。条件是这个字段，检测器是现有的 `regex`，命中后 `delete`。
- 「免费领取」和「加微信」仍走已经打开的关键词规则。说明里的关键词仍走原来的规则，不算进 `game_file_regex`。
- `regex_hint` 仍默认关闭。正文里的「加微x」不会因为旁边有干净的文件名就被删掉。文件名自己就是正文时，「加微x」仍要打开 `regex_hint`。
- 不改 ADR 0026 的基础检测器名单。`keyword` 和 `regex` 已经在里面，超额后这条仍会跑。
- `chats.json` 整份替换的群不会自动带上这条规则。
- 不新增命令。菜单仍是 99 条。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 默认打开 `regex_hint` | 普通消息会被同一份模式删除。这次要读的是被别的正文挤开的动图文件名。 |
| 把文件名拼进已有正文 | 会改变 `textSha256`。ADR 0110 已经拒绝。 |
| 连封面或 MIME 一起读 | 它们不是给群成员看的文件名。 |
| 并进 `mediaName` | 那条规则读的是消息自己的动图、视频、音频和文件。游戏动图是另一处。 |

## 后果

- 动图文件名含「免费领取」或「加微信」时按关键词删除。含 `t.me/+`、「加微x」或「加微X」时按 `game_file_regex` 删除。证据不含文件名原文。
- 文件名干净时消息留下。它自己就是正文时不设这个字段，「加微x」仍要打开 `regex_hint`。正文里的「加微x」旁边有干净的文件名仍留下。
- 说明里的关键词仍按原来的规则删除，并且不把这次命中算进 `game_file_regex`。
- 第 4097 字起不进事件。主机名仍从整段抽取。写在文件名里的路径会留在这个字段，不进审计。
- 封面、文件编号、MIME、宽高和时长仍不进这个字段。
- 关掉 `game_file_regex` 后，这种文件名回到只看关键词和短链。`game_text_regex` 和 `access_name_regex` 不受影响。
- `places` 后来由 ADR 0559 加上 `audioFile`。音频文件名只认自己的字段。
- 整份替换规则的群要自己加上这条，才会删除动图文件名上的「加微x」。
- 30 天保留期没有改。
