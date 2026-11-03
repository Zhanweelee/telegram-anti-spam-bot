# ADR 0372：私聊可以关闭群的默认发言权限

- 状态：已接受
- 日期：2026-11-04

## 背景

`/mute` 只禁言一个成员。突发广告时，管理员要一个一个处理。官方 `setChatPermissions` 设置群里全体成员的默认权限。bot 必须是群或超级群的管理员，并且有 `can_restrict_members`。成功时返回 True。

`use_independent_chat_permissions` 为 true 时，各项发送权限不再互相隐含。漏掉它，关掉部分权限仍可能把发言重新打开。

这个方法没有到期时间。关掉之后会一直保持，直到再次设置权限。

没有 token 时，内存适配器可以把一次关闭记下来。私聊如果复用这次成功，回复会写成群已经不能发言。

## 决策

- 私聊命令 `/lock <chatId>`。群 id 匹配 `^-?\d{1,20}$`。群聊里的同样文本不执行。
- 配置中的管理员可以操作任意群。接入目录里的人只能操作自己的群。
- 命令调用 `ModerationPort.lockChat`，只带 tenant 和 chat。适配器调用 `setChatPermissions`。权限与单人禁言相同的十六项，全部为 false，并带上 `use_independent_chat_permissions: true`。不带成员号，也不带 `until_date`。
- 回复写明：管理员仍可发言，此状态保持到重新设置权限。
- 不读取成员名单，也不逐个调用 `restrictChatMember`。已经单独禁言的人保持各自的限制。
- 没有 token、没有这个方法，或调用失败时回复「参数无效」。日志只写 `operator_rejected`，带上 eventId、chatId 和命令名。不写异常文本或 token。
- 没有 token 的 Worker 不把内存里的记录回复成已经成功。
- 不修改黑名单、白名单、用户封禁或单人禁言。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 逐个禁言当前成员 | 要先拉成员名单。名单不完整时会漏人。 |
| 不带 `use_independent_chat_permissions` | 权限隐含可能把发言重新打开。 |
| 同一条命令再写一套全开权限 | 全开会超过群里原来更窄的默认值。重新打开留到单独决定。 |
| 没有 token 时也回复「已关闭」 | 群里的人可能还在发言。管理员会以为已经锁住。 |

## 后果

- 成功只表示 Telegram 接受了这一次 `setChatPermissions`。频道，或 bot 缺少 `can_restrict_members` 时，回复是「参数无效」。
- 默认权限保持关闭，直到有人重新设置。管理员仍可发言。单人禁言和封禁不变。
- 一次关闭是一次 Telegram 子请求。
- 30 天保留期不动。
