---
"@tasb/core": minor
"@tasb/platform-telegram": minor
"@tasb/detector-pending": minor
"@tasb/worker": minor
---

默认规则 `post_pending` 关闭。私聊 `/rule` 打开后，这个群删除待审建议帖正文。价格和发表时间不进证据。通过、失败、付款和退款仍看 `post_notice`。拒绝仍看 `post_declined`。付费帖仍不删除。不改 ADR 0026 的基础检测器名单。
