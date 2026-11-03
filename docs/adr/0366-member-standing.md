# ADR 0366：私聊可以查看成员状态

- 状态：已接受
- 日期：2026-11-04

## 背景

私聊已经可以封禁、解封、禁言和解除禁言。管理员看不到 Telegram 里这个人现在的状态，只能再打开客户端。`getChatMember` 的官方说明：bot 是管理员时，可以查询其他用户，返回一个 `ChatMember`。

六种状态是 `creator`、`administrator`、`member`、`restricted`、`left` 和 `kicked`。`restricted` 和 `kicked` 的 `until_date` 为 0 时表示永久。普通成员的 `until_date` 是订阅到期，不是处罚到期。返回里还有姓名、标签和头衔。

## 决策

- 私聊命令 `/member <chatId> <actorId>`。两个 id 都要匹配 `^-?\d{1,20}$`。群聊里的同样文本不执行。
- 配置中的管理员可以查看任意群。接入目录里的人只能查看自己的群。
- 命令调用 `ModerationPort.readMember`，返回 `MemberStanding`。配了 token 时只调用一次 `getChatMember`。
- `creator`、`administrator`、`member` 和 `left` 只保留状态。普通成员的订阅到期不进入结果。
- `kicked` 和 `restricted` 在 `until_date` 是正整数时带上这个时间。缺失或 0 时不带时间。`restricted` 且 `is_member` 正好为 false 时记成人不在群里。
- 不读 `user`、`tag`、`custom_title` 和各项权限。未知状态、缺状态或 `until_date` 不是安全整数时抛出 `member_failed`。
- 没有 token、没有这个方法，或调用失败时回复「参数无效」。日志只写 `operator_rejected`，带上 eventId、chatId 和命令名。不写异常文本、token 或姓名。
- 内存适配器抛出 `member_unavailable`，不编造状态。不修改黑名单、封禁或禁言。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 把订阅到期写进「在群里」 | 管理员会把付费到期看成封禁到期。 |
| 回复姓名和标签 | 这些字可以是广告，也会进入私聊记录。 |
| 内存适配器固定回复「在群里」 | 示例和测试会把猜出来的状态当成 Telegram 的答案。 |

## 后果

- 封禁和禁言之后可以用同一条命令核对。人要自己再加入这件事仍由 `/unban` 说明。
- 一次查看是一次 Telegram 子请求。bot 不是该群管理员时，Telegram 会拒绝，回复「参数无效」。
- 30 天保留期不动。
