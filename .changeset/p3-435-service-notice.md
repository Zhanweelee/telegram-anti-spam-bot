---
"@tasb/core": minor
"@tasb/platform-telegram": minor
"@tasb/detector-notice": minor
"@tasb/worker": minor
---

默认规则 `service_notice` 关闭。私聊 `/rule` 打开后，这个群的入群和退群服务消息会被删除。没打开时干净的入群提示仍留下，退群提示仍不删。入群验证不变。不改 ADR 0026 的基础检测器名单。
