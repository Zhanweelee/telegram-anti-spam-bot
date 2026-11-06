# ADR 0666：频道换头像不再读发送者的名字

- 状态：已接受
- 日期：2026-11-06

## 背景

频道头像被换掉或拿掉时，Android 的 `MessageObject` 在 `TL_messageActionChatEditPhoto` 和 `TL_messageActionChatDeletePhoto` 上，频道且不是超级群时把这行设成 `ActionChannelChangedPhoto`、`ActionChannelChangedVideo` 或 `ActionChannelRemovedPhoto`。英文是 “Channel photo changed”、“Channel video changed” 和 “Channel photo removed”。三句都不画换头像的人。

群和超级群仍用 `replaceWithLink` 画出全名。见 ADR 0631。

Bot API 把频道放在 `chat.type === "channel"`。超级群是 `supergroup`，普通群是 `group`。ADR 0631 仍从 `from` 读名。名上的短链会删掉一条成员看不到这个名字的提示。

## 决策

- `chat.type` 正好是 `channel`，并且这条已经会标成 `photo` 时，不从 `from` 抽主机名。名、姓和用户名都不读。
- 群和超级群仍按全名。没有 `chat`，或类型不是 `channel` 时仍按全名。
- 换头像和删头像的判定不变。同时出现时仍先认换头像。空数组和 false 仍不读。文件号和尺寸仍不读。本群群名仍不读。
- 改群名仍按全名，频道改名这一轮也不改。
- 不新增检测器，不新增命令。菜单仍是 99 条。不改 ADR 0026 的基础检测器名单。`chat_photo` 仍默认关闭。8 个主机名的上限不变。不调用 `deleteChatPhoto` 或 `setChatPhoto`。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 频道继续按全名 | 这行不画人。名上的短链不是成员看到的字。 |
| 超级群也不读 | 超级群这行仍画全名。 |
| 频道改名也不读 | 改名那行在频道上只画新名字。要另看。这一轮只改头像。 |
| 新命令 | 菜单只剩一个空位。现有 `links` 已经能删除短链。 |

## 后果

- 频道换头像或删头像时，发送者名字里的短链、邀请或裸 IP 不再删除这条消息。群和超级群仍会删。发送者是聊天时后来由 ADR 0682 只读这个聊天的标题。频道仍不读。
- 名字不进事件。内容哈希不变。关键词不命中这些名字。
- 正文里的短链仍删除。`example.com` 和公开的 `t.me/名字` 留下。付费帖仍不删除。见 ADR 0356。
- 频道改名后来由 ADR 0667 不再读发送者。群和超级群改名仍按全名。见 ADR 0632。空数组、false、普通图片和普通消息仍不读发送者。管理员仍豁免。干净的提示在 `chat_photo` 关闭时仍留下。云额度的基础检测器名单没有改。30 天保留期没有改。
