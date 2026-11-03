# ADR 0369：私聊可以批准一条入群申请

- 状态：已接受
- 日期：2026-11-04

## 背景

带查询号的入群申请要在 10 秒内答复。干净的申请当时答 `queue`，交给其他管理员，不会自动进群。见 ADR 0360。过了这个窗口，查询号已经不能用。

官方 `approveChatJoinRequest` 只需要群 id 和用户 id：bot 必须是该群管理员，并且有 `can_invite_users`。成功时返回 True。

管理员手里已经有用户 id 时，仍然要打开 Telegram 才能批准这条申请。`/decline` 只会拒绝，见 ADR 0368。

没有 token 时，内存适配器可以把一次批准记下来。私聊如果复用这次成功，回复会写成已经批准。

## 决策

- 私聊命令 `/approve <chatId> <actorId>`。群 id 和用户 id 都匹配 `^-?\d{1,20}$`。群聊里的同样文本不执行。
- 配置中的管理员可以操作任意群。接入目录里的人只能操作自己的群。
- 命令调用 `ModerationPort.approveJoin`，只带 tenant、chat 和 actor。不带 `queryId`，因此不调用 `answerChatJoinRequestQuery`。
- 适配器即使收到查询号，也不把查询号发给 Telegram，也不改答 `approve`。带查询号的自动路径仍按 ADR 0360 答 `queue` 或 `decline`。
- 不读取姓名、简介或查询号。内存记录只留 tenant、chat 和 actor。
- 没有 token、没有这个方法，或调用失败时回复「参数无效」。日志只写 `operator_rejected`，带上 eventId、chatId 和命令名。不写异常文本、token 或姓名。
- 没有 token 的 Worker 不把内存里的批准记录回复成已经成功。流水线在没有 token 时仍按 ADR 0020 把删除、禁言和封禁记在内存里。批准不进入检测流水线。
- 不修改黑名单、白名单、封禁或禁言。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 干净的查询直接 `approve` | ADR 0360 把决定留给其他管理员。 |
| 让管理员附上查询号 | 查询号不展示，也不进日志。10 秒之后它已经失效。 |
| 没有 token 时也回复「已批准」 | 人可能还在申请列表里。管理员会以为 Telegram 已经批准。 |

## 后果

- 成功只表示 Telegram 接受了这一次 `approveChatJoinRequest`。没有待处理申请，或 bot 缺少 `can_invite_users` 时，回复是「参数无效」。
- 这个人不会因此被封禁或禁言。批准之后是否已经在群里由 Telegram 决定。
- 一次批准是一次 Telegram 子请求。
- 30 天保留期不动。
