---
"@tasb/core": minor
"@tasb/platform-telegram": minor
"@tasb/detector-rich": minor
"@tasb/worker": minor
---

默认规则 `rich_text_mention` 关闭。私聊 `/rule` 打开后，这个群删除按用户标识的富文本提及。用户编号不进证据。看得见的字仍参与关键词。用户名提及仍由 `rich_mention` 决定。付费帖仍不删除。不改 ADR 0026 的基础检测器名单。
