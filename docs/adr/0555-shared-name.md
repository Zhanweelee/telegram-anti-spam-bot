# ADR 0555：分享来的用户名字也走关键词和默认正则

- 状态：已接受
- 日期：2026-11-05

## 背景

ADR 0321 在已有别的正文时，只从 `users_shared.users` 的可见名字里抽出主机名。这些名字被别的正文挤开时，「免费领取」和「加微x」仍整段留在外面。短链会删，关键词看不见。

这些名字拼起来最长按正文的 4096 字。类型页没有给 `first_name` 另写一个更短的上限。请求编号、用户编号、头像、发送者自己的姓名和所在聊天的标题仍不是这份分享名单。`chat_shared` 的标题仍按 ADR 0320 只留主机名。

名字自己成为正文时，关键词和短链已经能删。`regex_hint` 仍默认关闭，所以单独成文的「加微x」继续留下。

## 决策

- 已有别的正文时，`users_shared.users` 里每个人的 `first_name`、`last_name`、`username` 去掉两端空白后，用一个普通空格拼起来。拼起来的整段自己不是正文时，另留前 4096 字。去掉空白后是空的，或自己就是正文时，不设这个字段。
- 字段名是 `sharedName`。正文和 `textSha256` 仍按 ADR 0321。没有更前面的正文时，这段名字成为正文。
- 第 4097 字起不进事件。主机名仍从整段原文抽取，包括被截掉的尾巴。
- 不读取 `request_id`、`user_id`、头像、`from` 上的姓名、`chat.title` 和 `chat_shared`。
- 关键词和 `regex` 同时看正文、`senderTag`、`buttonText`、`authorSignature`、`mirrorSignature`、`pollOption`、`checklistTask`、`mediaName`、`performer`、`gameText`、`invoiceText`、`venueAddress`、`pollExplanation`、`pollQuestion`、`prizeText`、`checklistTitle`、`gameTitle`、`invoiceTitle`、`venueTitle`、`webAppButtonText`、`quoteText`、`giftText`、`giftLabel`、`topicName`、`declineComment`、`addedText`、`hiddenName`、`memberName`、`sharedName` 和 `profile`。证据仍是原来的摘要。名字原文不进证据，也不进日志。审计仍只留 `textSha256`。
- `regex` 命中时带上 `places`。`sharedName` 加入这份名单。`shared_name_regex` 只在 `places` 含有这个字段时算命中。检测器没有 `places` 时仍按分数。
- 规则条件增加 `sharedName: true`。消息上有这个字段时为真。
- 规则默认打开。条件是这个字段，检测器是现有的 `regex`，命中后 `delete`。
- 「免费领取」和「加微信」仍走已经打开的关键词规则。
- `regex_hint` 仍默认关闭。正文里的「加微x」不会因为旁边有干净的分享名字就被删掉。名字自己就是正文时，「加微x」仍要打开 `regex_hint`。
- `shared_chat` 仍默认关闭。分享来的聊天标题不进这个字段。
- 不改 ADR 0026 的基础检测器名单。`keyword` 和 `regex` 已经在里面，超额后这条仍会跑。
- `chats.json` 整份替换的群不会自动带上这条规则。
- 不新增命令。菜单仍是 99 条。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 默认打开 `regex_hint` | 普通消息会被同一份模式删除。这次要读的是被别的正文挤开的分享名字。 |
| 默认打开 `shared_chat` | 那条规则删的是分享来的聊天卡片，而且会把没有广告文字的卡片也删掉。 |
| 把名字拼进已有正文 | 会改变 `textSha256`。ADR 0321 已经拒绝。 |
| 按 64 字截断每个人的姓名 | 类型页没有写这个长度。猜短了会漏掉后面的关键词。主机名仍从整段抽取。 |
| 连发送者姓名或聊天标题一起读 | 它们不是这份分享名单。聊天标题仍只留主机名。 |

## 后果

- 分享名字含「免费领取」或「加微信」时按关键词删除。含 `t.me/+`、「加微x」或「加微X」时按 `shared_name_regex` 删除。证据不含名字原文。
- 分享名字干净时消息留下。它自己就是正文时不设这个字段，「加微x」仍要打开 `regex_hint`。正文里的「加微x」旁边有干净的分享名字仍留下。
- 第 4097 字起不进事件。主机名仍从整段抽取。写在名字里的路径会留在这个字段，不进审计。
- 请求编号、用户编号、头像、发送者姓名、聊天标题和 `chat_shared` 仍不进这个字段。
- 关掉 `shared_name_regex` 后，这种名字回到只看关键词和短链。`shared_chat` 仍默认关闭。入群名单的 `member_name_regex` 不受影响。
- `places` 后来由 ADR 0556 加上 `managedName`。新建受管 bot 的可见名字只认自己的字段。
- 整份替换规则的群要自己加上这条，才会删除分享名字上的「加微x」。
- 30 天保留期没有改。
