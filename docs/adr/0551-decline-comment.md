# ADR 0551：拒绝建议帖的说明也走关键词和默认正则

- 状态：已接受
- 日期：2026-11-05

## 背景

ADR 0113 在已有别的正文时，只从 `suggested_post_declined.comment` 抽出主机名。拒绝的人写的说明被别的正文挤开时，「免费领取」和「加微x」仍整段留在外面。短链会删，关键词看不见。

`declineSuggestedPost` 写明 `comment` 是 0 到 128 字。`SuggestedPostDeclined.comment` 没有再写长度。正文回退本来就截到 4096。嵌套的 `suggested_post_message` 仍是另一条原帖。

## 决策

- 已有别的正文时，`suggested_post_declined.comment` 去掉两端空白后仍有字，且自己不是正文时，另留前 128 字。这段自己就是正文，或去掉空白后是空的，就不设这个字段。
- 字段名是 `declineComment`。正文和 `textSha256` 仍按 ADR 0113，没有更前面的正文时这段说明成为正文。
- 第 129 字起不进事件。主机名仍从整段说明抽取，包括被截掉的尾巴。
- `suggested_post_message` 不进这个字段。通过、失败、付款和退款对象仍不读。
- 关键词和 `regex` 同时看正文、`senderTag`、`buttonText`、`authorSignature`、`mirrorSignature`、`pollOption`、`checklistTask`、`mediaName`、`performer`、`gameText`、`invoiceText`、`venueAddress`、`pollExplanation`、`pollQuestion`、`prizeText`、`checklistTitle`、`gameTitle`、`invoiceTitle`、`venueTitle`、`webAppButtonText`、`quoteText`、`giftText`、`giftLabel`、`topicName`、`declineComment` 和 `profile`。证据仍是原来的摘要。拒绝说明原文不进证据，也不进日志。审计仍只留 `textSha256`。
- `regex` 命中时带上 `places`。`declineComment` 加入这份名单。`decline_comment_regex` 只在 `places` 含有这个字段时算命中。检测器没有 `places` 时仍按分数。
- 规则条件增加 `declineComment: true`。消息上有这个字段时为真。
- 规则默认打开。条件是这个字段，检测器是现有的 `regex`，命中后 `delete`。
- 「免费领取」和「加微信」仍走已经打开的关键词规则。
- `regex_hint` 仍默认关闭。正文里的「加微x」不会因为旁边有干净的拒绝说明就被删掉。
- 不改 ADR 0026 的基础检测器名单。`keyword` 和 `regex` 已经在里面，超额后这条仍会跑。
- `chats.json` 整份替换的群不会自动带上这条规则。
- 不新增命令。菜单仍是 99 条。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 默认打开 `regex_hint` | 普通消息会被同一份模式删除。这次要读的是被别的正文挤开的拒绝说明。 |
| 把拒绝说明拼进已有正文 | 会改变 `textSha256`。ADR 0113 已经拒绝。 |
| 按正文的 4096 字留下 | `declineSuggestedPost` 写明 128。更长的尾巴仍参与主机名抽取。 |
| 连嵌套原帖一起收 | 原帖是另一条消息。ADR 0113 已经拒绝。 |
| 默认打开 `post_declined` | 那条规则会删掉没有说明的拒绝。这次只删说明里的关键词和默认正则。 |

## 后果

- 拒绝说明含「免费领取」或「加微信」时按关键词删除。含 `t.me/+`、「加微x」或「加微X」时按 `decline_comment_regex` 删除。证据不含拒绝说明原文。
- 拒绝说明干净时消息留下。它自己就是正文时，「加微x」仍要打开 `regex_hint`。
- 第 129 字起不进事件。主机名仍从整段抽取。写在拒绝说明里的路径会留在这个字段，不进审计。
- 嵌套原帖仍不进事件。
- 关掉 `decline_comment_regex` 后，这种拒绝说明回到只看关键词和短链。别的旁路字段不受影响。`post_declined` 仍默认关闭。
- 整份替换规则的群要自己加上这条，才会删除拒绝说明上的「加微x」。
- 30 天保留期没有改。
- `places` 后来由 ADR 0552 加上 `addedText`。后加选项和任务的规则只认自己的字段。
