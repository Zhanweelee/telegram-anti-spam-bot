# ADR 0032：共享名片只留标记

- 状态：已接受
- 日期：2026-11-01

## 背景

Telegram 的 `contact` 消息带电话、姓名、user id 和 vCard。可见正文经常是空的，关键词和链接都看不见它。电话和姓名是个人数据，不能写进事件。

正文里的一串数字可能是订单号。这轮不扫正文。

## 决策

- 消息可以带 `contact: true`。只有更新里真有 `contact` 对象时才设置。电话、姓名、user id、vCard 全部丢掉。
- 检测器 id 是 `contact`，放在 `@tasb/detector-contact`。只在 `kind: message` 且带这个标记时返回 score 1。证据是 `contact:card`。
- 默认规则 `shared_contact` 对 `message` 启用，动作是 delete。
- 不改 ADR 0026 的基础检测器名单。`contact` 不在默认 `QUOTA_BASIC` 里。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 把电话存进事件再匹配 | 电话是个人数据，和原文默认不落盘冲突。 |
| 用正则扫正文里的数字 | 订单号和门牌会被删。名片对象本身已经是明确信号。 |
| 平台层看到名片就直接删 | 群规则关不掉。 |

## 后果

- 自部署默认不走额度，`shared_contact` 一直有效。
- 云模式超过当月次数后，这条规则会停，直到 `QUOTA_BASIC` 写上 `contact`。
- `chats.json` 整份替换的群要自己加上 `shared_contact`。
- 只写在正文里的电话号码这轮不会删。
