# ADR 0363：私聊可以解除已经存在的禁言

- 状态：已接受
- 日期：2026-11-04

## 背景

禁言最长可以到 366 天。验证通过时，`releaseActor` 会把每一项权限打开。管理员如果提前放行，仍然要到 Telegram 客户端里操作。ADR 0362 的 `/unban` 只解除封禁，不打开禁言。

`restrictChatMember` 的官方说明：把每一项权限都设为 true，就是解除限制。没有先看成员状态时，同一次调用也会作用在普通成员上。`use_independent_chat_permissions` 为 true 时，这些权限不再互相隐含，普通成员可能因此超过群的默认权限。

## 决策

- 私聊命令 `/unmute <chatId> <actorId>`。两个 id 都要匹配 `^-?\d{1,20}$`。群聊里的同样文本不执行。
- 配置中的管理员可以操作任意群。接入目录里的人只能操作自己的群。
- 命令调用 `ModerationPort.unmuteActor`，返回 `lifted` 或 `absent`。
- 配了 token 时先调用 `getChatMember`。`status` 是 `restricted` 时再调用 `restrictChatMember`：每一项权限为 true，`use_independent_chat_permissions` 为 true，不传 `until_date`。`is_member` 为 false 时也解除，因为限制还在；这次不会把人加回群里。
- `creator`、`administrator`、`member`、`left`、`kicked` 返回 `absent`，不再调用 `restrictChatMember`。
- 成员状态缺失、没有 token，或任一调用失败时抛出固定错误 `unmute_failed` 或 `unmute_unavailable`。回复「参数无效」。日志不写异常文本、token 或姓名。
- 没有 token 的 Worker 不把这次调用记成已经解除。内存适配器只给测试和示例记录目标，并返回 `lifted`。
- 不修改黑名单、白名单或封禁。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 不先调用 `getChatMember` | 普通成员会被写成独立的全开权限，可能超过群的默认设置。 |
| 复用 `releaseActor` | 验证通过已经知道这个人被限制。每条验证再多一次查询，热路径不需要。 |
| `is_member` 为 false 时不动 | 人离群后限制还在。提前放行要等 `until_date`。 |

## 后果

- 误禁言可以在私聊里提前打开。已经离群的人仍要自己再加入。
- 一次解除最多两次 Telegram 子请求。
- 打开的是全部权限，和验证通过时相同。群的默认权限更窄时，这个人可以超过默认。
- 30 天保留期不动。
