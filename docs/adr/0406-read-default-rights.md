# ADR 0406：私聊可以查看这个 bot 的默认管理员权限

- 状态：已接受
- 日期：2026-11-04

## 背景

ADR 0405 让配置里的管理员设置这份建议权限。设置之后还要能看出现在的值。官方读取调用是 `getMyDefaultAdministratorRights`。

可选参数只有 `for_channels`。为 true 时读频道。不送时读群和超级群。返回 `ChatAdministratorRights`。

这不改任何群，也不提升成员。

## 决策

- 私聊命令 `/botrights [channels]`。没有参数时读群和超级群。唯一的参数必须是 `channels`。多出来的参数不发出请求。群聊里的同样文本不执行。
- 只有配置里的管理员可以看。接入目录里的人即使管着自己的群也不能看。
- 调用 `ModerationPort.readDefaultRights`。适配器调用 `getMyDefaultAdministratorRights`。频道才带 `for_channels: true`。
- 回复列出十八项。布尔 true 是 on，false 是 off。缺字段写未知。非布尔值回复「参数无效」。
- 没有 token、结果不是对象，或调用失败时回复「参数无效」。日志只写 `operator_rejected`，带上 eventId、chatId 和命令名 `botrights`。不写异常文本、token 或原文。
- 没有 token 的 Worker 不编一份权限。
- 不调用 `setMyDefaultAdministratorRights` 或 `promoteChatMember`。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 把读取并进 `/myrights` 的无参数形式 | `/myrights` 没有参数时是用法。读取是另一条调用。 |
| 缺字段当成 false | 清掉后的全 false 和「Telegram 没返回这一项」会变成同一种回复。 |
| 接入目录里的群管理员也能看 | 这是 bot 自己的默认值，不是某一个群的设置。 |

## 后果

- 成功只表示 Telegram 返回了一份 `ChatAdministratorRights`。已有群的管理员权限不变。
- 一次查看是一次 Telegram 子请求。封禁、禁言和黑名单都不变。
- 30 天保留期不动。
