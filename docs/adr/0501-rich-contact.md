# ADR 0501：富文本电话和银行卡按群删除

- 状态：已接受
- 日期：2026-11-05

## 背景

富文本里的电话和银行卡可以和看得见的字不同。字段是 `phone_number` 和 `bank_card_number`。ADR 0076 让这些字段不进事件，关键词看不见号码。看得见的字已经可以成为正文。

邮箱仍是另一类字段。这一轮不给它加标记。

## 决策

- `type` 正好是 `phone_number`，并且 `phone_number` 去掉空白后非空时，事件带 `asRichPhone: true`。`bank_card_number` 同样非空时带 `asRichCard: true`。空白和布尔值不带标记。
- 号码不进事件，也不进证据。看得见的字仍是正文。已有 `text` 或 `caption` 时正文不变，号码不并进去。
- 两个检测器都在 `@tasb/detector-rich`。`rich_phone` 只在 `message.asRichPhone` 为 true 时返回 score 1，证据是 `rich:phone`。`rich_card` 只在 `message.asRichCard` 为 true 时返回 score 1，证据是 `rich:card`。
- 两条默认规则都关闭。私聊 `/rule <chatId> rich_phone on` 或 `rich_card on` 之后只删除这一种，`off` 回到留下。
- 邮箱不带标记。不调用读取或改写联系方式的方法。付费帖仍不删除。
- 不新增命令。菜单仍是 99 条。
- 不改 ADR 0026 的基础检测器名单。`rich_phone` 和 `rich_card` 不在里面。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 合成一条开关 | 只想删银行卡的群会把电话也删掉。 |
| 把号码接到正文后面 | 同一条消息的哈希会变，证件号也会进事件。ADR 0076 已经拒绝。 |
| 把号码写进证据 | 证件号不进事件。 |
| 默认打开 | 有的群用富文本留联系方式。打开之前不改现有群。 |
| 新命令 `/phone` 和 `/card` | 菜单还剩 1 个位置，留给以后的操作命令。 |

## 后果

- 规则关闭时，富文本电话和银行卡留下。看得见的字仍参与关键词。号码仍不进事件。
- 打开 `rich_phone` 后，这个群里的富文本电话会删除，银行卡仍留下。打开 `rich_card` 则相反。付费帖仍留下。
- 自部署没有额度，打开后就会删除。云模式超过当月次数后，还要把对应 id 写进 `QUOTA_BASIC`，否则超额时这条规则会停。
- `chats.json` 整份替换的群要自己加上 `rich_phone` 和 `rich_card`，否则 `/rule` 会拒绝。
- 30 天保留期没有改。
- 非空邮箱后来由 ADR 0502 另开 `rich_email`。地址仍不进事件。
