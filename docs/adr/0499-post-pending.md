# ADR 0499：待审建议帖按群删除

- 状态：已接受
- 日期：2026-11-05

## 背景

频道私聊里的建议帖正文带 `suggested_post_info`。`state` 可以是 `pending`、`approved` 或 `declined`。待审时还可以带 `price` 和 `send_date`。币种是 `XTR` 或 `TON`。正文已经是这条消息自己的文字。通过、失败、付款和退款是另一条服务消息，见 ADR 0488。拒绝是另一条服务消息，见 ADR 0497。

待审正文里的广告词干净时，关键词看不见它。把它并进 `post_notice` 或 `post_declined` 会让只想删提示的群把稿子正文也删掉。

## 决策

- `suggested_post_info.state` 正好是 `pending` 时，事件带 `asPostPending: true`。`approved`、`declined`、空对象、缺省状态和布尔值不带这个标记。
- 已有正文时正文不变。价格、币种和发表时间不进事件。
- 检测器在 `@tasb/detector-pending`，id 是 `post_pending`。只在 `message.asPostPending` 为 true 时返回 score 1。证据是 `post:pending`。
- 默认规则关闭。私聊 `/rule <chatId> post_pending on` 之后删除这种正文，`off` 回到留下。
- 不调用 `approveSuggestedPost` 或 `declineSuggestedPost`。稿子状态不变。付费帖仍不删除。
- 不新增命令。菜单仍是 99 条。
- 不改 ADR 0026 的基础检测器名单。`post_pending` 不在里面。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 默认打开 | 正常的待审稿会被删掉。群要自己打开。 |
| 并进 `post_notice` | ADR 0488 只管通过、失败、付款和退款。待审是稿子正文。 |
| 并进 `post_declined` | ADR 0497 只管拒绝提示。待审还没有被拒绝。 |
| 把价格或发表时间写进证据 | 价格和发表时间不是正文。这不是支付功能。 |
| 已通过或已拒绝的正文也标 | 那两条服务消息已经有自己的规则。 |
| 新命令 `/pending` | 菜单还剩 1 个位置，留给以后的操作命令。 |

## 后果

- 规则关闭时，待审正文留下。通过、失败、付款和退款仍看 `post_notice`。拒绝仍看 `post_declined`。
- 打开 `post_pending` 后，这个群里的待审正文会删除。打开 `post_notice` 或 `post_declined` 仍不删除这条正文。付费帖仍留下。
- 自部署没有额度，打开后就会删除。云模式超过当月次数后，还要把 `post_pending` 写进 `QUOTA_BASIC`，否则超额时这条规则会停。
- `chats.json` 整份替换的群要自己加上 `post_pending`，否则 `/rule` 会拒绝。
- 30 天保留期没有改。
