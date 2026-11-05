# ADR 0487：改价提示按群删除

- 状态：已接受
- 日期：2026-11-05

## 背景

超级群改付费发言的星星数量，或频道改私信是否开启和私信星星数量时，各有一条服务消息。星星数量在 `paid_message_price_changed.paid_message_star_count` 或 `direct_message_price_changed.direct_message_star_count`。0 表示改成免费。私信开关在 `are_direct_messages_enabled`。发送者名字画在这条消息上，但那是 `from` 的名字，不进正文。星星数量也不进事件。

这两条提示的正文是空的。关键词看不到它们。删掉提示不会改价格，也不会改私信开关。

## 决策

- `paid_message_price_changed.paid_message_star_count` 是大于等于 0 的安全整数时，事件带 `priceNotice: "paid"`。`direct_message_price_changed.are_direct_messages_enabled` 正好是布尔值时带 `direct`。同时出现时先认付费发言。不写星星数量、开关和发送者名字。
- 空对象、负数、小数、字符串和单独的布尔值不带这个标记。已有正文时，正文仍按原来的优先级。
- 检测器在 `@tasb/detector-price`，id 是 `price_notice`。只在 `message.priceNotice` 是这两种之一时返回 score 1。证据是 `price:paid` 或 `price:direct`。
- 默认规则用同样的 id，关闭。某个群用现有的私聊 `/rule` 打开后，删除这两种提示。没有新命令。菜单仍是 99 条。不改价格，也不改私信开关。
- 付费帖仍不删除。见 ADR 0356。
- 不改 ADR 0026 的基础检测器名单。`price_notice` 不在里面。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 默认删掉全部改价提示 | 有的群靠这条提示知道发言要付费了。打开之前不改现有群。 |
| 付费发言和私信分成两条规则 | 两条都是改价提示，正文都是空的。一个默认关闭的开关就够。 |
| 把星星数量写进证据 | 数量不是广告。价格仍留在 Telegram。 |
| 新命令 `/price` | 菜单只剩一个空位。现有 `/rule` 已经能打开这条规则。 |

## 后果

- 不打开这条规则的群，这两种提示仍留下。星星数量和名字仍不进事件。
- 打开 `price_notice` 后，这个群里的两种改价提示会删除。价格和私信开关不变。付费帖仍留下。
- 自部署没有额度，打开后就会删除。云模式超过当月次数后，还要把 `price_notice` 写进 `QUOTA_BASIC`，否则超额时这条规则会停。
- `chats.json` 整份替换的群要自己加上这条规则，才会有这个开关。
- 30 天保留期不动。
- 改价的人后来由 ADR 0585 只留下主机名。名字本身仍不进事件。星星数量和开关仍不读。不是真实改价提示时，发送者仍不读。
