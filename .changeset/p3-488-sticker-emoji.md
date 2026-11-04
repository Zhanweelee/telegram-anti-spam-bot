---
"@tasb/core": minor
"@tasb/platform-telegram": minor
"@tasb/detector-emoji-sticker": minor
"@tasb/worker": minor
---

默认规则 `sticker_emoji` 关闭。私聊 `/rule` 打开后，这个群删除自定义表情贴纸。编号不进证据。普通贴纸仍由 `media_sticker` 决定。正文里的自定义表情仍由 `custom_emoji` 决定。付费帖仍不删除。不改 ADR 0026 的基础检测器名单。
