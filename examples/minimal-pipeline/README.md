# 最小流水线

内存存储 + 关键词检测器 + 删除动作。没有 Telegram，也没有 Cloudflare。

`src/run.ts` 把一条文本送进 `runPipeline`。命中「免费领取」或「加微信」时决策是 `delete`，普通文本是 `allow`。审计记录里只有哈希和证据摘要，没有原文。

```sh
pnpm --filter @tasb/example-minimal-pipeline test
```

`dryRun: true` 时决策仍是 `delete`，动作记为 `skipped`，也不会写审计。
