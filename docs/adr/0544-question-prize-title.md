# ADR 0544：题干、奖品说明和清单标题也走关键词和默认正则

- 状态：已接受
- 日期：2026-11-05

## 背景

ADR 0083 在已有别的正文时，只从投票题干、奖品说明和清单标题里抽出主机名。选项、任务和测验说明后来各自有了旁路字段。这三段被别的正文挤开时，「免费领取」和「加微x」仍整段留在外面。短链会删，关键词看不见。

Bot API 写明 `poll.question` 是 1 到 300 字，`prize_description` 是 0 到 255 字，`checklist.title` 是 1 到 255 字。

## 决策

- 已有别的正文，且 `message.poll.question` 去掉两端空白后仍有字时，事件另留 `pollQuestion`。只留前 300 字。题干自己就是正文时不设这个字段。正文和 `textSha256` 仍按 ADR 0056。
- 已有别的正文时，先看 `giveaway.prize_description`，再看 `giveaway_winners.prize_description`。第一段去掉空白后仍有字，且自己不是正文时，另留 `prizeText`，只留前 255 字。第一段自己就是正文时改看第二段。两段都是正文或都是空的，就不设这个字段。
- 已有别的正文，且 `checklist.title` 去掉两端空白后仍有字时，事件另留 `checklistTitle`。只留前 255 字。标题自己就是正文时不设这个字段。正文仍按 ADR 0057。
- 超出上限的字不进事件。主机名仍从整段抽取，包括被截掉的尾巴。
- 频道标题、中奖者名字、完成者名字、投票人数和任务编号不进这三个字段。
- 关键词和 `regex` 同时看正文、`senderTag`、`buttonText`、`authorSignature`、`mirrorSignature`、`pollOption`、`checklistTask`、`mediaName`、`performer`、`gameText`、`invoiceText`、`venueAddress`、`pollExplanation`、`pollQuestion`、`prizeText`、`checklistTitle` 和 `profile`。证据仍是原来的摘要。这三段原文不进证据，也不进日志。审计仍只留 `textSha256`。
- `regex` 命中时带上 `places`。这三个名字加入这份名单。`poll_question_regex`、`prize_text_regex` 和 `checklist_title_regex` 只在 `places` 含有自己的字段时算命中。检测器没有 `places` 时仍按分数。
- 规则条件增加 `pollQuestion: true`、`prizeText: true` 和 `checklistTitle: true`。消息上有对应字段时为真。
- 三条规则默认打开。条件是对应字段，检测器是现有的 `regex`，命中后 `delete`。
- 「免费领取」和「加微信」仍走已经打开的关键词规则。
- `regex_hint` 仍默认关闭。正文里的「加微x」不会因为旁边有干净的题干、奖品说明或标题就被删掉。
- 不改 ADR 0026 的基础检测器名单。`keyword` 和 `regex` 已经在里面，超额后这三条仍会跑。
- `chats.json` 整份替换的群不会自动带上这三条规则。
- 不新增命令。菜单仍是 99 条。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 默认打开 `regex_hint` | 普通消息会被同一份模式删除。这次要读的是被别的正文挤开的题干、奖品说明和标题。 |
| 把这三段拼进已有正文 | 会改变 `textSha256`。ADR 0083 已经拒绝。 |
| 题干和选项放进同一个字段 | 关掉选项规则时，题干还要留着。长度上限也不一样。 |
| 给这三段单独做一个检测器 | 关键词和正则已经会扫旁路字段。名单不用再加一项。 |
| 连频道标题和中奖者名字一起读 | 那是另一条消息上的名字。ADR 0083 已经拒绝。 |

## 后果

- 题干、奖品说明或清单标题含「免费领取」或「加微信」时按关键词删除。含 `t.me/+`、「加微x」或「加微X」时按对应规则删除。证据不含原文。
- 这段干净时消息留下。它自己就是正文时，「加微x」仍要打开 `regex_hint`。
- 超出 300 或 255 的字符不进事件。主机名仍从整段抽取。写在里面的路径会留在对应字段，不进审计。
- 频道标题、中奖者和完成者仍不进事件。
- 关掉其中一条后，这一段回到只看关键词和短链。另外两段不受影响。
- 整份替换规则的群要自己加上这三条，才会删除这些字段上的「加微x」。
- 30 天保留期没有改。
