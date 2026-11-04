# ADR 0485：论坛提示按群删除

- 状态：已接受
- 日期：2026-11-05

## 背景

论坛话题被关掉、重新打开，或者通用话题被隐藏、重新显示时，群里各有一条服务消息。这四个对象目前没有字段。见官方 `ForumTopicClosed`、`ForumTopicReopened`、`GeneralForumTopicHidden` 和 `GeneralForumTopicUnhidden`。新建和改名仍把话题名当成正文。见 ADR 0088。关掉和重开本身仍走 `/closetopic` 和 `/opentopic`。见 ADR 0381 和 ADR 0382。

这四条提示的正文是空的。关键词看不到它们。删掉提示不会改变话题开关。

## 决策

- `forum_topic_closed` 是对象时，事件带 `forumNotice: "closed"`。`forum_topic_reopened` 是对象时带 `reopened`。`general_forum_topic_hidden` 是对象时带 `hidden`。`general_forum_topic_unhidden` 是对象时带 `shown`。不写名字、图标和话题号。
- 几种同时出现时先认关掉，再认重开，再认隐藏，再认重新显示。布尔值不带这个标记。空对象带这个标记，因为官方对象本身没有字段。
- 新建和改名不带这个标记。话题名仍按 ADR 0088 处理。
- 检测器在 `@tasb/detector-forum`，id 是 `forum_notice`。只在 `message.forumNotice` 是这四种之一时返回 score 1。证据是 `forum:closed`、`forum:reopened`、`forum:hidden` 或 `forum:shown`。
- 默认规则用同样的 id，关闭。某个群用现有的私聊 `/rule` 打开后，删除这四种提示。没有新命令。菜单仍是 99 条。不调用 `closeForumTopic`、`reopenForumTopic`、`hideGeneralForumTopic` 或 `unhideGeneralForumTopic`。
- 付费帖仍不删除。见 ADR 0356。
- 不改 ADR 0026 的基础检测器名单。`forum_notice` 不在里面。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 默认删掉全部论坛提示 | 有的群靠这条提示知道话题已经关掉。打开之前不改现有群。 |
| 连新建和改名一起删 | 话题名已经是正文。关键词和短链仍要看见。见 ADR 0088。 |
| 空对象不标记 | 官方这四个对象没有字段。空对象就是这条提示。 |
| 新命令 `/forum` | 关闭、打开、隐藏和显示已经各有操作命令。菜单只剩一个空位。现有 `/rule` 已经能打开这条规则。 |

## 后果

- 不打开这条规则的群，这四种提示仍留下。新建和改名的话题名仍参与关键词。
- 打开 `forum_notice` 后，这个群里的这四种提示会删除。话题开关不变。`/closetopic`、`/opentopic`、`/hidegeneral` 和 `/showgeneral` 仍负责改状态。付费帖仍留下。新建和改名可以另开 `topic_notice`。打开 `forum_notice` 仍不删除这两种服务消息。见 ADR 0496。
- 自部署没有额度，打开后就会删除。云模式超过当月次数后，还要把 `forum_notice` 写进 `QUOTA_BASIC`，否则超额时这条规则会停。
- `chats.json` 整份替换的群要自己加上这条规则，才会有这个开关。
- 30 天保留期不动。
