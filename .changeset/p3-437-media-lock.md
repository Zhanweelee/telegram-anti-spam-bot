---
"@tasb/core": minor
"@tasb/platform-telegram": minor
"@tasb/detector-media": minor
"@tasb/worker": minor
---

默认规则 `media_sticker`、`media_animation`、`media_voice`、`media_video_note` 和 `media_dice` 关闭。私聊 `/rule` 打开后，这个群只删除这一种。骰子只留类别。付费帖仍不删除。不改 ADR 0026 的基础检测器名单。
