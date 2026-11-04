# ADR 0497：建议帖拒绝按群删除

- 状态：已接受
- 日期：2026-11-05

## 背景

建议帖被拒绝时，`suggested_post_declined` 可以带上一句说明。没有别的正文时，这句说明已经按 ADR 0113 成为正文。说明干净时这行会留下。没有说明时正文是空的，关键词看不见这行。嵌套的 `suggested_post_message` 是另一条消息。把它并进 `post_notice` 会让只想删通过、失败、付款和退款的群把拒绝也删掉。ADR 0488 已经拒绝了那种合并。拒绝本身仍走 `/declinepost`。见 ADR 0403。

## 决策

- `suggested_post_declined` 是对象时，事件带 `asPostDeclined: true`。空对象和空说明也带。不写原帖。
- 说明仍按 ADR 0113 成为正文。已有正文时正文不变，说明不并进去。
- 布尔值不带这个标记。通过、失败、付款和退款不带这个标记。
- 检测器在 `@tasb/detector-decline`，id 是 `post_declined`。只在 `message.asPostDeclined` 为 true 时返回 score 1。证据是 `decline:post`。
- 默认规则关闭。私聊 `/rule <chatId> post_declined on` 之后删除这种提示，`off` 回到留下。
- 不调用 `declineSuggestedPost`。稿子状态不变。付费帖仍不删除。
- 不新增命令。菜单仍是 99 条。
- 不改 ADR 0026 的基础检测器名单。`post_declined` 不在里面。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 默认打开 | 正常的拒绝说明会被删掉。群要自己打开。 |
| 并进 `post_notice` | ADR 0488 已经拒绝。通过和付款是另一类提示。 |
| 没有说明时不标记 | 这行没有正文，关键词看不见。 |
| 把原帖写进证据 | 原帖是另一条消息。说明仍留在正文里。 |
| 新命令 `/decline` | `/declinepost` 已经负责拒绝。菜单还剩 1 个位置。 |

## 后果

- 规则关闭时，拒绝说明留下。说明干净时关键词仍看不见这行，除非说明里本身有关键词或短链。没有说明的那行仍留下。
- 打开 `post_declined` 后，这个群里的这种提示会删除。打开 `post_notice` 仍不删除拒绝。`/declinepost` 仍负责拒绝。付费帖仍留下。待审正文可以另开 `post_pending`。打开 `post_declined` 仍不删除这条正文。见 ADR 0499。
- 自部署没有额度，打开后就会删除。云模式超过当月次数后，还要把 `post_declined` 写进 `QUOTA_BASIC`，否则超额时这条规则会停。
- `chats.json` 整份替换的群要自己加上 `post_declined`，否则 `/rule` 会拒绝。
- 30 天保留期没有改。
