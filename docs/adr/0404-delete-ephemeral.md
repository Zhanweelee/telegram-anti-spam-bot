# ADR 0404：私聊可以删除一条临时消息

- 状态：已接受
- 日期：2026-11-04

## 背景

临时消息只发给一个接收者。官方删除它的调用是 `deleteEphemeralMessage`。自动删除在事件带了 `audienceId` 时已经走这条调用。见 ADR 0125。

私聊 `/delete` 只删公开消息，不带接收者。见 ADR 0367。管理员还需要单独删掉一条发给某个人的临时消息。

官方说明写明，接收者不一定会收到这次删除事件，离线时尤其如此。参数是 `chat_id`、`receiver_user_id` 和 `ephemeral_message_id`。

## 决策

- 私聊命令 `/delephemeral <chatId> <userId> <messageId>`。群号和用户号匹配 `^-?\d{1,20}$`。消息号是不带前导零的正安全整数，`1` 原样送出。正好三个参数才发出请求。群聊里的同样文本不执行。
- 配置中的管理员可以操作任意群。接入目录里的人只能操作自己的群。
- 调用已有的 `ModerationPort.deleteMessage`，并带上 `audienceId`。适配器因此调用 `deleteEphemeralMessage`。不新增端口方法。
- `/delete` 仍然不带 `audienceId`，继续调用 `deleteMessage`。
- 回复写明对方离线时可能收不到这次删除，其它消息还在。
- 没有 token、没有 `deleteMessage`，编号不合法，或调用失败时回复「参数无效」。日志只写 `operator_rejected`，带上 eventId、chatId 和命令名 `delephemeral`。不写异常文本、token 或原文。
- 没有 token 的 Worker 不把内存记录回复成已经删除。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 把用户号并进 `/delete` | ADR 0367 让 `/delete` 只使用公开消息号。临时消息是另一条调用。 |
| 不带接收者调用 `deleteMessage` | 没有接收者删不掉临时消息。 |
| 回复里写接收者一定看到了删除 | 官方说明写明离线的接收者可能收不到这次删除事件。 |

## 后果

- 成功只表示 Telegram 接受了这一次 `deleteEphemeralMessage`。对方离线时可能看不到这次删除。其它消息还在。
- 一次删除是一次 Telegram 子请求。封禁、禁言和黑名单都不变。
- 30 天保留期不动。
