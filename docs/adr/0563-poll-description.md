# ADR 0563：投票描述也走关键词和默认正则

- 状态：已接受
- 日期：2026-11-05

## 背景

ADR 0077 从 `poll.description` 抽出主机名。题干成为正文时，描述不进入正文，也不改内容哈希。短链会删。「免费领取」和「加微x」可以整段留在描述上。关键词看不见。

Bot API 写明 `sendPoll` 的 `description` 是 0 到 1024 字。测验说明已经留在 `pollExplanation`。描述是另一段看得见的字。

描述自己不会变成正文。没有题干时，「加微x」仍留在这个字段上，默认正则可以删。正文里已经有同一截时不重复存放。

## 决策

- 已有别的正文，且 `poll.description` 去掉两端空白后仍有字，这一截自己不是正文时，另留前 1024 字。没有这样的描述时不设这个字段。
- 字段名是 `pollDescription`。正文和 `textSha256` 仍按 ADR 0056。描述不进入正文，也不并进 `pollExplanation`。
- 第 1025 字起不进事件。主机名仍从整段原文抽取，包括被截掉的尾巴。`description_entities` 里的链接仍只留主机名。
- 不读取投票人数、正确选项编号和添加者的名字。
- 关键词和 `regex` 同时看正文、`senderTag`、`buttonText`、`authorSignature`、`mirrorSignature`、`pollOption`、`checklistTask`、`mediaName`、`performer`、`gameText`、`invoiceText`、`venueAddress`、`pollExplanation`、`pollQuestion`、`prizeText`、`checklistTitle`、`gameTitle`、`invoiceTitle`、`venueTitle`、`webAppButtonText`、`quoteText`、`giftText`、`giftLabel`、`topicName`、`declineComment`、`addedText`、`hiddenName`、`memberName`、`sharedName`、`managedName`、`accessName`、`gameFile`、`audioFile`、`paidFile`、`richName`、`pollMedia`、`pollDescription` 和 `profile`。证据仍是原来的摘要。描述原文不进证据，也不进日志。审计仍只留 `textSha256`。
- `regex` 命中时带上 `places`。`pollDescription` 加入这份名单。`poll_description_regex` 只在 `places` 含有这个字段时算命中。检测器没有 `places` 时仍按分数。
- 规则条件增加 `pollDescription: true`。消息上有这个字段时为真。
- 规则默认打开。条件是这个字段，检测器是现有的 `regex`，命中后 `delete`。
- 「免费领取」和「加微信」仍走已经打开的关键词规则。题干里的关键词仍走原来的规则，不算进 `poll_description_regex`。
- `regex_hint` 仍默认关闭。正文里的「加微x」不会因为旁边有干净的描述就被删掉。描述和正文是同一截时不设这个字段，正文上的「加微x」仍要打开 `regex_hint`。没有题干时，描述留在这个字段，默认正则会删除「加微x」。
- 不改 ADR 0026 的基础检测器名单。`keyword` 和 `regex` 已经在里面，超额后这条仍会跑。
- `chats.json` 整份替换的群不会自动带上这条规则。
- 不新增命令。菜单仍是 99 条。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 默认打开 `regex_hint` | 普通消息会被同一份模式删除。这次要读的是投票描述。 |
| 把描述拼进题干 | 会改变 `textSha256`。ADR 0077 已经拒绝。 |
| 并进 `pollExplanation` | 那条规则看的是测验说明，上限是 200。描述是另一处，上限是 1024。 |
| 连投票人数和添加者一起读 | 人数不是句子。添加者名字按既有决定留在事件外面。 |

## 后果

- 投票描述含「免费领取」或「加微信」时按关键词删除。含 `t.me/+`、「加微x」或「加微X」时按 `poll_description_regex` 删除。证据不含描述原文。
- 描述干净时消息留下。没有题干时，「加微x」仍按这条规则删除。和正文同一截时不设这个字段，「加微x」仍要打开 `regex_hint`。正文里的「加微x」旁边有干净的描述仍留下。
- 题干里的关键词仍按原来的规则删除，并且不把这次命中算进 `poll_description_regex`。
- 第 1025 字起不进事件。主机名仍从整段抽取。写在描述里的路径会留在这个字段，不进审计。
- 投票人数、正确选项和添加者名字仍不进这个字段。
- 关掉 `poll_description_regex` 后，这种描述回到只看关键词和短链。`poll_media_regex` 和 `poll_explanation_regex` 不受影响。
- 整份替换规则的群要自己加上这条，才会删除投票描述上的「加微x」。
- 30 天保留期没有改。
