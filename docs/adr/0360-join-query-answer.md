# ADR 0360：守卫 bot 的入群查询要当场答复

- 状态：已接受
- 日期：2026-11-04

## 背景

Bot API 10.1 给 `chat_join_request` 增加了 `query_id`。官方说明：这个字段出现时，负责处理入群申请的 bot 必须在 10 秒内调用 `answerChatJoinRequestQuery` 或 `sendChatJoinRequestWebApp`。ADR 0116 当时把 `query_id` 丢掉，命中才调用 `declineChatJoinRequest`。干净的申请什么也不发。守卫查询因此会超时。

查询号不是简介。把它写进日志或审计，会把一次内部 id 留下来。

## 决策

- `query_id` 整段匹配 `^[A-Za-z0-9_-]{1,128}$` 时，记到事件的 `joinQueryId`。空串、空白、短语和其它字符都丢掉，也不写进日志。
- 规则决定 `decline` 且事件带 `joinQueryId` 时，`declineJoin` 调用 `answerChatJoinRequestQuery`，`result` 为 `decline`。不再同时调用 `declineChatJoinRequest`。
- 没有命中、管理员豁免，或决定不是 `decline` 时，调用同一次方法，`result` 为 `queue`。这把决定留给其他管理员。不调用 `approve`，也不发 Mini App。
- 决定已经是 `decline` 时，动作失败也不再改答 `queue`。
- dry-run 不调用 Telegram。
- 没有 `joinQueryId` 的申请仍按 ADR 0116：只有 `decline` 才调用 `declineChatJoinRequest`。
- 代答失败只记 `join_query_defer_failed`，字段只有事件 id 和群 id。
- 不改 ADR 0026 的基础检测器，也不自动通过干净申请。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 干净的查询直接 `approve` | 会改掉管理员自己审申请的习惯。 |
| 继续只调用 `declineChatJoinRequest` | 官方要求带 `query_id` 时在 10 秒内答复这次查询。 |
| 拒绝失败后再答 `queue` | 垃圾申请会交给其他管理员。 |
| 把查询号写进审计 | 它不是给管理员看的原文。 |

## 后果

- 带安全查询号的广告简介会被拒绝。干净的申请交给其他管理员，不会自动进群。
- 查询号不进日志和审计。简介仍只留 sha256。
- 不安全的查询号无法代答，Telegram 可能让这次查询超时。
- 30 天保留期不动。
