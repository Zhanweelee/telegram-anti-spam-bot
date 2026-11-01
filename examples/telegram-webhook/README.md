# Telegram webhook 示例

校验 `X-Telegram-Bot-Api-Secret-Token`，把一条 `message` 更新变成内部 `Event`。

```sh
pnpm --filter @tasb/example-telegram-webhook test
```

密钥不一致时 `events` 为空，状态码 401。密钥正确时，`message` 得到 `kind: "message"`，`chat_member` 得到 `kind: "chat_member"` 且没有 `message`。主体是状态变化的那个用户，不是执行操作的 `from`。`chat_join_request` 得到 `kind: "join_request"`，简介在 `profile` 里，邀请链接和姓名不在事件里。HTTP 响应只有 `{ "ok": true }`，不含消息原文和昵称。

这个例子不调用 Telegram 的删除接口。Worker 在没有 `DB` / `POLICY_KV` 时用内存端口；配了绑定之后审计走 D1、白名单走 KV。处罚仍然不请求 Telegram。
