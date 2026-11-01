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

动作只调用 `ctx.moderator`，或者 core 已经导出的领域函数。dry-run 返回 `{ status: "skipped", detail: "dry_run" }`。缺消息或 actor 时返回 `failed`，不要抛给流水线。mute 带 `durationSeconds`，ban 不顺带删除。见 ADR 0004。

`captcha` 只处理 `kind: "chat_member"` 且 `membership: "join"` 的事件。它调用 `beginChallenge`：先写入挑战，再 `restrictActor`。限制失败就删掉挑战并返回 `failed` / `captcha_unavailable`。结果里不要放 nonce。按钮文案和 `restrictChatMember` 留在 `platform-telegram`。见 ADR 0009。入群检测器在 `packages/detectors-join`，`membership !== "join"` 时返回 null，并带 fixtures。

洪泛和重复在 `packages/detectors-rate`。两者共用一个 `RateWindow`。默认实现是内存，最多 256 个 key。放不下时 `observe` 返回 `null`，检测器返回未命中并记 `rate_window_skipped`。不要把原文放进 key，重复检测只用 `textSha256`。见 ADR 0010 和 `docs/limits.md` 的 KV、Durable Objects 两节。

链接检测在 `packages/detectors-link`。默认只认短链域名、denylist 和 IPv4 主机。`ReputationSource` 不传就不会发请求。本地已命中时也不调用它。超时或抛错记 `reputation_failed`，返回 null。证据里只留主机名。见 ADR 0011。

适配器实现 `Storage`、`Cache`、`PolicyStore` 或 `ModerationPort`。不要把 D1、KV 或 Telegram 的类型 re-export 到 core 能 import 的位置。`RuleSource` 只返回未校验文档，schema 和缓存由 `loadRuleSet` 负责。`PolicyStore` 的实现要调用 `@tasb/core/testing` 的 `bindPolicyStoreContract`，和内存适配器、KV 适配器跑同一组行为。`Storage` 的实现要调用 `bindStorageContract`。`exportAudits` 返回范围内的全部审计，`deleteAudits` 只删除这些审计。导出 JSON 再过一遍审计 schema，不能带原文键。`put` 用 `prefilterPolicySchema` 拒绝空 id、超过 128 字符的 id，以及超过 200 个 id。读到无法通过 schema 的文档时返回 null，不要把文档写进日志。

平台包把 Telegram `Update` 收成 `Event`。参考 `packages/platform-telegram` 和 `examples/telegram-webhook`。Webhook 失败时不要调用 `onEvent`。私聊管理命令见 `examples/operator-commands` 和 ADR 0006。回复只通过 `ReplyPort` 发送，不要在 core 里调用 Bot API。

提交前：

```sh
pnpm boundaries
pnpm test
pnpm eval
```
