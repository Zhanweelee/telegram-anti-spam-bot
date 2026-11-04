---
"@tasb/core": minor
"@tasb/platform-telegram": minor
"@tasb/detector-rich": minor
"@tasb/worker": minor
---

默认规则 `rich_phone` 和 `rich_card` 关闭。私聊 `/rule` 打开后，这个群分别删除富文本电话或银行卡。号码不进证据。看得见的字仍参与关键词。邮箱仍不带标记。付费帖仍不删除。不改 ADR 0026 的基础检测器名单。
