# ADR 0668：频道自动删除不再读发送者的名字

- 状态：已接受
- 日期：2026-11-06

## 背景

频道改自动删除时，Android 的 `MessageObject` 在 `TL_messageActionSetMessagesTTL` 上，所在聊天不是超级群时把这行设成 `ActionTTLChannelChanged` 或 `ActionTTLChannelDisabled`。英文是 “Messages in this channel will be automatically deleted after %1$s” 和 “Messages in this channel will no longer be automatically deleted”。两句都只写时间，不画改计时的人。

群和超级群仍用 `replaceWithLink` 画出全名。见 ADR 0630。

Bot API 把频道放在 `chat.type === "channel"`。超级群是 `supergroup`，普通群是 `group`。ADR 0630 仍从 `from` 读名。名上的短链会删掉一条成员看不到这个名字的提示。秒数不进事件。

## 决策

- `chat.type` 正好是 `channel`，并且 `message_auto_delete_timer_changed.message_auto_delete_time` 是大于等于 0 的安全整数时，不从 `from` 抽主机名。0 秒也算关掉计时。名、姓和用户名都不读。
- 群和超级群仍按全名。没有 `chat`，或类型不是 `channel` 时仍按全名。
- 秒数仍不读。空对象、负数、小数、字符串和布尔值仍不读。
- 不新增检测器，不新增命令。菜单仍是 99 条。不改 ADR 0026 的基础检测器名单。`autodelete_notice` 仍默认关闭。8 个主机名的上限不变。不调用 `setChatMessageAutoDeleteTime`。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 频道继续按全名 | 这行不画人。名上的短链不是成员看到的字。 |
| 超级群也不读 | 超级群这行仍画全名。 |
| 0 秒仍读发送者 | 关掉计时的频道句子同样不画人。 |
| 新命令 | 菜单只剩一个空位。现有 `links` 已经能删除短链。 |

## 后果

- 频道改计时或关掉计时时，发送者名字里的短链、邀请或裸 IP 不再删除这条消息。群和超级群仍会删。发送者是聊天时后来由 ADR 0679 只读这个聊天的标题。频道仍不读。
- 名字不进事件。内容哈希不变。关键词不命中这些名字。
- 正文里的短链仍删除。`example.com` 和公开的 `t.me/名字` 留下。付费帖仍不删除。见 ADR 0356。
- 助推仍只读名。空对象、负数、小数、字符串、布尔值和普通消息仍不读发送者。管理员仍豁免。干净的提示在 `autodelete_notice` 关闭时仍留下。云额度的基础检测器名单没有改。30 天保留期没有改。
