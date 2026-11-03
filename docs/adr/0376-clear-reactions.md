# ADR 0376：私聊可以清除一个来源的最近反应

- 状态：已接受
- 日期：2026-11-04

## 背景

刷反应不留下可删的正文。`/delete` 删的是消息，清不掉别人加在许多消息上的反应。

官方 `deleteAllMessageReactions` 清除一个用户或一个频道在群或超级群里最近留下的反应，最多一万条。bot 必须是管理员，并且有 `can_delete_messages`。成功时返回 True。

`user_id` 和 `actor_chat_id` 都是可选。文档说清除的是给定用户或给定聊天留下的反应。两个都不带时，范围没有写明。

没有 token 时，内存适配器可以把这次请求记下来。私聊如果复用这次成功，回复会写成反应已经不在。

## 决策

- 私聊命令 `/clearreact <chatId> <actorId>`。群 id 和来源 id 都匹配 `^-?\d{1,20}$`。群聊里的同样文本不执行。
- 来源 id 以 `-` 开头时视为频道或群，请求只带 `actor_chat_id`。其它合法 id 视为用户，请求只带 `user_id`。同一次请求不带两个字段，也不带消息号。
- 配置中的管理员可以操作任意群。接入目录里的人只能操作自己的群。
- 命令调用 `ModerationPort.clearReactions`，带 tenant、chat、actor 和 kind。适配器调用 `deleteAllMessageReactions`。不调用 `deleteMessageReaction`，也不删消息。
- 回复写明这是最近的反应，一万条以前的可能还在。
- 没有 token、没有这个方法，或调用失败时回复「参数无效」。日志只写 `operator_rejected`，带上 eventId、chatId 和命令名。不写异常文本或 token。
- 没有 token 的 Worker 不把内存里的记录回复成已经成功。
- 不修改黑名单、白名单、封禁或禁言。不读取消息正文或表情。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 不带来源，清掉全群反应 | 文档要求的是一个给定用户或聊天。范围没写明时不发出请求。 |
| 同一次带上 `user_id` 和 `actor_chat_id` | 两个字段各管一种来源。一起带时官方没有定义。 |
| 逐条调用 `deleteMessageReaction` | 要先知道消息号和表情。一万条就会打满免费计划的子请求。 |
| 回复写成已经全部清除 | 官方上限是最近一万条。更早的可能还在。 |
| 没有 token 时也回复「已清除」 | 群里的反应还在。管理员会以为已经清掉。 |

## 后果

- 成功只表示 Telegram 接受了这一次 `deleteAllMessageReactions`。普通群以外的聊天，或 bot 缺少 `can_delete_messages` 时，回复是「参数无效」。
- 一次清除是一次 Telegram 子请求。消息、封禁和禁言都不变。
- 30 天保留期不动。
