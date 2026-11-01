# 插件

步骤以 `AGENTS.md` 为准。这里只放最小形状。

检测器：

```ts
import { defineDetector } from "@tasb/core";
import { z } from "zod";

const configSchema = z.strictObject({
  keywords: z.array(z.string().min(1)).min(1),
});

export function createKeywordDetector(config: z.input<typeof configSchema>) {
  return defineDetector({
    id: "keyword",
    version: "0.1.0",
    capabilities: ["text"],
    configSchema,
    config,
    async detect(ctx, parsed) {
      const text = ctx.event.message?.text;
      if (!text) return null;
      const hit = parsed.keywords.some((word) => text.includes(word));
      if (!hit) return null;
      return {
        detectorId: "keyword",
        score: 1,
        reasons: ["keyword_match"],
        evidence: [{ kind: "keyword", summary: "keyword:configured" }],
      };
    },
  });
}
```

动作只调用 `ctx.moderator`。dry-run 返回 `{ status: "skipped", detail: "dry_run" }`。

适配器实现 `Storage` 或 `ModerationPort`。不要把 D1、KV 或 Telegram 的类型 re-export 到 core 能 import 的位置。

平台包把 Telegram `Update` 收成 `Event`。参考 `packages/platform-telegram` 和 `examples/telegram-webhook`。Webhook 失败时不要调用 `onEvent`。

提交前：

```sh
pnpm boundaries
pnpm test
pnpm eval
```
