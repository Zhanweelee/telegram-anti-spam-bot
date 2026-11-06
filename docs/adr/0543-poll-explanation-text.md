# ADR 0543：测验说明也走关键词和默认正则

- 状态：已接受
- 日期：2026-11-05

## 背景

ADR 0056 用投票题干当正文。ADR 0537 让选项走旁路字段，并明确这一轮不读 `explanation`。ADR 0077 只从说明里抽出主机名。题干和选项都干净时，「免费领取」和「加微x」可以整段留在测验说明上。短链仍会删除，关键词看不见。答错或点灯时，这段说明会显示出来。

Bot API 写明 `poll.explanation` 是 0 到 200 字。

## 决策

- 已有别的正文，且 `message.poll.explanation` 去掉两端空白后仍有字时，事件另留 `pollExplanation`。只留前 200 字。这段文字自己就是正文时不设这个字段。正文和 `textSha256` 仍按 ADR 0056，题干优先。
- 第 201 字起不进事件。主机名仍从整段说明抽取，包括被截掉的尾巴。
- 投票人数、正确选项编号、说明媒体和 `description` 不进这个字段。说明媒体仍只留主机名。
- 关键词和 `regex` 同时看正文、`senderTag`、`buttonText`、`authorSignature`、`mirrorSignature`、`pollOption`、`checklistTask`、`mediaName`、`performer`、`gameText`、`invoiceText`、`venueAddress`、`pollExplanation` 和 `profile`。证据仍是原来的摘要。说明原文不进证据，也不进日志。审计仍只留 `textSha256`。
- `regex` 命中时带上 `places`，只写命中的字段名。`pollExplanation` 加入这份名单。`poll_explanation_regex` 只在 `places` 含有 `pollExplanation` 时算命中。检测器没有 `places` 时仍按分数。
- 规则条件增加 `pollExplanation: true`。消息上有这个字段时为真。
- 新规则 `poll_explanation_regex` 默认打开。条件是这个字段，检测器是现有的 `regex`，命中后 `delete`。
- 「免费领取」和「加微信」仍走已经打开的关键词规则。
- `regex_hint` 仍默认关闭。正文里的「加微x」不会因为旁边有干净的说明就被删掉。
- 不改 ADR 0026 的基础检测器名单。`keyword` 和 `regex` 已经在里面，超额后这条仍会跑。
- `chats.json` 整份替换的群不会自动带上这条规则。
- 不新增命令。菜单仍是 99 条。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 默认打开 `regex_hint` | 普通消息会被同一份模式删除。这次要读的是题干旁边的说明。 |
| 把说明拼进题干 | 会改变 `textSha256`。ADR 0056 已经拒绝。 |
| 说明和选项放进同一个字段 | 关掉选项规则时，说明还要留着。长度上限也不一样。 |
| 给说明单独做一个检测器 | 关键词和正则已经会扫旁路字段。名单不用再加一项。 |

## 后果

- 测验说明含「免费领取」或「加微信」时按关键词删除。含 `t.me/+`、「加微x」或「加微X」时按 `poll_explanation_regex` 删除。证据不含说明原文。
- 说明干净时消息留下。说明自己就是正文时，「加微x」仍要打开 `regex_hint`。
- 第 201 个字符起不进事件。主机名仍从整段说明抽取。写在说明里的路径会留在 `pollExplanation`，不进审计。
- 投票人数、正确选项编号和说明媒体仍不进这个字段。
- 关掉这条规则后，这种说明回到只看关键词和短链。
- 整份替换规则的群要自己加上这条，才会删除说明上的「加微x」。
- 30 天保留期没有改。
- `places` 后来由 ADR 0544 加上 `pollQuestion`、`prizeText` 和 `checklistTitle`。题干、奖品说明和清单标题的规则只认自己的字段。
- `description` 后来由 ADR 0563 另留在 `pollDescription`。说明媒体上的名称后来由 ADR 0562 另留在 `pollMedia`。
- 说明上的文字链接后来由 ADR 0730 要求起点小于说明。投票描述仍读全部文字链接。
