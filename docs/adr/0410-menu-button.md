# ADR 0410：私聊可以设置默认菜单按钮

- 状态：已接受
- 日期：2026-11-04

## 背景

私聊命令菜单已经可以设置、查看和清掉。菜单按钮是私聊里打开这份列表的入口。官方设置调用是 `setChatMenuButton`。

`chat_id` 可选。不送时改的是 bot 的默认菜单按钮。某个私聊里单独设过的按钮继续生效。`menu_button` 不送时 Telegram 把它当成 `MenuButtonDefault`。

`MenuButtonCommands` 的 `type` 是 `commands`，打开命令列表。`MenuButtonDefault` 的 `type` 是 `default`。`MenuButtonWebApp` 还要按钮文字和 Web App 地址。

## 决策

- 私聊命令 `/menubutton <commands|default>`。正好一个参数。`commands` 把默认按钮设成命令列表。`default` 恢复默认。缺少参数或多出来的参数不发出请求。别的单词回复「参数无效」。群聊里的同样文本不执行。
- 只有配置里的管理员可以改。接入目录里的人即使管着自己的群也不能改。
- 调用 `ModerationPort.setMenuButton`。适配器调用 `setChatMenuButton`。正文只有 `menu_button`，`type` 是 `commands` 或 `default`。不送 `chat_id`。
- 不送 `text` 或 `web_app`。
- 回复写明某个私聊里单独设过的按钮不受影响。
- 没有 token 或调用失败时回复「参数无效」。日志只写 `operator_rejected`，带上 eventId、chatId 和命令名 `menubutton`。不写异常文本、token 或原文。
- 没有 token 的 Worker 不把内存记录回复成已经设置。
- 不调用 `getChatMenuButton`。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 给某一个私聊单独设按钮 | 那要送 `chat_id`。这次只改默认按钮。 |
| 允许 Web App 按钮 | 按钮文字和地址会离开 Worker。 |
| 不送 `menu_button` 来表示默认 | 显式送出 `type: default`，设置和恢复才能分开验收。 |

## 后果

- 成功只表示 Telegram 接受了一次 `setChatMenuButton`。某个私聊里单独设过的按钮不受影响。
- 一次设置是一次 Telegram 子请求。封禁、禁言和黑名单都不变。
- 30 天保留期不动。
