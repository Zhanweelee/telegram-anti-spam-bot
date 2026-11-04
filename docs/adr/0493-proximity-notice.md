# ADR 0493：靠近提醒按群删除

- 状态：已接受
- 日期：2026-11-05

## 背景

两个人共享实时位置并靠近时，群里出现 `proximity_alert_triggered`。触发者和设置者的可见名字已经按 ADR 0121 成为正文。名字干净时这行会留下。距离不进事件，关键词看不到它。把它并进 `bare_location` 会让只想删纯坐标的群把靠近提醒也删掉。

## 决策

- `proximity_alert_triggered.distance` 是大于等于 0 的安全整数时，事件带 `asProximity: true`。不写距离，也不写用户编号。两个人的名字仍按 ADR 0121 成为正文。
- 空对象、负数、小数、字符串和布尔值不带这个标记。0 米带这个标记。
- 已有正文时正文不变。发送者姓名仍不进事件。
- 检测器在 `@tasb/detector-proximity`，id 是 `proximity_notice`。只在 `message.asProximity` 为 true 时返回 score 1。证据是 `proximity:near`。
- 默认规则关闭。私聊 `/rule <chatId> proximity_notice on` 之后删除这种提醒，`off` 回到留下。
- 不调用位置相关的方法。距离本身不变。付费帖仍不删除。
- 不新增命令。菜单仍是 99 条。
- 不改 ADR 0026 的基础检测器名单。`proximity_notice` 不在里面。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 默认打开 | 普通靠近提醒会被删掉。群要自己打开。 |
| 并进 `bare_location` | 只想删纯坐标的群会把靠近提醒也删掉。 |
| 把距离写进证据 | 距离不是广告。名字仍留在正文里。 |
| 新命令 `/near` | 菜单还剩 1 个位置，留给以后的操作命令。 |

## 后果

- 规则关闭时，靠近提醒留下。名字干净时关键词仍看不见这行，除非名字里本身有关键词或短链。
- 打开 `proximity_notice` 后，这个群里的靠近提醒会删除。纯坐标仍只看 `bare_location`。付费帖仍留下。
- 自部署没有额度，打开后就会删除。云模式超过当月次数后，还要把 `proximity_notice` 写进 `QUOTA_BASIC`，否则超额时这条规则会停。
- `chats.json` 整份替换的群要自己加上 `proximity_notice`，否则 `/rule` 会拒绝。
- 30 天保留期没有改。
