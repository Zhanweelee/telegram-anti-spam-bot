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

动作只调用 `ctx.moderator`，或者 core 已经导出的领域函数。dry-run 返回 `{ status: "skipped", detail: "dry_run" }`。缺消息或 actor 时返回 `failed`，不要抛给流水线。mute 带 `durationSeconds`，ban 不顺带删除。见 ADR 0004。Telegram 适配器在有 token 时把这三步各发成一次 Bot API 请求。失败由流水线记成 `action_failed`，不把响应正文写进日志。见 ADR 0020。同一条事件先占住审计再调用动作。已经有记录就不再调用。见 ADR 0335 和 ADR 0336。

`log` 只写标识、分数和 reason。`report` 把同一份通知交给 `Notifier`。没有通知端口时返回 `report_unavailable`。见 ADR 0021。

`captcha` 只处理 `kind: "chat_member"` 且 `membership: "join"` 的事件。它调用 `beginChallenge`：先写入挑战，再 `restrictActor`。限制失败就删掉挑战并返回 `failed` / `captcha_unavailable`。结果里不要放 nonce。按钮文案和 `restrictChatMember` 留在 `platform-telegram`。没配 `DB` 时挑战留在 isolate 内存。配了之后写入 D1，另一个 isolate 的按钮仍能对上。见 ADR 0009 和 ADR 0051。入群检测器在 `packages/detectors-join`，`membership !== "join"` 时返回 null，并带 fixtures。`decline` 只处理 `kind: "join_request"`，调用 `declineChatJoinRequest`。没有命中时申请仍留给管理员。见 ADR 0116。默认规则 `join_link` 用现有链接检测器看入群昵称。短链或邀请就封禁，普通网址仍只验证。见 ADR 0117。

洪泛和重复在 `packages/detectors-rate`。两者共用一个 `RateWindow`。默认实现是内存，最多 256 个 key。放不下时 `observe` 返回 `null`，检测器返回未命中并记 `rate_window_skipped`。不要把原文或文件 id 放进 key。有正文时重复检测用 `textSha256`。没有正文但有 `mediaSha256` 时用这份摘要。两者都没有则跳过。配了 `RATE_WINDOW` 之后按群放进 Durable Object，调用失败记 `rate_window_failed` 并放过。提交的配置不绑定它。同一条事件 id 在这个 key 最近 32 次计数里只计一次。见 ADR 0010、ADR 0050、ADR 0052、ADR 0338 和 `docs/limits.md` 的 KV、Durable Objects 两节。

链接检测在 `packages/detectors-link`。默认只认短链域名、denylist 和 IPv4 主机。`ReputationSource` 不传就不会发请求。本地已命中时也不调用它。超时或抛错记 `reputation_failed`，返回 null。证据里只留主机名。抽主机名之前的折叠，以及每种字段怎么留下主机名，见 [message-surface.md](message-surface.md)。`tg://join?invite=` 和 `tg://addlist?slug=` 记成 `t.me` 邀请。`tg://resolve` 仍当公开用户名。邀请码不进证据。见 ADR 0102。

跨群黑名单在 `packages/detectors-blocklist`。`BlocklistStore` 先看这个群有没有打开。没打开就返回 null，并且不调用 `has`。打开后只匹配 actor id 或 `textSha256`。原文、带空格的句子、以及不是 64 位小写十六进制的值都不能写入。存储抛错记 `blocklist_failed`，返回 null。配了 `POLICY_KV` 时，开关和条目在变化时写入这份 KV。`remove` 删一条标识，不存在时不写。状态行带上这个租户的条目数，不列出标识。见 ADR 0012、ADR 0047、ADR 0048、ADR 0049 和 `docs/limits.md`。

适配器实现 `Storage`、`Cache`、`PolicyStore` 或 `ModerationPort`。不要把 D1、KV 或 Telegram 的类型 re-export 到 core 能 import 的位置。`RuleSource` 只返回未校验文档，schema 和缓存由 `loadRuleSet` 负责。`PolicyStore` 的实现要调用 `@tasb/core/testing` 的 `bindPolicyStoreContract`，和内存适配器、KV 适配器跑同一组行为。`Storage` 的实现要调用 `bindStorageContract`。`listAudits` 返回最近的一页，页内按时间从早到晚。`countAudits` 返回范围内的条数。`exportAudits` 返回这些审计。私聊放不下时用一次列表取最近一页，一条也放不下才只回复条数。`deleteAudits` 只删除这些审计并返回条数。`putAuditsIfAbsent` 按主键补上还没有的审计。`CaptchaStore.deleteMany` 一次删掉多条挑战。D1 把这两次调用各打成一批。导出 JSON 再过一遍审计 schema，不能带原文键。`put` 用 `prefilterPolicySchema` 拒绝空 id、超过 128 字符的 id，以及超过 200 个 id。读到无法通过 schema 的文档时返回 null，不要把文档写进日志。

私聊命令的句子在 `packages/core` 的消息目录里，键是 `command.*`。`translate` 在未知语言时用中文，缺键时返回 key，不抛错。新增一句回复要同时写 `zh` 和 `en`。见 ADR 0013。

`/appeal` 读 `Storage.getAudit`，再用 `buildReviewSample` 写入 `ReviewQueue`。样本只有哈希、动作、分数、reason 和规则 id。证据摘要不复制。队列满 256 条或存储抛错时回复「参数无效」，日志是 `operator_rejected`。见 ADR 0014。

`/evals` 读 `ReviewQueue.list`，再用 `buildFeedbackCase` 收成评测样本。`confirmed` 是 `spam`，`false_positive` 是 `ham`。文档不带原文，也不能送回检测器重放。放不下全部样本时返回最近的一页，并写上省略条数。见 ADR 0016 和 ADR 0330。形状在 `evals/cases/feedback.json`。

`llm` 检测器在 `packages/detectors-llm`。没有 `LlmClassifier` 时返回 null。分类器抛错或超时记 `llm_failed`，也返回 null。证据只写 `llm:` 加标签。默认模型和使用方式见 ADR 0015。评测在 `evals/cases/llm.json`。

`regex` 检测器在 `packages/detectors-regex`。配置是 1 到 8 条模式，每条最多 64 个字符，只用 `u`。创建时拒绝嵌套量词、分组量词、反向引用和 `{`。比较前会去掉零宽字符、双向控制符、非常规空白、换行、变体选择符和点状间隔号，并把全角拉丁字母、七个西里尔字母和乌克兰语 `і` 收成拉丁字母，模式本身不改。一层百分号编码的间隔号先收成对应字符再去掉。第二层和句号 `。` 的编码保留。普通空格、句号 `。`、全角数字和西里尔 `т` 保留。`test` 抛错记 `regex_failed` 并返回 null。证据固定是 `regex:hit`，不写匹配片段，也不写模式。默认规则 `regex_hint` 是关闭的。见 ADR 0023、ADR 0054、ADR 0060、ADR 0064、ADR 0093、ADR 0094、ADR 0095、ADR 0096、ADR 0098 和 ADR 0099。评测在 `evals/cases/regex.json`。

关键词检测同样先做这层折叠，再做包含判断。除了一层间隔号编码，百分号编码不在这一层解释。只由这些字符组成的关键词不会匹配所有消息。证据里的词也折叠。点状间隔号去掉。全角拉丁字母收成半角。七个西里尔字母和乌克兰语 `і` 收成拉丁字母。普通空格、句号 `。`、全角数字和西里尔 `т` 保留。一层百分号编码的间隔号先收成对应字符再去掉。第二层和句号 `。` 的编码保留。见 ADR 0054、ADR 0060、ADR 0064、ADR 0093、ADR 0094、ADR 0095、ADR 0096、ADR 0098 和 ADR 0099。没有 `text` 和 `caption` 时，投票题干、抽奖奖品说明、清单标题、游戏标题、账单标题、场馆标题、文件名、音频标题、表演者、内联按钮文字或手动引用会先成为这段正文。几个按钮用一个普通空格分开。自动引用、被回复的原消息、选项、任务文字、说明、附加文字、地址、坐标、贴纸包名、文件 id、回复键盘和复制句子不进事件。见 ADR 0056、ADR 0057、ADR 0058、ADR 0059、ADR 0061、ADR 0062、ADR 0063 和 ADR 0092。没有更前面的正文时，作者签名整段成为正文。已有正文时签名不并进去。见 ADR 0101。没有更前面的正文时，成员标签也整段成为正文。已有正文或作者签名时，标签不并进去。见 ADR 0112。没有更前面的正文时，拒绝建议帖的说明也整段成为正文。已有正文时说明不并进去。嵌套的原帖不读。见 ADR 0113。

`forward` 检测器在 `packages/detectors-forward`。它只看 `message.forward`。Worker 默认只把 `channel` 当命中，证据是 `forward:channel`。用户、群和隐藏来源要改配置才会命中。见 ADR 0025。评测在 `evals/cases/forward.json`。

`aggregateMetrics` 读取 `pipeline_completed`、`pipeline_exempt`、检测器失败和存储失败日志。dry-run 不计入拦截率。`log` 和 `report` 计入动作，不计入拦截。结果里没有原文和昵称。见 ADR 0017。最小例子在 `examples/minimal-pipeline`。

规则包订阅走 `RuleSubscriptionStore`、`RulePackSource` 和 `RulePackArchive`。默认关闭。`/packs <chatId> off` 下一条消息就不再读规则包。刷新失败时保留上一份通过 schema 的 `RuleSet`。配了 `POLICY_KV` 时订阅指针和上一份通过 schema 的规则按群放进这份 KV。规则没变不写，超过 16384 个字符不写。私聊 `/rules` 列出这份解析结果，已订阅时标题带上 pack id，每一行标明 `file` 或 `switch`。放不下全部规则时列出前面的若干条，并写上剩下的条数。见 ADR 0333。超额之后，不在基础检测器里的规则加上 `paused`，标题末尾带上窗口结束时间。超额的 `/quota` 在下一行列出这些基础检测器 id，顺序与策略一致，默认名单仍是 ADR 0026。同一条事件 id 在该群最近 64 次计数里只计一次。见 ADR 0337。状态行末尾带窗口结束时间。见 ADR 0019、ADR 0037、ADR 0038、ADR 0039、ADR 0040、ADR 0041、ADR 0042、ADR 0043、ADR 0044、ADR 0046 和 `examples/operator-commands`。

插件清单含 `id`、`version`、`kind`、`schema`、`integrity`，外部包还可以有 `signature`。完整性是 canonical JSON 的 sha256。签名是同一段 JSON 的 HMAC-SHA256。内置清单可以不签名。外部清单没有有效签名时不会进入流水线，除非自部署把 `ALLOW_UNSIGNED_PLUGINS` 设为 `true`。`DEPLOYMENT_MODE=cloud` 时这个变量无效。坏签名在两种模式下都拒绝。见 ADR 0018 和 `examples/plugin-manifest`。

平台包把 Telegram `Update` 收成 `Event`。参考 `packages/platform-telegram` 和 `examples/telegram-webhook`。Webhook 失败时不要调用 `onEvent`。私聊管理命令见 `examples/operator-commands` 和 ADR 0006。`/logs` 一行放不下全部规则或原因时，保留前面的若干个并写上剩下的个数。见 ADR 0334。回复只通过 `ReplyPort` 发送，不要在 core 里调用 Bot API。

提交前：

```sh
pnpm boundaries
pnpm test
pnpm eval
```
