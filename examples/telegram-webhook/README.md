# Telegram webhook 示例

校验 `X-Telegram-Bot-Api-Secret-Token`，把一条更新收成内部 `Event`。

```sh
pnpm --filter @tasb/example-telegram-webhook test
```

密钥不一致时 `events` 为空，状态码 401。密钥正确时，`message` 得到 `kind: "message"`，`chat_member` 得到 `kind: "chat_member"` 且没有 `message`。主体是状态变化的那个用户，不是执行操作的 `from`。`chat_join_request` 得到 `kind: "join_request"`，简介在 `profile` 里，邀请链接和姓名不在事件里。入群服务消息 `new_chat_members` 在没有别的正文时，把看得见的名字放进 `message.text`。发送者姓名和退群的人不在事件里。HTTP 响应只有 `{ "ok": true }`，不含消息原文和昵称。带非空 `business_connection_id` 或 `guest_query_id` 的消息被忽略，响应是 `{ "ok": true, "ignored": true }`，编号和正文不进事件。其余字段见 [message-surface.md](../../docs/message-surface.md)。

这个例子不调用 Telegram 的删除接口。Worker 在没有 `DB` / `POLICY_KV` 时用内存端口；配了绑定之后审计走 D1、白名单走 KV。配了 `TELEGRAM_BOT_TOKEN` 之后，删除、禁言和封禁才会请求 Telegram。见 [deploy.md](../../docs/deploy.md)。
