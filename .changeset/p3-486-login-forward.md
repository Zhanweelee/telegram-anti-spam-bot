---
"@tasb/core": minor
"@tasb/platform-telegram": minor
"@tasb/detector-login": minor
"@tasb/worker": minor
---

默认规则 `login_forward` 关闭。私聊 `/rule` 打开后，这个群删除带有转发后替换文字的登录按钮。替换文字不进证据。看得见的按钮文字仍参与关键词。内联查询仍由 `switch_query` 决定。付费帖仍不删除。不改 ADR 0026 的基础检测器名单。
