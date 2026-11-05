# ADR 0496：话题新建和改名按群删除

- 状态：已接受
- 日期：2026-11-05

## 背景

论坛里新建话题时，`forum_topic_created` 带上话题名。改名时，`forum_topic_edited` 仍带上新名字。没有别的正文时，这段名字已经按 ADR 0088 成为正文。名字干净时这行会留下。只改图标时没有名字，正文是空的，关键词看不见这行。图标颜色和自定义表情编号不是广告。把它并进 `forum_notice` 会让只想删关掉、重开、隐藏和重新显示的群把新建和改名也删掉。ADR 0485 已经拒绝了那种合并。

## 决策

- `forum_topic_created.name` 是非空字符串时，事件带 `topicNotice: "created"`。`forum_topic_edited.name` 是非空字符串，或 `icon_custom_emoji_id` 是字符串时，带 `edited`。同时出现时先认新建。空的新建名字落到改名。不写图标颜色和自定义表情编号。
- 话题名仍按 ADR 0088 成为正文。已有正文时正文不变，名字不并进去。`is_name_implicit` 不改变这个标记。
- 空对象和布尔值不带这个标记。关掉、重开、隐藏和重新显示不带这个标记。
- 检测器在 `@tasb/detector-topic`，id 是 `topic_notice`。`message.topicNotice` 是新建或改名时返回 score 1。证据是 `topic:created` 或 `topic:edited`。
- 默认规则关闭。私聊 `/rule <chatId> topic_notice on` 之后删除这两种提示，`off` 回到留下。
- 不调用 `editForumTopic`、`closeForumTopic` 或 `reopenForumTopic`。话题本身还在。付费帖仍不删除。
- 不新增命令。菜单仍是 99 条。
- 不改 ADR 0026 的基础检测器名单。`topic_notice` 不在里面。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 默认打开 | 正常建话题会被删掉。群要自己打开。 |
| 并进 `forum_notice` | ADR 0485 已经拒绝。关掉和重开是另一类提示。 |
| 只改图标时不标记 | 这行没有名字，关键词看不见。 |
| 把表情编号写进证据 | 编号不是广告。名字仍留在正文里。 |
| 新命令 `/topic` | 菜单还剩 1 个位置，留给以后的操作命令。 |

## 后果

- 规则关闭时，新建和改名都留下。名字干净时关键词仍看不见这行，除非名字里本身有关键词或短链。只改图标的那行仍留下。
- 打开 `topic_notice` 后，这个群里的这两种提示会删除。打开 `forum_notice` 仍不删除新建和改名。付费帖仍留下。
- 自部署没有额度，打开后就会删除。云模式超过当月次数后，还要把 `topic_notice` 写进 `QUOTA_BASIC`，否则超额时这条规则会停。
- `chats.json` 整份替换的群要自己加上 `topic_notice`，否则 `/rule` 会拒绝。
- 30 天保留期没有改。
- 内联按钮上的自定义表情后来由 ADR 0519 另开 `button_emoji`。论坛话题图标仍只走 `topic_notice`。编号仍不进事件。
- 关掉、重开、隐藏和重新显示上画出的发送者名字后来由 ADR 0589 只留下主机名。新建和改名仍不读 `from`。话题名仍按 ADR 0088。
