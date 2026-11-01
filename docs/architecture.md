# 架构

TASB 是一个 Telegram 反垃圾 bot。运行形态有两种，核心只有一份。

- **Self-host**：用户把 `apps/worker` 部署到自己的 Cloudflare 账号。单租户，没有计费。
- **Cloud**：维护者部署公共 bot。用户把 bot 拉进群并授予管理员权限即接入。额度、租户目录放在 `apps/cloud`，以后才实现。

核心通过端口接收存储、时钟、日志和处罚能力。它不读取 `DEPLOYMENT_MODE`，也没有 `self-host` / `cloud` 分支。

## 依赖方向

```text
apps/worker
  ├─▶ packages/platform-telegram ─▶ packages/core
  ├─▶ packages/adapters-cloudflare ─▶ packages/core
  ├─▶ packages/detectors-* ─▶ packages/core
  └─▶ packages/actions ─▶ packages/core

apps/cloud ─▶ （未来的租户/额度模块；谁都不许反向依赖它）

examples / evals / packages/sdk ─▶ core 与插件

packages/core ─▶ zod
```

禁止的依赖：

- `packages/core` 依赖任何 adapter、platform、app、检测器或动作包
- 检测器依赖动作、适配器或 Telegram 包
- 适配器依赖 Telegram 包
- `apps/cloud` 被 core 引用

`scripts/check-boundaries.mjs` 在 CI 里检查 import。

## 一次检测

```text
Event
  → prefilter        管理员豁免 / 白名单，命中则直接 allow
  → detectors        并行。每个返回 score + reasons + evidence，或 null
  → aggregate        max 或 sum，按规则阈值比较
  → decision         取最重动作：ban > mute > delete > captcha > report > log > allow
  → actions          delete / mute / ban；dry-run 只记录，不调用端口
  → audit            非 allow 且非 dry-run 时写存储。失败不影响决策
```

检测器抛错或超时：默认 fail-open（当作没命中，并记一条 `detector_error`）。`failureMode: "closed"` 时把该检测器当作 score 1。配置错误（重复插件、非法超时、非法事件）直接抛出，不吞掉。

动作抛错同样不推翻已经做出的决策，结果记为 `failed`。

## 插件

Detector、Action、以及以后的 RuleSource、Notifier、Storage 都走同一套元数据：`id`、`version`、`capabilities`、zod `configSchema`。`defineDetector` / `defineAction` 在创建时校验配置。

规则是 JSON，由 `ruleSetSchema` 校验。版本字段目前只有 `1`。YAML 解析器还没有引入。

`loadRuleSet` 先读 `Cache`。未命中才向 `RuleSource` 要该群的文档，没有覆盖时再要默认文档。校验失败或来源抛错时返回空规则集，流水线放行，日志代码是 `rules_invalid`，不写异常文本。缓存读写失败只记 `rules_cache_failed`，已经解析好的规则仍然使用。这条路径不调用 `Storage.getRuleSet`，所以热路径不会为了规则去打 D1。

Self-host 的 `RuleSource` 是 `apps/worker/rules/default.json` 和 `chats.json`。群覆盖是整份替换。缓存目前是进程内内存，接口留给以后的 KV。

`loadPolicy` 同样先读 `Cache`，键是 `policy:<tenantId>:<chatId>`。未命中再读 `PolicyStore`。该群没有记录时使用调用方给的 fallback。Worker 的 fallback 是豁免管理员、空白名单。某个群把 `exemptAdmins` 存成 false 之后，只关闭这一群的豁免。白名单不跨租户、不跨群。存储抛错时记 `policy_store_failed` 并使用 fallback，不写异常文本。坏掉的缓存不当成「没有策略」，会再读一次存储。`put` 本身不清缓存。`savePolicy` 会在写入后覆盖这条缓存，私聊命令用的是它。说明见 ADR 0005 和 ADR 0006。

私聊命令的固定回复来自 core 里的 `zh` / `en` 目录。缺省中文。Worker 的可选 `LOCALE` 只接受这两种，别的值仍用中文。缺键时回复 key 本身。见 ADR 0013。`direct === true` 的事件才进入管理命令。群里的 `/whitelist`、`/dryrun` 仍走检测流水线，不写策略，也不改 dry-run。dry-run 存在 `RuntimeStore`，按 tenant + chat 读取。`/logs` 只返回审计摘要，不包含证据原文。`/appeal` 把一条审计标成误判或确认，样本进 `ReviewQueue`，不改规则。见 ADR 0014。回复经 `ReplyPort` 送出。

## 多租户

每条事件、规则和审计都带 `tenantId` 与 `chatId`。Self-host 是「一个租户、不计费」的配置，不是另一套程序。租户如何开通、额度如何扣，只允许出现在 `apps/cloud`。

## 隐私

请求处理期间，`Event.message.text` 可以留在内存里，检测器需要它。存储端口的 `AuditRecord` 没有原文栏位，只有 `textSha256`、原因和截断后的证据摘要。写入前会拒绝与原文完全相同的字符串，以及名为 `text` / `body` / `caption` / `raw` / `messageText` / `content` 的字段。

日志字段同样会丢掉这些键。检测器异常的 `message` 不会进入日志，避免把用户原文从错误对象里漏出去。

## Telegram 接入

`POST /telegram/webhook` 由 `packages/platform-telegram` 处理。

1. 读取 `X-Telegram-Bot-Api-Secret-Token`。`WEBHOOK_SECRET` 未配置、请求头缺失或不相等时返回 401，不调用 `onEvent`。比较时对两侧做 SHA-256，再按固定长度逐字节异或。密钥最长 256 字符，和 Telegram 的 `secret_token` 限制一致。
2. 正文超过 64 KiB 返回 413。JSON 无法解析，或缺少 `update_id`，返回 400。
3. `message` 收成 `kind: "message"`。`chat_member` 收成 `kind: "chat_member"`，不带 `message`。主体是 `new_chat_member.user`；`from` 只表示谁执行了操作。`new_chat_member.status` 为 `administrator` 或 `creator` 时 `actor.isAdmin` 为 true。从群外进入（旧状态缺失、`left` 或 `kicked`，新状态是 `member` 或 `restricted`，且不是 bot）时带 `membership: "join"`。`callback_query` 的 `data` 为 `c:` 加 16 位十六进制时收成 `kind: "challenge"`，只带 nonce，不带消息正文。其它回调仍忽略。`edited_message`、`my_chat_member` 以及其他更新返回 200，正文是 `{ "ok": true, "ignored": true }`，避免 Telegram 重试。设置 webhook 时把 `message`、`chat_member`、`callback_query` 都放进 `allowed_updates`。配了 bot token 时，回调会再应答一次，清掉按钮上的转圈。
4. 没有 `text` 时仍保留 `message.id`，正文记成空字符串并哈希。有 `caption` 且没有文本时用 caption。
5. 管理员不调用 `getChatMember`。`sender_chat.id` 与 `chat.id` 相同（匿名管理员），或 `from.id` 出现在 Worker 的 `ADMIN_USER_IDS`（逗号分隔）时，`actor.isAdmin` 为 true。

`apps/worker` 在归一化之后跑 core 流水线：关键词、入群、洪泛、重复和链接检测器，以及 delete、mute、ban、captcha。洪泛和重复的窗口在 isolate 内存里，满了就跳过该条检测。见 ADR 0010。链接检测默认不发网络请求；可选信誉源失败时返回未命中。见 ADR 0011。跨群黑名单默认关闭，只在 isolate 内存里保存 actor id 或 sha256。某个群关掉之后，下一条消息不再读这份名单。见 ADR 0012。`llm` 检测器默认不跑。规则 `llm_hint` 是关闭的，提交的配置也不绑定 Workers AI。打开之后，额度错误或超时记 `llm_failed` 并放过。见 ADR 0015。预过滤按租户和群从 `PolicyStore` 读取；没有记录时豁免管理员，所以管理员入群不会被要求验证。配了 `POLICY_KV` 时白名单走 KV，否则用内存。配了 `DB` 时审计和规则文档走 D1，否则审计留在内存，最多 200 条。规则热路径仍然是缓存加包内 JSON，不读 `Storage.getRuleSet`。delete、mute、ban 仍不请求 Telegram。captcha 在有 `TELEGRAM_BOT_TOKEN` 时调用 `restrictChatMember` 和 `sendMessage`。没有 token 时限制会失败并回滚挑战，成员不会被卡住。验证状态只在当前 isolate 的内存里。每 15 分钟的 Cron 只清理这个 isolate 里已经到期的挑战，并写一条不含原文的审计，不会解除限制；Telegram 的 `until_date` 自己到期。存储失败不改变决策。管理员可以在私聊导出或删除某个租户、某个群的审计；删除不碰规则和白名单。30 天自动清理还没有做。说明见 ADR 0007、ADR 0008 和 ADR 0009。

流水线抛错时 Worker 仍返回 200。日志代码是 `webhook_screen_failed`，只带 `eventId` 和 `chatId`。`JSON.parse` 和 zod 的异常文本可能含原文，所以这些失败只记固定代码。

`textSha256` 在这个包里用 Web Crypto 计算。`packages/sdk` 的 `sha256Hex` 依赖 `node:crypto`，Worker 不要 import 它。

## 部署形态放在哪

`apps/worker` 读取 `DEPLOYMENT_MODE`，只影响 `/health` 这样的进程元数据。把 bot 行为按模式拆开，需要新的 ADR。
