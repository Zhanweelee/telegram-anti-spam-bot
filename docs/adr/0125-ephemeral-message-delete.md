# ADR 0125：临时消息按接收者删除

- 状态：已接受
- 日期：2026-11-02

## 背景

群里可以有一条只给一个用户看见的消息。公开的 `message_id` 是 0，真正的 id 在 `ephemeral_message_id`。`deleteMessage` 删不掉它。删除接口还要接收者的用户 id。

接收者的姓名不是这条消息的正文。短链和关键词仍在消息自己的文字里。

## 决策

- `ephemeral_message_id` 和 `receiver_user.id` 都是正整数时，`message.id` 用这份临时 id，并写下 `audienceId`。公开的 `message_id` 不再当作要删的那条。
- 缺其中任何一个时，仍用公开的 `message_id`，不写 `audienceId`。
- 删除动作在有 `audienceId` 时带上它。Telegram 适配器改调 `deleteEphemeralMessage`，参数是 `chat_id`、`receiver_user_id` 和 `ephemeral_message_id`。没有 `audienceId` 时仍调 `deleteMessage`。
- 接收者姓名、群名和发送者姓名不进事件。消息正文仍按原来的规则筛。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 继续用 `deleteMessage` 和公开 id 0 | 删不到只给一个人看见的消息。 |
| 把接收者姓名放进事件 | 姓名不是正文，审计也不该带上。 |
| 临时 id 单独再做一个动作 | 现有 `delete` 已经表达“删掉这条”。差别只是平台接口。 |

## 后果

- 只给一个人看见的短链或关键词仍由现有规则删除。删除请求带接收者 id 和临时消息 id。
- 普通消息的删除请求不变。
- 接收者姓名不进事件，也不进日志。
- 没有接收者 id 的临时消息仍按公开 id 删除，平台可能拒绝 id 0。
- 没有临时编号、公开 id 为 0 的占位更新后来由 ADR 0439 在读正文前忽略。真正发出时会再来一条更新。
