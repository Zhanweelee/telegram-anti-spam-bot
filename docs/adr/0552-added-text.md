# ADR 0552：后加选项和清单任务也走关键词和默认正则

- 状态：已接受
- 日期：2026-11-05

## 背景

ADR 0089 在已有别的正文时，只从后加的投票选项和清单任务里抽出主机名。新选项、被删选项和新任务被别的正文挤开时，「免费领取」和「加微x」仍整段留在外面。短链会删，关键词看不见。

`InputPollOption.text` 是 1 到 100 字。`InputChecklistTask.text` 是 1 到 100 字，一份清单是 1 到 30 条，拼起来最多 3029 字。`PollOptionAdded.option_text`、`PollOptionDeleted.option_text` 和 `ChecklistTask.text` 没有再写长度。正文回退本来就截到 4096。选项编号、原投票、原清单和完成者仍不是这段文字。

## 决策

- 已有别的正文时，按 `poll_option_added.option_text`、`poll_option_deleted.option_text`、`checklist_tasks_added.tasks` 的顺序看。某一段去掉两端空白后仍有字，且自己不是正文时，选项另留前 100 字。前面的选项自己就是正文或去掉空白后是空的，就改看下一种。两条选项都不可用时，非空任务文字用一个普通空格拼起来，另留前 3029 字。拼起来的任务自己就是正文时不设这个字段。
- 字段名是 `addedText`。正文和 `textSha256` 仍按 ADR 0089。没有更前面的正文时，第一段非空选项成为正文；没有选项时，任务拼起来成为正文。
- 选项第 101 字起不进事件。任务拼起来第 3030 字起不进事件。主机名仍从每段原文抽取，包括被截掉的尾巴，并继续读取同一处的 `text_link`。
- `option_persistent_id`、任务 id、`poll_message`、`checklist_message`、`completed_by_user` 和 `completed_by_chat` 不进这个字段。
- 关键词和 `regex` 同时看正文、`senderTag`、`buttonText`、`authorSignature`、`mirrorSignature`、`pollOption`、`checklistTask`、`mediaName`、`performer`、`gameText`、`invoiceText`、`venueAddress`、`pollExplanation`、`pollQuestion`、`prizeText`、`checklistTitle`、`gameTitle`、`invoiceTitle`、`venueTitle`、`webAppButtonText`、`quoteText`、`giftText`、`giftLabel`、`topicName`、`declineComment`、`addedText` 和 `profile`。证据仍是原来的摘要。后加原文不进证据，也不进日志。审计仍只留 `textSha256`。
- `regex` 命中时带上 `places`。`addedText` 加入这份名单。`added_text_regex` 只在 `places` 含有这个字段时算命中。检测器没有 `places` 时仍按分数。
- 规则条件增加 `addedText: true`。消息上有这个字段时为真。
- 规则默认打开。条件是这个字段，检测器是现有的 `regex`，命中后 `delete`。
- 「免费领取」和「加微信」仍走已经打开的关键词规则。
- `regex_hint` 仍默认关闭。正文里的「加微x」不会因为旁边有干净的后加文字就被删掉。
- 不改 ADR 0026 的基础检测器名单。`keyword` 和 `regex` 已经在里面，超额后这条仍会跑。
- `chats.json` 整份替换的群不会自动带上这条规则。
- 不新增命令。菜单仍是 99 条。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 默认打开 `regex_hint` | 普通消息会被同一份模式删除。这次要读的是被别的正文挤开的后加文字。 |
| 把后加文字拼进已有正文 | 会改变 `textSha256`。ADR 0089 已经拒绝。 |
| 选项和任务各做一个字段 | 正文回退本来就是一条顺序。先到的那段如果自己就是正文，下一种仍是同一条服务消息上看得见的文字。 |
| 复用 `pollOption` 和 `checklistTask` | 那两个字段读的是投票和清单自己的选项与任务。关掉其中一条会连带关掉后加文字，或者反过来。 |
| 按正文的 4096 字留下 | 创建选项和任务都写明 100。任务拼起来的上限已经是 3029。更长的尾巴仍参与主机名抽取。 |
| 默认打开 `poll_notice` 或 `checklist_added` | 那两条规则会删掉没有广告文字的服务消息。这次只删后加文字里的关键词和默认正则。 |

## 后果

- 后加文字含「免费领取」或「加微信」时按关键词删除。含 `t.me/+`、「加微x」或「加微X」时按 `added_text_regex` 删除。证据不含后加原文。
- 后加文字干净时消息留下。它自己就是正文时，「加微x」仍要打开 `regex_hint`。前面一段自己就是正文时，后面另一种仍可以单独命中。
- 选项第 101 字起、任务拼起来第 3030 字起不进事件。主机名仍从整段抽取。写在后加文字里的路径会留在这个字段，不进审计。
- 选项编号、原消息和完成者仍不进事件。
- 关掉 `added_text_regex` 后，这种后加文字回到只看关键词和短链。原投票的 `poll_option_regex` 和原清单的 `checklist_task_regex` 不受影响。`poll_notice` 和 `checklist_added` 仍默认关闭。
- `places` 后来由 ADR 0553 加上 `hiddenName`。隐藏显示名的规则只认自己的字段。
- 整份替换规则的群要自己加上这条，才会删除后加文字上的「加微x」。
- 30 天保留期没有改。
