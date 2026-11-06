# ADR 0663：预约视频聊天不再读发送者的名字

- 状态：已接受
- 日期：2026-11-06

## 背景

预约视频聊天时，Android 的 `MessageObject` 在 `TL_messageActionGroupCallScheduled` 上把这行设成 `ActionGroupCallScheduled` 或 `ActionChannelCallScheduled`。英文是 “Voice chat scheduled on %1$s” 和 “Live stream scheduled on %1$s”。占位符只有开始时间。这行没有 `un1`，也不调用 `getFirstName` 或 `getShortName`。

开始和结束仍用 `replaceWithLink`。那是 `UserObject.getUserName`，全名。见 ADR 0635。

Bot API 把预约放在 `video_chat_scheduled.start_date`。ADR 0588 和 ADR 0635 仍从 `from` 读名。名上的短链会删掉一条成员看不到这个名字的提示。

## 决策

- 已经标成 `scheduled`，并且没有先被认成开始或结束时，不从 `from` 抽主机名。名、姓和用户名都不读。
- 同一条上 `video_chat_started` 是对象时，仍按开始的全名。结束的时长仍按全名。见 ADR 0635。频道开始或结束后来由 ADR 0669 不再读发送者。群和超级群仍按全名。
- 正文里的短链仍按原来的 `links`。开始时间、本群群名和用户名仍不读。
- 不新增检测器，不新增命令。菜单仍是 99 条。不改 ADR 0026 的基础检测器名单。`call_notice` 仍默认关闭。8 个主机名的上限不变。不改视频聊天。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 预约继续只读名 | 这行不画人。名上的短链不是成员看到的字。 |
| 预约改成全名 | 姓同样不在这行里。 |
| 开始和结束也不读 | 群里的开始和结束仍画出全名。 |

## 后果

- 预约提示上，发送者名字里的短链、邀请或裸 IP 不再删除这条消息。群和超级群的开始和结束仍会删。频道开始或结束后来由 ADR 0669 不再读发送者。
- 名字不进事件。内容哈希不变。关键词不命中这些名字。
- 正文里已有短链时仍删除，证据仍先记正文的主机名。付费帖仍不删除。见 ADR 0356。
- 管理员仍豁免。`call_notice` 关闭时，干净的预约提示仍留下。云额度的基础检测器名单没有改。30 天保留期没有改。
