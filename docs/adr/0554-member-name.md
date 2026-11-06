# ADR 0554：服务消息上的可见名字也走关键词和默认正则

- 状态：已接受
- 日期：2026-11-05

## 背景

ADR 0118、ADR 0119、ADR 0120 和 ADR 0121 在已有别的正文时，只从入群名单、视频聊天邀请、新群主和靠近提醒的可见名字里抽出主机名。这些名字被别的正文挤开时，「免费领取」和「加微x」仍整段留在外面。短链会删，关键词看不见。

这些名字拼起来最长按正文的 4096 字。类型页没有给 `first_name` 另写一个更短的上限。退群的人、发送者自己的姓名、用户编号、语言代码和距离仍不是这行看得见的加入或提醒名单。

名字自己成为正文时，ADR 0533 已经用 `service_name_regex` 删除这四类服务消息上的默认正则。那条规则不看字段位置。距离无效的靠近提醒不带 `asProximity`，名字被挤开时它盖不到。

## 决策

- 已有别的正文时，按 `new_chat_members`、`video_chat_participants_invited.users`、`chat_owner_changed.new_owner`、`chat_owner_left.new_owner`、`proximity_alert_triggered` 的 `traveler` 再 `watcher` 收集可见名字。每个人的 `first_name`、`last_name`、`username` 去掉两端空白后，用一个普通空格拼起来。拼起来的整段自己不是正文时，另留前 4096 字。去掉空白后是空的，或自己就是正文时，不设这个字段。
- 字段名是 `memberName`。正文和 `textSha256` 仍按原来的四条 ADR。没有更前面的正文时，这段名字成为正文。
- 第 4097 字起不进事件。主机名仍从整段原文抽取，包括被截掉的尾巴。
- 不读取 `left_chat_member`、`from` 上的姓名、用户 id、`language_code` 和距离。
- 关键词和 `regex` 同时看正文、`senderTag`、`buttonText`、`authorSignature`、`mirrorSignature`、`pollOption`、`checklistTask`、`mediaName`、`performer`、`gameText`、`invoiceText`、`venueAddress`、`pollExplanation`、`pollQuestion`、`prizeText`、`checklistTitle`、`gameTitle`、`invoiceTitle`、`venueTitle`、`webAppButtonText`、`quoteText`、`giftText`、`giftLabel`、`topicName`、`declineComment`、`addedText`、`hiddenName`、`memberName` 和 `profile`。证据仍是原来的摘要。名字原文不进证据，也不进日志。审计仍只留 `textSha256`。
- `regex` 命中时带上 `places`。`memberName` 加入这份名单。`member_name_regex` 只在 `places` 含有这个字段时算命中。检测器没有 `places` 时仍按分数。
- 规则条件增加 `memberName: true`。消息上有这个字段时为真。
- 规则默认打开。条件是这个字段，检测器是现有的 `regex`，命中后 `delete`。
- 「免费领取」和「加微信」仍走已经打开的关键词规则。
- `regex_hint` 仍默认关闭。距离无效时，正文里的「加微x」不会因为旁边有干净的名字就被删掉。
- `service_name_regex` 仍默认打开，而且仍不看字段位置。入群、邀请、换群主和有效靠近提醒上，正则命中正文或这个字段都会删。`service_notice`、`call_invite`、`owner_notice` 和 `proximity_notice` 仍默认关闭。
- 不改 ADR 0026 的基础检测器名单。`keyword` 和 `regex` 已经在里面，超额后这条仍会跑。
- `chats.json` 整份替换的群不会自动带上这条规则。
- 不新增命令。菜单仍是 99 条。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 默认打开 `service_notice`、`call_invite`、`owner_notice` 或 `proximity_notice` | 名字干净的那几行也会被删掉。 |
| 默认打开 `regex_hint` | 普通消息会被同一份模式删除。这次要读的是被别的正文挤开的可见名字。 |
| 把名字拼进已有正文 | 会改变 `textSha256`。原来的四条 ADR 已经拒绝。 |
| 按 64 字截断每个人的姓名 | 类型页没有写这个长度。猜短了会漏掉后面的关键词。主机名仍从整段抽取。 |
| 连退群的人或发送者姓名一起读 | 退群和普通发言者的姓名仍留在事件外面。 |
| 只靠 `service_name_regex` | 它不覆盖距离无效的靠近提醒。关掉它以后，被挤开的名字也要还能删「加微x」。 |

## 后果

- 可见名字含「免费领取」或「加微信」时按关键词删除。含 `t.me/+`、「加微x」或「加微X」时按 `member_name_regex` 删除。证据不含名字原文。
- 名字干净时消息留下。它自己就是正文时不设这个字段。入群、邀请、换群主和有效靠近提醒上的「加微x」仍由 `service_name_regex` 删除。距离无效时，正文里的「加微x」旁边有干净名字仍留下。
- 第 4097 字起不进事件。主机名仍从整段抽取。写在名字里的路径会留在这个字段，不进审计。
- 退群的人、发送者姓名、用户编号、语言代码和距离仍不进这个字段。
- 退群的人后来由 ADR 0582 只留下主机名。这段名字仍不进 `memberName`。
- 关掉 `member_name_regex` 后，距离无效的靠近提醒回到只看关键词和短链。另外四类仍由 `service_name_regex` 删除正则命中。`service_notice`、`call_invite`、`owner_notice` 和 `proximity_notice` 仍默认关闭。
- `places` 后来由 ADR 0555 加上 `sharedName`。分享来的用户名字只认自己的字段。
- 靠近的两个人后来按全名留在 `memberName`。名和姓都去掉两端空白，名在前。用户名不进。见 ADR 0642。入群、邀请和换群主仍读用户名。
- 入群名单后来按画出的全名留在这段里。几个人用逗号分开。用户名不进。见 ADR 0645。邀请和换群主仍读用户名。
- 视频聊天邀请后来按画出的全名留在这段里。几个人用逗号分开。用户名不进。见 ADR 0646。换群主仍读用户名。
- 新群主后来按画出的全名留在这段里。用户名不进。见 ADR 0647。
- 整份替换规则的群要自己加上这条，才会删除被挤开的名字上的「加微x」。
- 30 天保留期没有改。
