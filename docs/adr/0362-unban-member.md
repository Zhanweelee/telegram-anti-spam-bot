# ADR 0362：私聊可以解除已经存在的封禁

- 状态：已接受
- 日期：2026-11-04

## 背景

封禁是永久的。ADR 0004 不给 `banChatMember` 传 `until_date`，ADR 0020 把 `revoke_messages` 固定为 false。管理员发现误封之后，只能到 Telegram 客户端里解除。`/appeal` 只给评测队列打标签，不会把人放回来。

`unbanChatMember` 的官方说明：默认情况下，调用之后这个人不再是群成员，但可以再加入。如果调用时人还在群里，也会被移出。参数 `only_if_banned` 为 true 时，只解除现有封禁；人没有被封禁就不做任何事。

## 决策

- 私聊命令 `/unban <chatId> <actorId>`。两个 id 都要匹配 `^-?\d{1,20}$`。群聊里的同样文本不执行。
- 配置中的管理员可以操作任意群。接入目录里的人只能操作自己的群。
- 命令调用 `ModerationPort.unbanActor`。配了 token 时，Telegram 适配器调用 `unbanChatMember`，参数只有 `chat_id`、`user_id` 和 `only_if_banned: true`。
- 没有处罚端口、没有 token，或调用失败时，回复「参数无效」。日志是 `operator_rejected`，不写异常文本，也不写 token。
- 没有 token 的 Worker 不把这次调用记成已经解除。内存适配器只给测试和示例记录目标。
- 不修改黑名单、白名单或禁言。禁言仍等到 `until_date`，或由验证通过时的 `releaseActor` 打开权限。
- 成功时回复群 id 和用户 id。人如果本来就没有被封禁，Telegram 不会把人移出群。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 省略 `only_if_banned` | 官方说明会把仍在群里的人移出。 |
| 让 `/appeal false` 顺带解封 | 申诉是评测标签。解封要单独再确认一次用户 id。 |
| 没有 token 时回复已经解除 | 管理员会以为人可以回来，群里的封禁还在。 |

## 后果

- 误封可以在私聊里解除。人不会自动回到群里，需要自己再加入。
- 一次命令是一次 Telegram 子请求。
- 黑名单仍会在下一条命中时再封禁。
- 30 天保留期不动。
- 把仍在群里的普通成员移出、并允许再加入，由 `/kick` 完成，见 ADR 0434。`/unban` 仍带 `only_if_banned`。
