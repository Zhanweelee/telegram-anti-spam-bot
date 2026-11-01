# Telegram webhook 示例

校验 `X-Telegram-Bot-Api-Secret-Token`，把一条 `message` 更新变成内部 `Event`。

```sh
pnpm --filter @tasb/example-telegram-webhook test
```

密钥不一致时 `events` 为空，状态码 401。密钥正确时得到 `kind: "message"` 的事件。HTTP 响应只有 `{ "ok": true }`，不含消息原文。

这个例子不调用 Telegram 的删除接口。Worker 里的默认流水线同样只打到当次请求的内存端口，见 `apps/worker`。
