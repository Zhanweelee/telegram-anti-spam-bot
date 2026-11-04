# ADR 0416：私聊可以设置 bot 的默认短简介

- 状态：已接受
- 日期：2026-11-04

## 背景

短简介显示在 bot 的资料页，也会跟着分享链接一起发出去。设置调用是 `setMyShortDescription`。

`short_description` 可选，0 到 120 个字符。空字符串清掉这一语言的专用短简介。`language_code` 可选。不送时，改的是没有专用语言短简介的人看到的那一份。

## 决策

- 私聊命令 `/botshort [short]`。不写短简介时送空字符串，清掉默认短简介。写出的短简介按空白折成一段，长度 1 到 120 才发出请求。更长的短简介回复「参数无效」。群聊里的同样文本不执行。
- 只有配置里的管理员可以改。接入目录里的人即使管着自己的群也不能改。超长在权限判断之前拒绝。
- 调用 `ModerationPort.setBotShortDescription`。适配器调用 `setMyShortDescription`。正文只带 `short_description`。不送 `language_code`。
- 回复写明已有单独语言短简介的人不受影响。回复和日志都不重复短简介。
- 日志只写 `operator_rejected` 或命令名，带上 eventId、chatId 和命令名 `botshort`。不写短简介、异常文本或 token。
- 没有 token 的 Worker 不把内存记录回复成已经设置。
- 不调用 `getMyShortDescription`。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 顺带改某一个语言的短简介 | 那要送 `language_code`。这次只改默认短简介。 |
| 回复里带上短简介 | 短简介可能含运营文案。管理员已经在命令里写过。 |
| 空参数当成用法错误 | 清掉默认短简介需要一次明确的空字符串请求。 |

## 后果

- 成功只表示 Telegram 接受了这一次 `setMyShortDescription`。已有单独语言短简介的人不受影响。
- 一次设置是一次 Telegram 子请求。封禁、禁言和黑名单都不变。
- 30 天保留期不动。
