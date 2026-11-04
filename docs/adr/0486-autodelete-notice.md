# ADR 0486：自动删除提示按群删除

- 状态：已接受
- 日期：2026-11-05

## 背景

管理员改自动删除计时，或把它关掉时，群里出现一条服务消息。秒数在 `message_auto_delete_timer_changed.message_auto_delete_time`。0 表示关掉。发送者名字画在这条消息上，但那是 `from` 的名字，不进正文。秒数也不进事件。查看这个群现在的秒数仍走私聊 `/guard`。见 ADR 0420。

这条提示的正文是空的。关键词看不到它。删掉提示不会改变计时。

## 决策

- `message_auto_delete_timer_changed.message_auto_delete_time` 是大于等于 0 的安全整数时，事件带 `asAutoDelete: true`。不写秒数，也不写发送者名字。0 带这个标记，因为关掉计时同样是一条提示。
- 空对象、负数、小数、字符串和布尔值不带这个标记。已有正文时，正文仍按原来的优先级。
- 检测器在 `@tasb/detector-autodelete`，id 是 `autodelete_notice`。只在 `message.asAutoDelete` 为 true 时返回 score 1。证据是 `autodelete:changed`。
- 默认规则用同样的 id，关闭。某个群用现有的私聊 `/rule` 打开后，删除这条提示。没有新命令。菜单仍是 99 条。不调用 `setChatMessageAutoDeleteTime`。
- 付费帖仍不删除。见 ADR 0356。
- 不改 ADR 0026 的基础检测器名单。`autodelete_notice` 不在里面。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 默认删掉全部自动删除提示 | 有的群靠这条提示知道计时改了。打开之前不改现有群。 |
| 0 不标记 | 关掉计时同样会在群里留一行。打开这条规则的人要的是这一行。 |
| 把秒数写进证据 | 秒数不是广告。`/guard` 已经能读到现在的秒数。 |
| 新命令 `/autodelete` | 秒数已经由 `/guard` 回报。菜单只剩一个空位。现有 `/rule` 已经能打开这条规则。 |

## 后果

- 不打开这条规则的群，改计时的提示仍留下。秒数和名字仍不进事件。
- 打开 `autodelete_notice` 后，这个群里的改计时提示会删除。计时本身还在。`/guard` 仍只回报秒数。付费帖仍留下。
- 自部署没有额度，打开后就会删除。云模式超过当月次数后，还要把 `autodelete_notice` 写进 `QUOTA_BASIC`，否则超额时这条规则会停。
- `chats.json` 整份替换的群要自己加上这条规则，才会有这个开关。
- 30 天保留期不动。
