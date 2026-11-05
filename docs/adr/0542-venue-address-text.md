# ADR 0542：地点地址也走关键词和默认正则

- 状态：已接受
- 日期：2026-11-05

## 背景

ADR 0059 用 `venue.title` 当正文，并拒绝把地址拼进正文。地址常是街道和门牌，拼进去会改变 `textSha256`，也会把位置写进哈希。ADR 0080 只从 `venue.address` 抽出主机名。标题干净时，「免费领取」和「加微x」可以整段留在地址上。短链仍会删除，关键词看不见。地点卡片上的地址一直能看见。

Bot API 没有写 `venue.address` 的长度。收到的地址按其它没有写明长度的可见文字处理，只留前 4096 字。

## 决策

- 已有别的正文，或正文是空的，且 `message.venue.address` 去掉两端空白后仍有字时，事件另留 `venueAddress`。只留前 4096 字。这段文字自己就是正文时不设这个字段。正文和 `textSha256` 仍按 ADR 0059，标题优先。没有标题时正文仍是空字符串，哈希也不含地址。
- 第 4097 字起不进事件。主机名仍从整段地址抽取，包括被截掉的尾巴。
- 不读 `venue.location`、`foursquare_id`、`google_place_id`、`foursquare_type`、`google_place_type` 和纯 `location` 的坐标。投票媒体和说明媒体里的场馆地址仍只留主机名，不进这个字段。
- 关键词和 `regex` 同时看正文、`senderTag`、`buttonText`、`authorSignature`、`mirrorSignature`、`pollOption`、`checklistTask`、`mediaName`、`performer`、`gameText`、`invoiceText`、`venueAddress` 和 `profile`。证据仍是原来的摘要。地址原文不进证据，也不进日志。审计仍只留 `textSha256`。
- `regex` 命中时带上 `places`，只写命中的字段名。`venueAddress` 加入这份名单。`venue_address_regex` 只在 `places` 含有 `venueAddress` 时算命中。检测器没有 `places` 时仍按分数。
- 规则条件增加 `venueAddress: true`。消息上有这个字段时为真。
- 新规则 `venue_address_regex` 默认打开。条件是这个字段，检测器是现有的 `regex`，命中后 `delete`。
- 「免费领取」和「加微信」仍走已经打开的关键词规则。
- `regex_hint` 仍默认关闭。正文里的「加微x」不会因为旁边有干净的地址就被删掉。
- 不改 ADR 0026 的基础检测器名单。`keyword` 和 `regex` 已经在里面，超额后这条仍会跑。
- `chats.json` 整份替换的群不会自动带上这条规则。
- 不新增命令。菜单仍是 99 条。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 把地址拼进标题 | 会改变 `textSha256`，并把街道写进哈希。ADR 0059 已经拒绝。 |
| 没有标题时用地址当正文 | 同样会把位置写进哈希。旁路字段可以让关键词看见，哈希仍是空正文。 |
| 连投票媒体里的地址一起收 | 那一层现在只留主机名。这条消息自己的地点卡片已经盖住看得见的地址。 |
| 给地址单独做一个检测器 | 关键词和正则已经会扫旁路字段。名单不用再加一项。 |

## 后果

- 地点地址含「免费领取」或「加微信」时按关键词删除。含 `t.me/+`、「加微x」或「加微X」时按 `venue_address_regex` 删除。证据不含地址原文。
- 地址干净时消息留下。地址自己就是正文时，「加微x」仍要打开 `regex_hint`。
- 第 4097 个字符起不进事件。主机名仍从整段地址抽取。写在地址里的路径会留在 `venueAddress`，不进审计。
- 坐标、地点 id 和地点类型仍不进事件。投票媒体里的地址仍不进这个字段。
- 关掉这条规则后，这种地址回到只看关键词和短链。
- 整份替换规则的群要自己加上这条，才会删除地址上的「加微x」。
- 30 天保留期没有改。
- `places` 后来由 ADR 0543 加上 `pollExplanation`。测验说明的规则只认自己的字段。
