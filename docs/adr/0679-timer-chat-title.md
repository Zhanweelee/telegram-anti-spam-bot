# ADR 0679：群里聊天改自动删除时只读聊天标题

- 状态：已接受
- 日期：2026-11-06

## 背景

群或超级群改自动删除，或把它关掉时，Android 的 `TL_messageActionSetMessagesTTL` 用 `replaceWithLink` 画出发送者。发送者是用户时，画出全名。发送者是聊天时，画出这个聊天的标题。标题不截断。

所在聊天是频道时，这行是 “Messages in this channel will be automatically deleted after %1$s” 或 “Messages in this channel will no longer be automatically deleted”。两句都不画人。见 ADR 0668。

Bot API 把秒数放在 `message_auto_delete_timer_changed.message_auto_delete_time`。0 表示关掉。发送者是聊天时，`sender_chat` 是那个聊天，`from` 是占位用户。见 `telegram-bot-api` 的 `messageSenderChat`。

ADR 0630 在群和超级群上仍从 `from` 的全名留主机名。占位用户的名字不是这行画出的字。秒数不进事件。

## 决策

- 已经会标成 `asAutoDelete`，并且所在聊天不是频道时，`sender_chat` 是对象就只从 `sender_chat.title` 留主机名，不从 `from` 留主机名。标题不截断。用户名不读。频道、群和超级群代发都一样。0 秒也读。
- 没有 `sender_chat` 时，仍从 `from` 的全名留主机名。名和姓都去掉两端空白，名在前。空白名不挡住姓。空格不截断。
- 所在聊天是频道时仍不读发送者，也不读频道标题。
- 秒数不是大于等于 0 的安全整数时不读。空对象、负数、小数、字符串和布尔值不读。
- 不从 `chat.title` 另读。秒数不进事件。
- 不新增检测器，不新增命令。菜单仍是 99 条。不改 ADR 0026 的基础检测器名单。`autodelete_notice` 仍默认关闭。短链仍走已有的 `links`。8 个主机名的上限不变。不调用 `setChatMessageAutoDeleteTime`。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 继续读 `from` | 占位用户的名字不在这行里。短链会删掉一条没有这个名字的提示。 |
| 频道也读标题 | 频道这行不画人，也不画标题。 |
| 只读频道代发 | 群和超级群自己改计时时同样画标题。 |
| 把秒数收进事件 | 秒数仍由 `/guard` 读取。见 ADR 0486。 |
| 新命令 | 菜单只剩一个空位。现有 `links` 已经能删除短链。 |

## 后果

- 群或超级群里，聊天改计时或关掉计时时，标题里的短链、邀请或裸 IP 会留下主机名。证据只有主机名。计时本身还在。
- 占位用户的名字不再留下主机名。用户仍按全名。
- 频道改计时或关掉计时仍不读发送者。
- 标题原文、路径、用户名和秒数不进事件。内容哈希不变。关键词不命中标题和全名。
- 正文里已有短链时，证据仍先记正文的主机名。
- `example.com` 和公开的 `t.me/名字` 留下。付费帖仍不删除。见 ADR 0356。
- 助推仍只读名。空对象、负数、小数、字符串、布尔值和普通消息仍不读发送者。管理员仍豁免。干净的提示在 `autodelete_notice` 关闭时仍留下。云额度的基础检测器名单没有改。30 天保留期没有改。
