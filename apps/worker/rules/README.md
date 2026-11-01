# 规则文件

`default.json` 是每个群的默认 RuleSet。`chats.json` 的键是 `chatId`，值是一份完整 RuleSet，用来替换该群的默认规则，不是和默认规则合并。

Worker 每次检测先读缓存端口。未命中才读这两个文件，不读 D1。文件内容过不了 schema 时，该群放行，日志只有 `rules_invalid`。

关键词列表仍在检测器配置里。这里只决定阈值、启用状态和动作。动作可以是 `delete`、`mute`、`ban` 或 `captcha`。mute 的时长不在这份 JSON 里，Worker 里的动作配置是 3600 秒。ban 不会自动删除消息。默认规则里的 `new_member` 在入群时要求按钮验证，时长 300 秒，写在动作配置里。`join_name` 在昵称、姓氏或用户名命中关键词时封禁，不再发验证按钮。`flood` 是同一人 10 秒 5 条，`repeat` 是同一哈希 60 秒 3 次，动作都是 delete。阈值和窗口在检测器配置里，不在这份 JSON 里。`links` 删除短链接和裸 IP，也删除藏在 text_link 里的这些主机名，不删除普通网址。`shared_blocklist` 在该群 opt-in 打开后删除共享名单里的 actor id 或内容哈希；默认关闭，关闭时这条规则不会读共享名单。`regex_hint` 默认关闭。打开后按检测器里的短模式删除，证据只有 `regex:hit`。`channel_forward` 默认开启，删除频道转发，不删除用户转发。`chats.json` 整份替换默认规则，所以 `-100777` 目前没有验证、入群昵称、洪泛、重复、链接、黑名单、正则和频道转发规则。
