# ADR 0664：创建抽奖和私下结束不再读发送者的名字

- 状态：已接受
- 日期：2026-11-06

## 背景

创建抽奖时，Android 的 `MessageObject` 在 `TL_messageActionGiveawayLaunch` 上把这行设成 `BoostingGiveawayJustStarted` 或 `BoostingGiveawayJustStartedGroup`。英文是 “%s just started a giveaway…”。占位符是所在频道或群的 `title`。星星抽奖同样只用这个群名。这行没有发送者的名或姓。

私下结束时，`TL_messageActionGiveawayResults` 只画中奖人数和未领取人数。这行也不画发送者。

Bot API 把创建放在 `giveaway_created`，把私下结束放在 `giveaway_completed`。ADR 0590 仍从 `from` 读名。名上的短链会删掉一条成员看不到这个名字的提示。群名已经只留主机名。见 ADR 0656。

## 决策

- `giveaway_created` 是对象，或 `giveaway_completed.winner_count` 是大于等于 0 的安全整数时，不从 `from` 抽主机名。名、姓和用户名都不读。
- 创建公告上画出的 `chat.title` 仍只留主机名。见 ADR 0656。
- 公开中奖者的全名仍读。见 ADR 0640。进行中的卡片和嵌套的 `giveaway_message` 仍不读。
- 不新增检测器，不新增命令。菜单仍是 99 条。不改 ADR 0026 的基础检测器名单。`giveaway_notice` 仍默认关闭。8 个主机名的上限不变。不取消抽奖。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 继续只读名 | 这两行都不画人。名上的短链不是成员看到的字。 |
| 改成全名 | 姓同样不在这两行里。 |
| 群名也不读 | 创建这行仍画出群名。 |

## 后果

- 创建公告和私下结束上，发送者名字里的短链、邀请或裸 IP 不再删除这条消息。群名里的短链仍会删。
- 名字不进事件。内容哈希不变。关键词不命中这些名字。
- 公开中奖者的全名不变。付费帖仍不删除。见 ADR 0356。
- `giveaway_notice` 关闭时，干净的公告仍留下。云额度的基础检测器名单没有改。30 天保留期没有改。
