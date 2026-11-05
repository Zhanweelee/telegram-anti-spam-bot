# ADR 0488：建议帖提示按群删除

- 状态：已接受
- 日期：2026-11-05

## 背景

建议帖被通过、付款失败、付完款或退款时，频道私聊里各有一条服务消息。通过带 `send_date`。失败带 `price`。付款的币种是 `XTR` 或 `TON`。退款原因是 `post_deleted` 或 `payment_refunded`。嵌套的 `suggested_post_message` 是另一条消息。拒绝说明仍按 ADR 0113 成为正文。拒绝本身仍走 `/declinepost`。见 ADR 0403。

这四条提示的正文是空的。关键词看不到它们。删掉提示不会通过、拒绝、付款或退款。

## 决策

- `suggested_post_approved.send_date` 是大于等于 0 的安全整数时，事件带 `postNotice: "approved"`。`suggested_post_approval_failed.price` 是对象时带 `failed`。`suggested_post_paid.currency` 正好是 `XTR` 或 `TON` 时带 `paid`。`suggested_post_refunded.reason` 正好是 `post_deleted` 或 `payment_refunded` 时带 `refunded`。同时出现时先认通过，再认失败，再认付款，再认退款。不写原帖、价格、发表时间和退款原因。
- 空对象、负数、其它币种、其它原因和单独的布尔值不带这个标记。拒绝说明不带这个标记，仍按 ADR 0113 处理。已有正文时，正文仍按原来的优先级。
- 检测器在 `@tasb/detector-post`，id 是 `post_notice`。只在 `message.postNotice` 是这四种之一时返回 score 1。证据是 `post:approved`、`post:failed`、`post:paid` 或 `post:refunded`。
- 默认规则用同样的 id，关闭。某个群用现有的私聊 `/rule` 打开后，删除这四种提示。没有新命令。菜单仍是 99 条。不调用 `approveSuggestedPost` 或 `declineSuggestedPost`。
- 付费帖仍不删除。见 ADR 0356。
- 不改 ADR 0026 的基础检测器名单。`post_notice` 不在里面。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 默认删掉全部建议帖提示 | 有的频道靠这条提示知道稿子过了。打开之前不改现有群。 |
| 连拒绝说明一起删 | 说明已经是正文。关键词和短链仍要看见。见 ADR 0113。 |
| 把原帖或价格写进证据 | 原帖是另一条消息。价格不是这条提示的正文。 |
| 新命令 `/post` | `/declinepost` 已经负责拒绝。菜单只剩一个空位。现有 `/rule` 已经能打开这条规则。 |

## 后果

- 不打开这条规则的群，这四种提示仍留下。拒绝说明仍参与关键词。
- 打开 `post_notice` 后，这个群里的这四种提示会删除。稿子状态不变。`/declinepost` 仍负责拒绝。付费帖仍留下。拒绝可以另开 `post_declined`。打开 `post_notice` 仍不删除这种服务消息。见 ADR 0497。待审正文可以另开 `post_pending`。打开 `post_notice` 仍不删除这条正文。见 ADR 0499。
- 自部署没有额度，打开后就会删除。云模式超过当月次数后，还要把 `post_notice` 写进 `QUOTA_BASIC`，否则超额时这条规则会停。
- `chats.json` 整份替换的群要自己加上这条规则，才会有这个开关。
- 30 天保留期不动。
- 通过、失败、付款或退款的人后来由 ADR 0601 只留下主机名。名字本身仍不进事件。失败的价格是空对象时也读。空的通过对象、负数、其它币种、其它原因和布尔值仍不读发送者。嵌套原帖仍不读。拒绝仍按 ADR 0600。
