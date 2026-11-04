# ADR 0498：建群提示按群删除

- 状态：已接受
- 日期：2026-11-05

## 背景

普通群刚建好时，`group_chat_created` 是一条服务消息。这条消息没有正文。关键词看不见它。官方说明里，超级群和频道的创建字段不能从更新里收到，只可能出现在回复的原消息上。原消息不在这条更新里展开。

把它并进 `service_notice` 会让只想删入群和退群的群把建群提示也删掉。见 ADR 0467。

## 决策

- `group_chat_created` 正好是 `true` 时，事件带 `asGroupCreated: true`。`false`、超级群创建和频道创建不带这个标记。
- 已有正文时正文不变。发送者名字不进事件。
- 检测器在 `@tasb/detector-created`，id 是 `group_created`。只在 `message.asGroupCreated` 为 true 时返回 score 1。证据是 `group:created`。
- 默认规则关闭。私聊 `/rule <chatId> group_created on` 之后删除这种提示，`off` 回到留下。
- 不调用建群方法。群还在。付费帖仍不删除。
- 不新增命令。菜单仍是 99 条。
- 不改 ADR 0026 的基础检测器名单。`group_created` 不在里面。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 默认打开 | 有的群留着这条提示当建群记录。打开之前不改现有群。 |
| 并进 `service_notice` | ADR 0467 只管入群和退群。建群是另一条提示。 |
| 连超级群和频道创建一起标 | 这两条不能从更新里收到。回复里的原消息不展开。 |
| 新命令 `/created` | 菜单还剩 1 个位置，留给以后的操作命令。 |

## 后果

- 规则关闭时，建群提示留下。入群和退群仍看 `service_notice`。
- 打开 `group_created` 后，这个群里的这种提示会删除。打开 `service_notice` 仍不删除建群提示。付费帖仍留下。
- 自部署没有额度，打开后就会删除。云模式超过当月次数后，还要把 `group_created` 写进 `QUOTA_BASIC`，否则超额时这条规则会停。
- `chats.json` 整份替换的群要自己加上 `group_created`，否则 `/rule` 会拒绝。
- 30 天保留期没有改。
