# ADR 0409：私聊可以清掉命令菜单

- 状态：已接受
- 日期：2026-11-04

## 背景

ADR 0407 设置私聊命令菜单，ADR 0408 读取它。还要能清掉这一层。官方清除调用是 `deleteMyCommands`。

可选参数是 `scope` 和 `language_code`。清掉之后，更高一层已经设置的菜单会显示出来。不送 `language_code` 时，只清掉该范围内还没有单独语言列表的那一份。

## 决策

- 私聊命令 `/delcommands [private]`。没有参数和唯一的 `private` 都清掉私聊菜单。多出来的参数不发出请求。别的单词回复「参数无效」。群聊里的同样文本不执行。
- 只有配置里的管理员可以改。接入目录里的人即使管着自己的群也不能改。
- 调用 `ModerationPort.deleteCommandMenu`。适配器调用 `deleteMyCommands`。范围固定是 `{ type: "all_private_chats" }`。不送 `language_code`，也不送 `chat_id` 或 `commands`。
- 回复不重复命令目录，并写明更高一层的菜单会显示出来、群菜单不变、已有单独语言列表的人不受影响。
- 没有 token 或调用失败时回复「参数无效」。日志只写 `operator_rejected`，带上 eventId、chatId 和命令名 `delcommands`。不写异常文本、token 或原文。
- 没有 token 的 Worker 不把内存记录回复成已经清掉。
- 不调用 `setMyCommands` 或 `getMyCommands`。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 用默认范围，把群菜单一起清掉 | 群菜单不在这次要清的范围内。 |
| 同时清掉每一种语言 | 那会改掉已经单独设置的语言列表。这次不送 `language_code`。 |
| 把清除并进 `/setcommands` 的空列表 | 空的 `commands` 不是这条官方调用。清除是 `deleteMyCommands`。 |

## 后果

- 成功只表示 Telegram 接受了一次 `deleteMyCommands`。更高一层的菜单会显示出来。群菜单不变。已经有单独语言列表的人不受影响。
- 一次清除是一次 Telegram 子请求。封禁、禁言和黑名单都不变。
- 30 天保留期不动。
