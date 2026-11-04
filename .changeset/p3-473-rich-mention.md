---
"@tasb/core": minor
"@tasb/platform-telegram": minor
"@tasb/detector-rich": minor
"@tasb/worker": minor
---

默认规则 `rich_mention` 关闭。私聊 `/rule` 打开后，这个群删除富文本用户名提及。用户名不进证据。看得见的字仍参与关键词。邮箱仍由 `rich_email` 决定。付费帖仍不删除。不改 ADR 0026 的基础检测器名单。
