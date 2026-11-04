# ADR 0495：新加的清单任务按群删除

- 状态：已接受
- 日期：2026-11-05

## 背景

有人往清单里新加任务时，`checklist_tasks_added` 带上这些任务的文字。没有别的正文时，这些文字已经按 ADR 0089 成为正文。文字干净时这行会留下。原清单在 `checklist_message` 里，是另一条消息。任务编号和完成者名字不是广告。把它并进 `checklist_notice` 会让只想删完成和取消完成的群把新加的任务也删掉。ADR 0489 已经拒绝了那种合并。清单标题仍按 ADR 0057 留在正文里，不另做检测器。

## 决策

- `checklist_tasks_added` 是对象，且 `tasks` 里至少有一条非空 `text` 时，事件带 `asChecklistAdded: true`。空文字后面还有非空文字时仍带。不写任务编号、完成者名字和原清单。
- 任务文字仍按 ADR 0089 成为正文。多条用空格接起来。已有正文时正文不变，任务文字不并进去。
- 空数组、只有空文字和布尔值不带这个标记。完成和取消完成不带这个标记。
- 检测器在 `@tasb/detector-task`，id 是 `checklist_added`。只在 `message.asChecklistAdded` 为 true 时返回 score 1。证据是 `checklist:added`。
- 默认规则关闭。私聊 `/rule <chatId> checklist_added on` 之后删除这种提示，`off` 回到留下。
- 不调用 `editMessageChecklist`。任务还在。付费帖仍不删除。
- 不新增命令。菜单仍是 99 条。
- 不改 ADR 0026 的基础检测器名单。`checklist_added` 不在里面。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 默认打开 | 正常补任务会被删掉。群要自己打开。 |
| 并进 `checklist_notice` | ADR 0489 已经拒绝。完成和取消完成是另一类提示。 |
| 给清单标题做一个检测器 | ADR 0057 已经拒绝。标题仍是正文。 |
| 把任务编号写进证据 | 编号不是广告。文字仍留在正文里。 |
| 新命令 `/task` | 菜单还剩 1 个位置，留给以后的操作命令。 |

## 后果

- 规则关闭时，新加的任务留下。文字干净时关键词仍看不见这行，除非文字里本身有关键词或短链。
- 打开 `checklist_added` 后，这个群里的这种提示会删除。打开 `checklist_notice` 仍不删除新加的任务。清单标题仍只靠正文。付费帖仍留下。
- 自部署没有额度，打开后就会删除。云模式超过当月次数后，还要把 `checklist_added` 写进 `QUOTA_BASIC`，否则超额时这条规则会停。
- `chats.json` 整份替换的群要自己加上 `checklist_added`，否则 `/rule` 会拒绝。
- 30 天保留期没有改。
