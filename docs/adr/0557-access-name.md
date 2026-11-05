# ADR 0557：允许发消息时的小程序名字也走关键词和默认正则

- 状态：已接受
- 日期：2026-11-05

## 背景

ADR 0323 在已有别的正文时，只从 `write_access_allowed.web_app_name` 抽出主机名。这个名字被别的正文挤开时，「免费领取」和「加微x」仍整段留在外面。短链会删，关键词看不见。

这个名字最长按正文的 4096 字。类型页没有给 `web_app_name` 另写一个更短的上限。`from_request`、`from_attachment_menu`、发送者自己的姓名和所在聊天的标题仍不是这行看得见的名字。

名字自己成为正文时，关键词和短链已经能删。`regex_hint` 仍默认关闭，所以单独成文的「加微x」继续留下。

## 决策

- 已有别的正文时，`write_access_allowed.web_app_name` 去掉两端空白。去掉空白后的整段自己不是正文时，另留前 4096 字。去掉空白后是空的，或自己就是正文时，不设这个字段。
- 字段名是 `accessName`。正文和 `textSha256` 仍按 ADR 0323。没有更前面的正文时，这段名字成为正文。
- 第 4097 字起不进事件。主机名仍从整段原文抽取，包括被截掉的尾巴。
- 不读取 `from_request`、`from_attachment_menu`、`from` 上的姓名和 `chat.title`。
- 关键词和 `regex` 同时看正文、`senderTag`、`buttonText`、`authorSignature`、`mirrorSignature`、`pollOption`、`checklistTask`、`mediaName`、`performer`、`gameText`、`invoiceText`、`venueAddress`、`pollExplanation`、`pollQuestion`、`prizeText`、`checklistTitle`、`gameTitle`、`invoiceTitle`、`venueTitle`、`webAppButtonText`、`quoteText`、`giftText`、`giftLabel`、`topicName`、`declineComment`、`addedText`、`hiddenName`、`memberName`、`sharedName`、`managedName`、`accessName` 和 `profile`。证据仍是原来的摘要。名字原文不进证据，也不进日志。审计仍只留 `textSha256`。
- `regex` 命中时带上 `places`。`accessName` 加入这份名单。`access_name_regex` 只在 `places` 含有这个字段时算命中。检测器没有 `places` 时仍按分数。
- 规则条件增加 `accessName: true`。消息上有这个字段时为真。
- 规则默认打开。条件是这个字段，检测器是现有的 `regex`，命中后 `delete`。
- 「免费领取」和「加微信」仍走已经打开的关键词规则。
- `regex_hint` 仍默认关闭。正文里的「加微x」不会因为旁边有干净的小程序名字就被删掉。名字自己就是正文时，「加微x」仍要打开 `regex_hint`。
- 不改 ADR 0026 的基础检测器名单。`keyword` 和 `regex` 已经在里面，超额后这条仍会跑。
- `chats.json` 整份替换的群不会自动带上这条规则。
- 不新增命令。菜单仍是 99 条。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 默认打开 `regex_hint` | 普通消息会被同一份模式删除。这次要读的是被别的正文挤开的小程序名字。 |
| 把名字拼进已有正文 | 会改变 `textSha256`。ADR 0323 已经拒绝。 |
| 按 64 字截断 | 类型页没有写这个长度。猜短了会漏掉后面的关键词。主机名仍从整段抽取。 |
| 连来源布尔值或聊天标题一起读 | 它们不是这行看得见的小程序名字。 |

## 后果

- 小程序名字含「免费领取」或「加微信」时按关键词删除。含 `t.me/+`、「加微x」或「加微X」时按 `access_name_regex` 删除。证据不含名字原文。
- 小程序名字干净时消息留下。它自己就是正文时不设这个字段，「加微x」仍要打开 `regex_hint`。正文里的「加微x」旁边有干净的小程序名字仍留下。
- 第 4097 字起不进事件。主机名仍从整段抽取。写在名字里的路径会留在这个字段，不进审计。
- 来源布尔值、发送者姓名和聊天标题仍不进这个字段。
- 关掉 `access_name_regex` 后，这种名字回到只看关键词和短链。受管 bot 名字的 `managed_name_regex` 不受影响。
- 整份替换规则的群要自己加上这条，才会删除小程序名字上的「加微x」。
- 30 天保留期没有改。
