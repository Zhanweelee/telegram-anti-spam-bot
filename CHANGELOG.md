# Changelog

包版本由 Changesets 在发布时生成。这里记录已经落地的轮次，方便不看 PR 的人了解仓库状态。

## Unreleased

### P3-12

- 额度打开时，私聊 `/chats` 每一行带上已用次数和上限。见 ADR 0045。
- 每个群只读一次，不计数。读失败的行只留群 id。名单超过私聊长度时末尾是 `+` 和省略条数。
- 云额度的基础检测器名单没有改。

### P3-11

- 超额之后，私聊 `/rules` 的标题末尾带上窗口结束时间。见 ADR 0044。
- 没超额或快照没有这份时间时标题不变。查看只读一次，不计数。
- 云额度的基础检测器名单没有改。

### P3-10

- 私聊 `/quota` 在状态行末尾带上当前窗口的结束时间。见 ADR 0043。
- 自然月即使还没计数也会给出下一次 UTC 月初。30 天窗口在第一次计数之前不写。
- 云额度的基础检测器名单没有改。查看不计数。

### P3-09

- 超额之后，私聊 `/quota` 在状态行下一行列出基础检测器 id。见 ADR 0042。
- 没超额、名单为空或缺失时仍是一行。查看不计数。
- 云额度的基础检测器名单没有改。

### P3-08

- 超额之后，私聊 `/rules` 给不会跑的规则加上 `paused`。见 ADR 0041。
- 查看不计数。额度没打开或没超额时不加这个词。读取失败仍返回规则列表。
- 云额度的基础检测器名单没有改。

### P3-07

- 私聊 `/rules` 的每一行标明 `file` 或 `switch`。见 ADR 0040。
- 有覆盖记录时标 `switch`，清除后回到 `file`。不在当前规则里的覆盖不另起一行。
- 云额度的基础检测器名单没有改。

### P3-06

- 已订阅时，私聊 `/rules` 的标题带上规则包 id。见 ADR 0039。
- 未订阅时标题仍只有群 id。刷新失败但订阅还在时，标题保留 pack id。
- 云额度的基础检测器名单没有改。

### P3-05

- 私聊 `/rules` 在订阅了规则包时列出正在执行的规则。见 ADR 0038。
- 读订阅失败回复参数无效。刷新失败时与检测一样回退。`/rule` 仍按文件规则校验 id。
- 云额度的基础检测器名单没有改。

### P3-04

- 配了 `POLICY_KV` 之后，`/packs` 记下的规则包 id 会留在这份 KV 里。见 ADR 0037。
- 每个群一个键。本 isolate 缓存 60 秒。上一份成功的规则仍在内存，重启后要等下一次成功读取。没配 KV 时订阅仍是内存。
- 不新增绑定。云额度的基础检测器名单没有改。

### P2-07

- 配了 `POLICY_KV` 之后，拉进群记下的操作者会留在这份 KV 里。见 ADR 0036。
- 每个租户一个键，最多 256 个群、每群 32 个用户 id。不含群名。没配 KV 时仍是内存。
- 不新增绑定。

### P1-19

- 配了 `POLICY_KV` 之后，`/rule` 和 dry-run 会留在这份 KV 里。见 ADR 0035。
- 每个群一个键，最多 32 条覆盖。本 isolate 缓存 60 秒。没配 KV 时仍是内存，重启回到文件。
- 不新增绑定。云额度的基础检测器名单没有改。

### P1-18

- 私聊 `/rule` 可以打开、关闭或清除某一条已有规则。见 ADR 0034。
- 覆盖存在 isolate 内存里，读完缓存后才套上。重启后回到文件里的 `enabled`。
- `via_inline` 和 `regex_hint` 仍默认关闭。云额度的基础检测器名单没有改。

### P1-17

- 经 inline bot 发出的消息可以带 `message.via`。见 ADR 0033。
- bot 用户名和 id 不进入事件或日志。证据是 `via:bot`。
- 默认规则 `via_inline` 关闭。打开后才删除。云额度的基础检测器名单没有改。

### P1-16

- 共享名片会被删除。见 ADR 0032。
- 事件只留 `message.contact`。电话、姓名、user id 和 vCard 不进入事件或日志。
- 默认规则 `shared_contact` 开启。正文里的数字串仍保留。云额度的基础检测器名单没有改。

### P1-15

- 从群外加入的其它 bot 会被封禁，不再发验证按钮。见 ADR 0031。
- 事件不带用户名。已经在群里的 bot 被提升时保留。人类入群仍走验证。
- 默认规则 `bot_join` 开启。`chats.json` 整份替换的群不会自动带上它。云额度的基础检测器名单没有改。

### P1-14

- `t.me`、`telegram.me`、`telegram.dog` 的邀请链接会删除。见 ADR 0030。
- 证据是 `invite:` 加主机名。邀请码不进入事件或日志。
- 公开的 `t.me/名字` 保留。隐藏的 `text_link` 同样只留主机名。

### P1-13

- 隐藏的 `text_link` 只保留主机名，并交给现有链接规则。见 ADR 0029。
- 短链接和裸 IP 仍删除。普通网址保留。路径和查询不进入事件或日志。
- 可见正文里的普通链接行为不变。

### P1-12

- 入群昵称、姓氏和用户名会走关键词检测。命中后封禁，不再发验证按钮。见 ADR 0028。
- 证据仍是 `keyword:` 加配置词。审计只存哈希。日志不含昵称。
- 默认规则 `join_name` 开启。`chats.json` 整份替换的群不会自动带上它。

### P2-06

- 把 bot 拉进群并设为管理员即完成接入。见 ADR 0027。
- 授予的人可以在私聊管理该群。`/chats` 只列出群 id。配置中的管理员仍可管理全部群。
- 不保存群名。目录在 isolate 内存里，重启后清空。没有接支付。

### P2-03

- 免费额度做成配置。云模式默认每群每个 UTC 自然月 3000 次，超额只留基础检测器。见 ADR 0026。
- 自部署默认关闭。`QUOTA_ENABLED`、`QUOTA_LIMIT`、`QUOTA_PERIOD`、`QUOTA_BASIC` 可以覆盖。
- `/quota <chatId>` 只读已用次数。没有接支付。

### P1-11

- 消息可以带 `forward` 类别：`user`、`chat`、`channel`、`hidden`。见 ADR 0025。
- 默认规则删除频道转发。证据是 `forward:channel`。频道标题和来源 id 不进入事件。
- 用户转发、群转发和隐藏来源默认保留。`chats.json` 整份替换的群不会自动带上这条规则。

### P2-05

- 同一群 10 秒内第 31 条更新起返回 200，并且不跑流水线。见 ADR 0024。
- 其他群继续检测。计数失败时放过。日志不含原文。这不是云额度。

### P1-10

- 增加 `@tasb/detector-regex`。模式在创建时限定为短的安全子集。见 ADR 0023。
- 命中只记 `regex:hit`。匹配抛错记 `regex_failed` 并放过，日志不含原文和模式。
- 默认规则 `regex_hint` 关闭。`chats.json` 整份替换的群不会自动带上它。

### P1-09

- `edited_message` 收成内部消息，并带 `edited: true`。同一套规则会处理它。见 ADR 0022。
- 缺字段的编辑仍然忽略。`my_chat_member` 仍然忽略。
- 设置 webhook 时要把 `edited_message` 放进 `allowed_updates`。

### P1-08

- `log` 写一条不含原文的结构化日志。`report` 通过 `Notifier` 通知，正文只有群、事件、分数、规则和 reason。见 ADR 0021。
- 配了管理员和 bot token 时，上报发给第一个管理员，只发一条。没有通知端口时动作失败，决策保留。
- 默认规则不自动上报。

### P1-07

- 配了 `TELEGRAM_BOT_TOKEN` 之后，delete、mute、ban 各发一次 Telegram 请求。见 ADR 0020。
- ban 不撤回该成员的历史消息。没有 token 时不发请求。接口失败保留决策，日志不写 token、响应正文和消息原文。

### P3-03

- 群可以用 `/packs` 自愿订阅一份规则包。默认不订阅。见 ADR 0019。
- 刷新失败时保留上一份通过 schema 的 `RuleSet`。没有上一份才回到本地规则。日志不写异常文本。
- 规则包来自包内 `rules/packs.json`。提交的文件是空的。热路径不发远程请求。订阅留在 isolate 内存，重启后回到本地规则。

### P3-02

- 插件清单包含 id、版本、schema 和完整性摘要。外部包还要 HMAC 签名。见 ADR 0018。
- 未签名的外部插件不会进入流水线。自部署把 `ALLOW_UNSIGNED_PLUGINS` 设为 `true` 后可以打开。`DEPLOYMENT_MODE=cloud` 时这个值无效。
- 坏签名在两种模式下都拒绝。清单上的原文键会被 schema 丢掉，日志只留 id 和原因。

### P2-04

- `aggregateMetrics` 从日志汇总拦截率、动作计数、检测器错误和存储失败。见 ADR 0017。
- 分组标签只接受租户 id 和群 id。原文、昵称和带空格的值不会进入结果。
- dry-run 不计入拦截率。`log` 和 `report` 只计入动作。检测器失败日志带上 `tenantId`。

### P2-02

- 管理员可以用 `/evals` 把申诉导出成评测样本。确认记为 spam，误判记为 ham。见 ADR 0016。
- 样本只有哈希、动作、分数、reason、规则 id 和群 id。不带原文，也不能送回检测器重放。
- 没有审核队列或导出过长时，回复固定句子，日志不写异常文本。

### P2-01

- `llm` 检测器默认关闭，提交的配置不绑定 Workers AI。见 ADR 0015。
- 默认模型是免费计划上的 `@cf/huggingface/distilbert-sst-2-int8`。它做情感分类。`NEGATIVE` 且分数不低于 0.9 才命中。
- 额度错误、超时、坏响应，以及已知的付费模型，都跳过这条检测。日志不写原文。
- 评测集 `evals/cases/llm.json` 的 precision 和 recall 都是 1。

### P1-06

- 管理员可以用 `/appeal` 把一条审计标成误判或确认。样本不含原文，也不改规则。见 ADR 0014。
- 配了 D1 时样本在 `review_samples`。没配时留在 isolate 内存，每个租户最多 256 条。
- `/forget` 只删审计，审核队列还在。

### P1-05

- 私聊命令回复走消息目录，默认中文，`LOCALE=en` 时用英文。见 ADR 0013。
- 未知语言按中文。目录里没有的 key 原样返回，不抛错。
- 导出的审计 JSON 仍然是数据，不翻译。

### P1-04

- 跨群黑名单默认关闭。打开后只保存 actor id 或 sha256，不保存原文。见 ADR 0012。
- 某个群关掉之后，下一条消息不再读取共享名单。名单在 isolate 内存里，不走 KV 或 D1。
- 私聊命令 `/blocklist` 给配置中的管理员。回复不回显哈希或原文。
- 评测集 `evals/cases/blocklist.json` 的 precision 和 recall 都是 1。

### P1-03

- 短链接和裸 IP 默认删除。普通网址保留。见 ADR 0011。
- Worker 不传信誉源，热路径不发远程查询。信誉源超时或抛错时这条检测放过，日志是 `reputation_failed`。
- 评测集 `evals/cases/link.json` 的 precision 和 recall 都是 1。

### P1-02

- 同一人在 10 秒内发到第 5 条，或同一内容哈希在 60 秒内出现第 3 次，默认规则会删除。见 ADR 0010。
- 计数在 isolate 内存里。窗口满了或计数抛错时，这一条检测跳过，请求继续。
- 评测集 `evals/cases/rate.json` 的 precision 和 recall 都是 1。

### P1-01

- 新成员在通过按钮验证前被限制发言。通过和超时都留下不含原文的审计。见 ADR 0009。
- 检测器抛错时默认 fail-open，不会限制这个人。没有 bot token，或按钮发不出去时，挑战会回滚。
- `callback_query` 收成 `kind: "challenge"`。设置 webhook 时要带上 `callback_query`。
- 账号上的那一个 Cron 每 15 分钟清理当前 isolate 里到期的验证。isolate 重启会丢掉未完成的挑战。

### P0-09

- 可以按租户导出审计 JSON，也可以再限定一个群。文档里没有原文键。见 ADR 0008。
- 删除该范围后，再次读取为空。规则和白名单还在。其它租户不受影响。
- 管理员在私聊使用 `/export` 和 `/forget`。超长导出只回复条数。
- 30 天自动清理仍未实现，等维护者确认 ADR 0003 的初始保留期。

### P0-08

- D1 按租户和群保存审计与规则文档。迁移语句可以重复执行。见 ADR 0007。
- allow 和 dry-run 不写审计。`appendAudit` 失败时决策保持不变，日志只有 `storage_failed`。
- 内存适配器与 D1 适配器共用 `@tasb/core/testing` 的 `bindStorageContract`。
- Worker 在 `DB` / `POLICY_KV` 存在时使用它们。两个绑定都可以不填，免费部署仍然成功。

### P0-07

- README 的 10 分钟路径包含设置 secret、`wrangler deploy` 和设置 webhook。
- 当时还没有 D1 适配器，所以那一版部署不创建 D1 或 KV，也不要求付费计划。
- `pnpm smoke` 检查 `/health`，以及不带密钥的 401 和带密钥的 webhook 200。

### P0-06

- 配置中的管理员可以在私聊使用 `/help`、`/rules`、`/whitelist`、`/logs`、`/dryrun`。
- 群聊里的命令不改白名单，也不改 dry-run，消息仍进入检测流水线。
- `/logs` 只返回审计摘要。回复走 `ReplyPort`；未配置 bot token 时不请求 Telegram。见 ADR 0006。

### P0-05

- `PolicyStore` 按 `tenantId` + `chatId` 保存预过滤策略。`loadPolicy` 先读缓存，缺记录时使用调用方的 fallback。
- 管理员豁免可以按群关掉。白名单不跨租户、不跨群。
- 内存适配器与 KV 形态的 Cloudflare 适配器共用 `@tasb/core/testing` 的同一组行为测试。Worker 在绑定 KV 之前使用内存存储。

### P0-04

- `ModerationPort` 增加 `muteActor` 与 `banActor`。说明见 ADR 0004。
- mute 和 ban 在 dry-run 时跳过，缺少 actor 时返回 `failed`。严重度仍是 ban > mute > delete。
- Worker 注册这两个动作。默认规则仍是 delete。尚未调用 Telegram 的处罚接口。

### P0-03

- Worker 从 `apps/worker/rules/default.json` 读取默认 RuleSet，`chats.json` 按 `chatId` 整份覆盖。
- `loadRuleSet` 先读 `Cache`。未命中不调用 `Storage.getRuleSet`。
- 规则 schema 失败或来源抛错时该群 fail-open，日志只有 `rules_invalid`，不含原文或文档内容。

### P0-02

- `chat_member` 更新归一化成 `kind: "chat_member"` 的 Event，不带消息正文。主体是状态变化的用户。
- 没有文本时关键词检测器返回 null，流水线放行且不抛错。

### P0-01

- `POST /telegram/webhook` 校验 `X-Telegram-Bot-Api-Secret-Token`。密钥未配置或不匹配时返回 401，不进入流水线。
- `message` 更新在 `platform-telegram` 里归一化成 `Event`。无文本、caption、匿名管理员和 `ADMIN_USER_IDS` 有 fixture 或单测。
- Worker 默认用关键词规则在当次请求的内存里做判定。尚未调用 Telegram 的删除接口。

### Round 0

- 建立 pnpm monorepo、TypeScript strict、Biome、Vitest、Wrangler、Changesets 和 CI。
- 增加 core 流水线：Event、规则、检测器、聚合、决策、动作、审计。
- 增加关键词检测器、删除动作、内存适配器，以及 `examples/minimal-pipeline`。
- 记录架构、三份 ADR，以及查证过的 Cloudflare 免费额度。
