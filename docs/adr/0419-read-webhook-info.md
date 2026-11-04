# ADR 0419：私聊可以查看 webhook 积压

- 状态：已接受
- 日期：2026-11-04

## 背景

反垃圾跑在 Workers 的 webhook 上。积压的更新会占掉投递窗口。查看调用是 `getWebhookInfo`。它不带参数，返回 `WebhookInfo`。

`pending_update_count` 是还没投递的更新条数。`has_custom_certificate` 表示有没有自定义证书。`max_connections` 是同时投递的连接上限，文档写 1 到 100，缺省 40。`last_error_date` 是上次投递错误的 unix 秒。

同一个对象还带 webhook 地址、IP、错误原文、同步错误时间和订阅的更新类型。地址里可能嵌着密钥。那些不进这次回复。

## 决策

- 私聊命令 `/hook`。没有参数。多出来的参数不发出请求。别的单词回复「参数无效」。群聊里的同样文本不执行。
- 只有配置里的管理员可以看。接入目录里的人即使管着自己的群也不能看。
- 调用 `ModerationPort.readWebhook`。适配器调用 `getWebhookInfo`。正文是空对象。
- 回复四行：待投递条数、有没有自定义证书、连接上限、上次错误时间。缺证书、缺连接或没有错误时间写未知。
- 待投递不是非负安全整数、证书不是布尔值、连接不在 1 到 100、或错误时间不是非负安全整数时，整份回复是「参数无效」，不露出已经读到的字段。
- 地址、IP、错误原文、同步错误时间和 `allowed_updates` 不进回复，也不进日志。
- 日志只写 `operator_rejected` 或命令名，带上 eventId、chatId 和命令名 `hook`。不写地址、错误原文、异常文本或 token。
- 没有 token 的 Worker 不编一份状态。
- 不调用 `setWebhook` 或 `deleteWebhook`。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 回复里带上地址 | 地址可能嵌着 webhook 密钥。这次只回答积压和投递状态。 |
| 缺连接当成 40 | 文档写这个字段可选。缺字段和明确的 40 不是同一件事。 |
| 顺手调用 `setWebhook` | 那会改投递地址。查看不该改配置。 |

## 后果

- 成功只表示 Telegram 返回了当前 webhook 的积压和投递状态。地址仍留在 Telegram。
- 一次查看是一次 Telegram 子请求。封禁、禁言和黑名单都不变。
- 30 天保留期不动。
