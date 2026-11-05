# ADR 0550：论坛话题名也走关键词和默认正则

- 状态：已接受
- 日期：2026-11-05

## 背景

ADR 0088 在已有别的正文时，只从论坛话题名里抽出主机名。新建和改名都可以带这段名字。被别的正文挤开时，「免费领取」和「加微x」仍整段留在外面。短链会删，关键词看不见。

`createForumTopic` 和 `editGeneralForumTopic` 写明名字是 1 到 128 字。`editForumTopic` 的新名字是 0 到 128 字。`ForumTopicCreated.name` 和 `ForumTopicEdited.name` 没有再写长度。正文回退本来就截到 4096。图标颜色和自定义表情仍不是这段名字。

## 决策

- 已有别的正文时，按 `forum_topic_created.name`、`forum_topic_edited.name` 的顺序看。某一段去掉两端空白后仍有字，且自己不是正文时，另留前 128 字。这段自己就是正文时改看下一种。两段都是正文或都是空的，就不设这个字段。
- 字段名是 `topicName`。正文和 `textSha256` 仍按 ADR 0088，没有更前面的正文时第一段非空话题名成为正文。
- 第 129 字起不进事件。主机名仍从整段话题名抽取，包括被截掉的尾巴。
- `is_name_implicit` 不改变这一点。`icon_color` 和 `icon_custom_emoji_id` 不进这个字段。
- 关键词和 `regex` 同时看正文、`senderTag`、`buttonText`、`authorSignature`、`mirrorSignature`、`pollOption`、`checklistTask`、`mediaName`、`performer`、`gameText`、`invoiceText`、`venueAddress`、`pollExplanation`、`pollQuestion`、`prizeText`、`checklistTitle`、`gameTitle`、`invoiceTitle`、`venueTitle`、`webAppButtonText`、`quoteText`、`giftText`、`giftLabel`、`topicName` 和 `profile`。证据仍是原来的摘要。话题名原文不进证据，也不进日志。审计仍只留 `textSha256`。
- `regex` 命中时带上 `places`。`topicName` 加入这份名单。`topic_name_regex` 只在 `places` 含有这个字段时算命中。检测器没有 `places` 时仍按分数。
- 规则条件增加 `topicName: true`。消息上有这个字段时为真。
- 规则默认打开。条件是这个字段，检测器是现有的 `regex`，命中后 `delete`。
- 「免费领取」和「加微信」仍走已经打开的关键词规则。
- `regex_hint` 仍默认关闭。正文里的「加微x」不会因为旁边有干净的话题名就被删掉。
- 不改 ADR 0026 的基础检测器名单。`keyword` 和 `regex` 已经在里面，超额后这条仍会跑。
- `chats.json` 整份替换的群不会自动带上这条规则。
- 不新增命令。菜单仍是 99 条。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 默认打开 `regex_hint` | 普通消息会被同一份模式删除。这次要读的是被别的正文挤开的话题名。 |
| 把话题名拼进已有正文 | 会改变 `textSha256`。ADR 0088 已经拒绝。 |
| 新建和改名各做一个字段 | 上限都是 128。一条服务消息上先到的那段如果自己就是正文，下一种仍是同一段看得见的名字。 |
| 按正文的 4096 字留下 | 创建和改名都写明 128。更长的尾巴仍参与主机名抽取。 |
| `is_name_implicit` 时跳过 | 默认名字仍然显示给群成员。ADR 0088 已经拒绝。 |
| 连图标颜色和表情一起收 | 它们不是话题名。 |

## 后果

- 话题名含「免费领取」或「加微信」时按关键词删除。含 `t.me/+`、「加微x」或「加微X」时按 `topic_name_regex` 删除。证据不含话题名原文。
- 话题名干净时消息留下。它自己就是正文时，「加微x」仍要打开 `regex_hint`。后面另一种名字仍可以单独命中。
- 第 129 字起不进事件。主机名仍从整段抽取。写在话题名里的路径会留在这个字段，不进审计。
- 图标颜色、自定义表情仍不进事件。`is_name_implicit` 仍不隐藏这段名字。
- 关掉 `topic_name_regex` 后，这种话题名回到只看关键词和短链。别的旁路字段不受影响。`topic_notice` 仍默认关闭。
- 整份替换规则的群要自己加上这条，才会删除话题名上的「加微x」。
- 30 天保留期没有改。
