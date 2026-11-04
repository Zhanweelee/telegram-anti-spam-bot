---
"@tasb/core": minor
"@tasb/platform-telegram": minor
"@tasb/detector-decline": minor
"@tasb/worker": minor
---

默认规则 `post_declined` 关闭。私聊 `/rule` 打开后，这个群删除建议帖被拒绝的提示。原帖不进证据。拒绝说明仍参与关键词。没有说明时这行也会删除。通过、失败、付款和退款仍看 `post_notice`。付费帖仍不删除。不改 ADR 0026 的基础检测器名单。
