# ADR 0414：私聊可以设置 bot 的默认简介

- 状态：已接受
- 日期：2026-11-04

## 背景

默认名字已经可以设置和查看。bot 的简介出现在和 bot 的空聊天里。官方设置调用是 `setMyDescription`。

`description` 可选，0 到 512 个字符。空字符串清掉给定语言的专用简介。`language_code` 可选。不送时，这个简介给所有没有专用语言简介的人看。已经有单独语言简介的人继续用原来的简介。

## 决策

- 私聊命令 `/botdesc [description]`。不写简介时送空字符串，清掉默认简介。写出的简介按空白折成一段，长度 1 到 512 才发出请求。更长的简介回复「参数无效」。群聊里的同样文本不执行。
- 只有配置里的管理员可以改。接入目录里的人即使管着自己的群也不能改。超长简介在权限判断之前拒绝。
- 调用 `ModerationPort.setBotDescription`。适配器调用 `setMyDescription`。正文只有 `description`。不送 `language_code`。
- 回复不重复简介。设置和清除都写明已有单独语言简介的人不受影响。
- 没有 token 或调用失败时回复「参数无效」。日志只写 `operator_rejected`，带上 eventId、chatId 和命令名 `botdesc`。不写异常文本、token、原文或简介。
- 没有 token 的 Worker 不把内存记录回复成已经设置。
- 不调用 `getMyDescription`。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 带上 `language_code` | 那会改某一个语言的专用简介。这次只改默认简介。 |
| 不送 `description` 来表示清除 | 显式送出空字符串，设置和清除才能分开验收。 |
| 把简介写进回复 | 简介会离开 Worker。 |

## 后果

- 成功只表示 Telegram 接受了一次 `setMyDescription`。已有单独语言简介的人不受影响。
- 一次设置是一次 Telegram 子请求。封禁、禁言和黑名单都不变。
- 30 天保留期不动。
