---
"@tasb/core": minor
"@tasb/platform-telegram": minor
"@tasb/detector-created": minor
"@tasb/worker": minor
---

默认规则 `group_created` 关闭。私聊 `/rule` 打开后，这个群删除普通群刚建好的提示。发送者名字不进证据。超级群和频道的创建字段不带这个标记。入群和退群仍看 `service_notice`。付费帖仍不删除。不改 ADR 0026 的基础检测器名单。
