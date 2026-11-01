# 规则文件

`default.json` 是每个群的默认 RuleSet。`chats.json` 的键是 `chatId`，值是一份完整 RuleSet，用来替换该群的默认规则，不是和默认规则合并。

Worker 每次检测先读缓存端口。未命中才读这两个文件，不读 D1。文件内容过不了 schema 时，该群放行，日志只有 `rules_invalid`。

关键词列表仍在检测器配置里。这里只决定阈值、启用状态和动作。
