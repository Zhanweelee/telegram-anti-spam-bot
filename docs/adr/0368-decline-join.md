# ADR 0368：私聊可以拒绝一条入群申请

- 状态：已接受
- 日期：2026-11-04

## 背景

带查询号的入群申请要在 10 秒内答复，见 ADR 0360。过了这个窗口，或者申请当时被交给其他管理员，查询号已经不能用。官方 `declineChatJoinRequest` 只需要群 id 和用户 id：bot 必须是该群管理员，并且有 `can_invite_users`。成功时返回 True。

管理员手里已经有用户 id 时，仍然要打开 Telegram 才能拒绝这条申请。`/ban` 会封禁，不是拒绝申请。

没有 token 时，流水线的 `declineJoin` 记在内存里。私聊如果复用这次成功，回复会写成已经拒绝。

## 决策

- 私聊命令 `/decline <chatId> <actorId>`。群 id 和用户 id 都匹配 `^-?\d{1,20}$`。群聊里的同样文本不执行。
- 配置中的管理员可以操作任意群。接入目录里的人只能操作自己的群。
- 命令调用 `ModerationPort.declineJoin`，只带 tenant、chat 和 actor。不带 `queryId`，因此不调用 `answerChatJoinRequestQuery`。
- 不读取姓名、简介或查询号。这些字段不进入这次命令。
- 没有 token、没有这个方法，或调用失败时回复「参数无效」。日志只写 `operator_rejected`，带上 eventId、chatId 和命令名。不写异常文本、token 或姓名。
- 没有 token 的 Worker 不把内存里的拒绝记录回复成已经成功。流水线在没有 token 时仍按 ADR 0020 记在内存里。
- 不修改黑名单、白名单、封禁或禁言。不调用 `approve`。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 让管理员附上查询号 | 查询号不展示，也不进日志。10 秒之后它已经失效。 |
| 同时封禁这个人 | 拒绝申请和封禁不是同一件事。封禁仍走 `/ban`。 |
| 没有 token 时也回复「已拒绝」 | 申请可能还在。管理员会以为 Telegram 已经拒绝。 |

## 后果

- 成功只表示 Telegram 接受了这一次 `declineChatJoinRequest`。没有待处理申请，或 bot 缺少 `can_invite_users` 时，回复是「参数无效」。
- 这个人不会因此被封禁或禁言。之后的新申请仍按 ADR 0360 处理。
- 一次拒绝是一次 Telegram 子请求。
- 30 天保留期不动。
