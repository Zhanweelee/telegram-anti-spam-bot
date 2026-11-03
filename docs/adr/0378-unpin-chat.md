# ADR 0378：私聊可以撤下一群的全部置顶

- 状态：已接受
- 日期：2026-11-04

## 背景

突袭常把诈骗消息钉在群顶。管理员不一定拿得到每条消息号。逐条调用 `unpinChatMessage` 会按置顶条数消耗免费计划的子请求。

官方 `unpinAllChatMessages` 清空一个聊天的置顶列表。群里 bot 必须是管理员，并且有 `can_pin_messages`。频道里需要 `can_edit_messages`。成功时返回 True。参数只有 `chat_id`。

话题里的置顶走 `unpinAllForumTopicMessages` 和 `unpinAllGeneralForumTopicMessages`。这一次调用不清那些列表。

没有 token 时，内存适配器可以把这次请求记下来。私聊如果复用这次成功，回复会写成置顶已经撤下。

## 决策

- 私聊命令 `/unpin <chatId>`。群 id 匹配 `^-?\d{1,20}$`。群聊里的同样文本不执行。
- 配置中的管理员可以操作任意群。接入目录里的人只能操作自己的群。
- 命令调用 `ModerationPort.unpinChat`，带 tenant 和 chat。适配器调用 `unpinAllChatMessages`。不带消息号，也不带话题号。不调用 `unpinChatMessage`，也不删消息。
- 回复写明消息还在，话题里的置顶不在这次里。
- 没有 token、没有这个方法，或调用失败时回复「参数无效」。日志只写 `operator_rejected`，带上 eventId、chatId 和命令名。不写异常文本或 token。
- 没有 token 的 Worker 不把内存里的记录回复成已经成功。
- 不修改黑名单、白名单、封禁或禁言。不读取消息正文。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 只撤最近一条 `unpinChatMessage` | 突袭可以钉很多条。管理员还要提供消息号。 |
| 同时清话题置顶 | 话题置顶是另外的方法，还要话题号。这一次的范围官方写成聊天的置顶列表。 |
| 撤置顶时删除那些消息 | 这个方法不返回消息号。删除仍走 `/delete` 和 `/deletes`。 |
| 回复写成消息已经不在 | 成功只表示置顶列表被清空。消息正文还在。 |
| 没有 token 时也回复「已撤下」 | 群里的置顶还在。管理员会以为已经清掉。 |

## 后果

- 成功只表示 Telegram 接受了这一次 `unpinAllChatMessages`。缺少 `can_pin_messages` 或 `can_edit_messages` 时，回复是「参数无效」。
- 话题里的置顶还在。消息正文还在。
- 一次撤下是一次 Telegram 子请求。封禁、禁言和黑名单都不变。
- 30 天保留期不动。
