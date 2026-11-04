# ADR 0408：私聊可以查看命令菜单

- 状态：已接受
- 日期：2026-11-04

## 背景

ADR 0407 让配置里的管理员设置私聊命令菜单。设置之后还要能看出现在的列表。官方读取调用是 `getMyCommands`。

可选参数是 `scope` 和 `language_code`。不送 `language_code` 时读的是该范围内还没有单独语言列表的那一份。返回 `BotCommand` 数组。没设置时是空数组。

这不改菜单，也不改群。

## 决策

- 私聊命令 `/commands [private]`。没有参数和唯一的 `private` 都读私聊菜单。多出来的参数不发出请求。别的单词回复「参数无效」。群聊里的同样文本不执行。
- 只有配置里的管理员可以看。接入目录里的人即使管着自己的群也不能看。
- 调用 `ModerationPort.readCommandMenu`。适配器调用 `getMyCommands`。范围固定是 `{ type: "all_private_chats" }`。不送 `language_code`，也不送 `chat_id`。
- 回复第一行是条数。后面每行是命令、说明和临时标记。空数组只写 0。
- `is_ephemeral` 缺省写未知。true 是 on，false 是 off。非布尔值让整份回复变成「参数无效」。
- 命令名必须是 1 到 32 个小写英文字母、数字或下划线。说明必须是 1 到 256 个字符，并且不能换行。重复命令、超过 100 条、结果不是数组，都让整份回复变成「参数无效」。已经读到的命令不写进回复。
- 多出来的字段不进回复。放不下 3500 字时保留前面的命令，并写上剩下的个数。
- 没有 token、结果不合法或调用失败时回复「参数无效」。日志只写 `operator_rejected`，带上 eventId、chatId 和命令名 `commands`。不写异常文本、token 或原文。
- 没有 token 的 Worker 不编一份菜单。
- 不调用 `setMyCommands` 或 `deleteMyCommands`。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 把读取并进 `/setcommands` 的无参数形式 | `/setcommands` 没有参数时是设置。读取是另一条调用。 |
| 空数组当成失败 | 没设置时 Telegram 返回空数组。这和调用失败要分开。 |
| 缺 `is_ephemeral` 当成 false | 设置命令时没有送这个字段。false 和「不知道」会变成同一种回复。 |
| 坏记录只跳过 | 操作者会以为菜单只剩前面几条。 |

## 后果

- 成功只表示 Telegram 返回了一份 `BotCommand` 数组。群菜单不变。已经有单独语言列表的人不受影响。
- 一次查看是一次 Telegram 子请求。封禁、禁言和黑名单都不变。
- 30 天保留期不动。
- 默认 99 条菜单的第一页后来停在 `repeat`。`/commands` 由 ADR 0523 接受 `skip`，从指定条数继续列。不写 `skip` 时仍是这一页。
