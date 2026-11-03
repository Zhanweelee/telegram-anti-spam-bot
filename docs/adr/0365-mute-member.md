# ADR 0365：私聊可以禁言一个成员

- 状态：已接受
- 日期：2026-11-04

## 背景

规则命中之后会调用 `restrictChatMember`，时长来自动作配置。Worker 注册的 mute 动作是 3600 秒。管理员从 `/logs` 看到一个 actor id，仍然要到 Telegram 客户端里禁言。`/unmute` 已经能打开禁言，对面的禁言命令还没有。

`restrictChatMember` 的 `until_date` 距离现在不足 30 秒，或超过 366 天时，Telegram 把这名成员当成永久限制。ADR 0354 在发出请求前把时长收进这个区间。永久限制仍走封禁。

没有 token 时，流水线的 `muteActor` 记在内存里。私聊如果复用这次成功，回复会写成已经禁言。

## 决策

- 私聊命令 `/mute <chatId> <actorId> [seconds]`。两个 id 都要匹配 `^-?\d{1,20}$`。群聊里的同样文本不执行。
- 不写秒数时用 3600。写出的秒数必须是没有前导零的十进制整数，并且落在 30 到 366 天，含两端。其它写法回复「参数无效」，不调用端口。
- 配置中的管理员可以操作任意群。接入目录里的人只能操作自己的群。
- 命令调用 `ModerationPort.muteActor`，带上这次的 `durationSeconds`。配了 token 时，Telegram 适配器仍把每一项权限设为 false，并带上 `until_date` 和 `use_independent_chat_permissions: true`。
- 没有 token、没有这个方法，或调用失败时回复「参数无效」。日志只写 `operator_rejected`，带上 eventId、chatId 和命令名。不写异常文本、token 或姓名。
- 没有 token 的 Worker 不把内存里的禁言记录回复成已经成功。流水线在没有 token 时仍按 ADR 0020 记在内存里。
- 不修改黑名单、白名单或封禁。改动作配置不会改这条命令的默认秒数。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 不写秒数时读动作配置 | 命令和流水线会绑在同一份动作实例上。私聊一次禁言不该改自动处罚的时长。 |
| 接受 1 到 29 秒并让适配器收成 30 秒 | 回复里的秒数会短于实际限制。 |
| 没有 token 时也回复「已禁言」 | 人仍可以发言。管理员会以为禁言已经生效。 |

## 后果

- 提前放行仍用 `/unmute`。到期后 Telegram 自己打开权限。
- 一次禁言是一次 Telegram 子请求。
- 30 天保留期不动。
