# ADR 0407：私聊可以设置命令菜单

- 状态：已接受
- 日期：2026-11-04

## 背景

管理命令只在私聊里执行。群里的同样文本仍走检测。官方设置调用是 `setMyCommands`。`commands` 必填，最多 100 条。可选 `scope` 和 `language_code`。

私聊查找顺序先看某个私聊，再看 `all_private_chats`，最后才是默认范围。群查找顺序不经过 `all_private_chats`。不送 `language_code` 时，这份列表只给该范围内还没有单独语言列表的人。

## 决策

- 私聊命令 `/setcommands [private]`。没有参数和唯一的 `private` 都设置私聊菜单。多出来的参数不发出请求。别的单词回复「参数无效」。群聊里的同样文本不执行。
- 只有配置里的管理员可以改。接入目录里的人即使管着自己的群也不能改。
- 调用 `ModerationPort.setCommandMenu`。适配器调用 `setMyCommands`。范围固定是 `{ type: "all_private_chats" }`。不送 `language_code`，也不送 `chat_id`。
- 每条命令用固定目录里的第一行用法当说明。命令名是 1 到 32 个小写英文字母、数字或下划线。说明是 1 到 256 个字符。超过 100 条、缺说明或说明超长时不发出请求。
- 不送 `is_ephemeral`。群里的命令文本仍然不执行。
- 回复不重复这份目录，并写明群菜单不变、已有单独语言列表的人不受影响。
- 没有 token 或调用失败时回复「参数无效」。日志只写 `operator_rejected`，带上 eventId、chatId 和命令名 `setcommands`。不写异常文本、token 或原文。
- 没有 token 的 Worker 不把内存记录回复成已经设置。
- 不调用 `deleteMyCommands` 或 `getMyCommands`。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 用默认范围，让群里也能看到菜单 | 群里的命令文本仍被检测，不会执行。 |
| 让管理员粘贴说明 | 粘贴的原文会离开 Worker。 |
| 给每条命令标成临时消息 | 临时命令仍要在群里执行。这次不改这条规则。 |
| 同时删除或读取现有菜单 | 那是另外两条调用。 |

## 后果

- 成功只表示 Telegram 接受了一次 `setMyCommands`。群菜单不变。已经有单独语言列表的人不受影响。
- 一次设置是一次 Telegram 子请求。封禁、禁言和黑名单都不变。
- 30 天保留期不动。
