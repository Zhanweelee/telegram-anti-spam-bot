# 私聊命令

内存适配器跑一条私聊命令。没有 Telegram，也没有 Cloudflare。

`src/run.ts` 的 `runPrivateCommand` 把文本交给 `runOperatorCommand`。配置里的管理员能看到 `/help`、`/rules`、`/quota`、`/chats`、`/unban`、`/unmute`。`/unban` 和 `/unmute` 记在内存处罚端口上，不请求 Telegram。群聊里的同样文本不会改配置。回复里没有夹在命令参数里的原文。

```sh
pnpm --filter @tasb/example-operator-commands test
```
