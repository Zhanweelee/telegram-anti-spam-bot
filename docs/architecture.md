# 架构

TASB 是一个 Telegram 反垃圾 bot。运行形态有两种，核心只有一份。

- **Self-host**：用户把 `apps/worker` 部署到自己的 Cloudflare 账号。单租户，没有计费。
- **Cloud**：维护者部署公共 bot。用户把 bot 拉进群并授予管理员权限即接入。免费额度的配置在 `apps/cloud`。支付还没有实现。

核心通过端口接收存储、时钟、日志和处罚能力。它不读取 `DEPLOYMENT_MODE`，也没有 `self-host` / `cloud` 分支。

## 依赖方向

```text
apps/worker
  ├─▶ packages/platform-telegram ─▶ packages/core
  ├─▶ packages/adapters-cloudflare ─▶ packages/core
  ├─▶ packages/detectors-* ─▶ packages/core
  ├─▶ packages/actions ─▶ packages/core
  └─▶ apps/cloud ─▶ packages/core

apps/cloud 只放租户目录和免费额度。core 不引用它，也不读取部署模式。

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

动作抛错同样不推翻已经做出的决策，结果记为 `failed`。`log` 写一条不含原文的日志。`report` 调用 `Notifier`，通知里没有消息原文和证据摘要。见 ADR 0021。

## 插件

Detector、Action、以及以后的 RuleSource、Notifier、Storage 都走同一套元数据：`id`、`version`、`capabilities`、zod `configSchema`。`defineDetector` / `defineAction` 在创建时校验配置。

规则是 JSON，由 `ruleSetSchema` 校验。版本字段目前只有 `1`。YAML 解析器还没有引入。

`loadRuleSet` 先读 `Cache`。未命中才向 `RuleSource` 要该群的文档，没有覆盖时再要默认文档。校验失败或来源抛错时返回空规则集，流水线放行，日志代码是 `rules_invalid`，不写异常文本。缓存读写失败只记 `rules_cache_failed`，已经解析好的规则仍然使用。这条路径不调用 `Storage.getRuleSet`，所以热路径不会为了规则去打 D1。

`resolveRuleSet` 在没有规则包时调用 `loadRuleSet`。群通过 `/packs` 订阅之后，缓存键换成 `pack:<tenant>:<chat>:<packId>`。刷新失败时使用归档里上一份通过 schema 的规则，不把空规则写进去。没有上一份才回到本地规则。未订阅的群不读取规则包。见 ADR 0019。配了 `POLICY_KV` 时，订阅指针和上一份通过 schema 的规则按群各一个键写进同一份 KV。规则 JSON 没变不写，超过 16384 个字符不写。见 ADR 0037 和 ADR 0046。私聊 `/rules` 走同一份 `resolveRuleSet`，所以列出的是检测正在用的规则。已订阅时标题带上 pack id。每一行标明 `file` 或 `switch`。超额之后，不在基础检测器里的规则行末尾加上 `paused`，标题末尾带上窗口结束时间，这次查看不计数。见 ADR 0038、ADR 0039、ADR 0040、ADR 0041 和 ADR 0044。规则开关是运行时覆盖，套在读出缓存之后，不是第二份规则集。见 ADR 0034。配了 `POLICY_KV` 时，这份覆盖和 dry-run 按群写进同一个 KV，每个 isolate 缓存 60 秒。见 ADR 0035。

Self-host 的 `RuleSource` 是 `apps/worker/rules/default.json` 和 `chats.json`。群覆盖是整份替换。缓存目前是进程内内存，接口留给以后的 KV。

`loadPolicy` 同样先读 `Cache`，键是 `policy:<tenantId>:<chatId>`。未命中再读 `PolicyStore`。该群没有记录时使用调用方给的 fallback。Worker 的 fallback 是豁免管理员、空白名单。某个群把 `exemptAdmins` 存成 false 之后，只关闭这一群的豁免。白名单不跨租户、不跨群。存储抛错时记 `policy_store_failed` 并使用 fallback，不写异常文本。坏掉的缓存不当成「没有策略」，会再读一次存储。`put` 本身不清缓存。`savePolicy` 会在写入后覆盖这条缓存，私聊命令用的是它。说明见 ADR 0005 和 ADR 0006。

私聊命令的固定回复来自 core 里的 `zh` / `en` 目录。缺省中文。Worker 的可选 `LOCALE` 只接受这两种，别的值仍用中文。缺键时回复 key 本身。见 ADR 0013。`direct === true` 的事件才进入管理命令。群里的 `/whitelist`、`/dryrun` 仍走检测流水线，不写策略，也不改 dry-run。dry-run 和单条规则的启用覆盖都存在 `RuntimeStore`，按 tenant + chat 读取。`/logs` 只返回审计摘要，不包含证据原文。`/appeal` 把一条审计标成误判或确认，样本进 `ReviewQueue`，不改规则。见 ADR 0014。`/evals` 把这些样本导出成评测文档：确认是 spam，误判是 ham，只有哈希和特征。见 ADR 0016。回复经 `ReplyPort` 送出。

## 多租户

每条事件、规则和审计都带 `tenantId` 与 `chatId`。Self-host 是「一个租户、默认不计额度」的配置，不是另一套程序。免费额度的开关、次数、周期和基础检测器只放在 `apps/cloud`。core 只认识一份只读快照。见 ADR 0026。

`DEPLOYMENT_MODE=cloud` 时默认打开：每个群每个 UTC 自然月 3000 次。超过之后，只留下 `QUOTA_BASIC` 里的检测器，默认不含 `llm`。自部署默认关闭。`QUOTA_ENABLED` 可以覆盖。计数在 isolate 内存，最多 256 个群，重启清零。放不下或抛错时不降级。管理员消息不计数。`/quota <chatId>` 只读。状态行末尾带窗口结束时间。超额时下一行列出基础检测器 id，默认名单仍是 ADR 0026。见 ADR 0042 和 ADR 0043。支付和 Telegram Stars 没有实现。

接入目录也在 `apps/cloud`。授予 bot 管理员的人，以及之后被标成管理员的人，只能在私聊操作自己的群。`ADMIN_USER_IDS` 仍可操作全部群。`/chats` 返回群 id。额度打开时每一行带上已用次数和上限，每个群只读一次，不计数。读失败的那一行只留群 id。名单超过私聊长度时末尾是 `+` 和省略条数。目录最多 256 个群、每群 32 人。没配 `POLICY_KV` 时重启清空。配了之后按租户一个键留在同一份 KV 里，本 isolate 缓存 60 秒。见 ADR 0027、ADR 0036 和 ADR 0045。

## 隐私

请求处理期间，`Event.message.text` 可以留在内存里，检测器需要它。存储端口的 `AuditRecord` 没有原文栏位，只有 `textSha256`、原因和截断后的证据摘要。写入前会拒绝与原文完全相同的字符串，以及名为 `text` / `body` / `caption` / `raw` / `messageText` / `content` 的字段。

日志字段同样会丢掉这些键。检测器异常的 `message` 不会进入日志，避免把用户原文从错误对象里漏出去。`aggregateMetrics` 只从这些日志汇总拦截率、动作、检测器错误和存储失败。分组标签只接受租户 id 和群 id。见 ADR 0017。插件能否加载由 `admitPlugin` 决定。core 只比较调用方算好的摘要和签名是否有效，不读部署模式。见 ADR 0018。

## Telegram 接入

`POST /telegram/webhook` 由 `packages/platform-telegram` 处理。

1. 读取 `X-Telegram-Bot-Api-Secret-Token`。`WEBHOOK_SECRET` 未配置、请求头缺失或不相等时返回 401，不调用 `onEvent`。比较时对两侧做 SHA-256，再按固定长度逐字节异或。密钥最长 256 字符，和 Telegram 的 `secret_token` 限制一致。
2. 正文超过 64 KiB 返回 413。JSON 无法解析，或缺少 `update_id`，返回 400。
3. `message` 收成 `kind: "message"`。`chat_member` 收成 `kind: "chat_member"`，不带 `message`。主体是 `new_chat_member.user`；`from` 只表示谁执行了操作。`new_chat_member.status` 为 `administrator` 或 `creator` 时 `actor.isAdmin` 为 true。从群外进入（旧状态缺失、`left` 或 `kicked`，新状态是 `member` 或 `restricted`，且不是 bot）时带 `membership: "join"`。`callback_query` 的 `data` 为 `c:` 加 16 位十六进制时收成 `kind: "challenge"`，只带 nonce，不带消息正文。其它回调仍忽略。`edited_message` 收成同一条 `kind: "message"`，并带 `edited: true`。正文仍只留在当次请求的内存里。群和超级群的 `my_chat_member` 收成 `kind: "bot_membership"`，只带 `admin` 或 `gone`，不带群名。私聊和频道忽略。见 ADR 0027。其它更新返回 200，正文是 `{ "ok": true, "ignored": true }`，避免 Telegram 重试。设置 webhook 时把 `message`、`edited_message`、`chat_member`、`callback_query`、`my_chat_member` 都放进 `allowed_updates`。见 ADR 0022。配了 bot token 时，回调会再应答一次，清掉按钮上的转圈。
4. 没有 `text` 时仍保留 `message.id`，正文记成空字符串并哈希。有 `caption` 且没有文本时用 caption。两者都没有时，用投票题干、抽奖奖品说明、清单标题、游戏标题、账单标题、场馆标题、动图或视频或文件的文件名、音频标题、表演者、内联按钮文字，或一条手动引用，见 ADR 0056、ADR 0057、ADR 0058、ADR 0059、ADR 0061、ADR 0062、ADR 0063 和 ADR 0092。没有更前面的正文时，作者签名成为正文。见 ADR 0101。贴纸包名、文件 id、回复键盘、自动引用和被回复的原消息不进事件。纯位置消息没有名称，正文仍是空字符串。
5. 管理员不调用 `getChatMember`。`sender_chat.id` 与 `chat.id` 相同（匿名管理员），或 `from.id` 出现在 Worker 的 `ADMIN_USER_IDS`（逗号分隔）时，`actor.isAdmin` 为 true。
6. Worker 在跑流水线之前按租户和群计数。同一群 10 秒内超过 30 条更新时返回 200，正文是 `{ "ok": true, "limited": true }`，不调用 `onEvent`。其他群继续检测。计数失败时放过。见 ADR 0024。

`apps/worker` 在归一化之后跑 core 流水线：关键词、入群、洪泛、重复和链接检测器，以及 delete、mute、ban、captcha。洪泛和重复的窗口默认在 isolate 内存里，满了就跳过该条检测。配了 `RATE_WINDOW` 之后按群放进 Durable Object，调用失败则跳过。提交的配置不绑定它。见 ADR 0010、ADR 0050 和 ADR 0052。贴纸、图片、视频笔记和语音没有可当正文的名称时，用文件摘要参加重复判断。文件 id 和贴纸包名不进事件。动图、视频、音频和普通文件没有更前面的正文时，文件名或音频标题成为正文，重复改按这段正文计次。有其它正文时仍按正文摘要。见 ADR 0052 和 ADR 0062。链接检测默认不发网络请求；可选信誉源失败时返回未命中。抽主机名之前先做和关键词相同的折叠，再去掉两层百分号编码的格式字符，并把 `%2E`、`%2F` 和 `%2B` 收成分隔符，再把一层字母、数字、连字符和下划线的 `%HH` 和 `%25HH` 收成字符。普通空格、`%20`、`%252E`、`%252F`、`%252B` 和第三层 `%252545` 保留。见 ADR 0011、ADR 0065、ADR 0067、ADR 0068、ADR 0069、ADR 0070、ADR 0071、ADR 0072 和 ADR 0073。点状间隔号在抽主机名前收成 ASCII 点，关键词和正则比较前直接去掉。一层百分号编码的间隔号先收成对应字符。第二层和句号 `。` 的编码保留。句号、普通空格和全角加号保留。见 ADR 0093、ADR 0098 和 ADR 0099。全角拉丁字母收成半角。全角数字保留。见 ADR 0094。七个西里尔字母和乌克兰语 `і` 收成拉丁字母。西里尔 `т` 不映成 `t`。抽主机名时再去掉剩下的西里尔、希腊、亚美尼亚文和非 ASCII 拉丁字母。汉字仍可紧贴短链。见 ADR 0095、ADR 0096、ADR 0097 和 ADR 0100。方括号、圆括号和花括号包住的点也收成 ASCII 点。一层百分号编码的同一对也收成点。第二层、括号里的空格和单独的句号仍保留。关键词比较不走这一层。见 ADR 0103 和 ADR 0104。已有正文时，按钮文字、文件名、作者签名和其它旁路纯文本走和正文相同的主机折叠。带协议的地址仍按原来的顺序解析。见 ADR 0105。隐藏的 text_link、内联按钮 `url`、`login_url`、`web_app`，以及从 `copy_text` 里抽出的网址，解析前做同一层折叠，只把主机名交给同一条规则。普通空格仍让这条地址无效。没有更前面的正文时，内联按钮文字成为正文。已有正文时按钮文字不并进去。复制句子本身不进事件。没有 `text` 和 `caption` 时，富文本里看得见的字成为正文。富文本链接和按钮只留主机名。投票选项、说明和清单任务里的网址也只留主机名。游戏说明、附加文字和账单说明里的网址也只留主机名。链接预览指定的网址也只留主机名。场馆地址、场馆标题、游戏标题、账单标题、投票题干、奖品说明、清单标题、文件名、音频标题、表演者、手动引用、按钮文字、礼物附言、论坛话题名、后加的投票选项、清单任务、付费视频文件名、隐藏转发显示名和这条消息自己的作者签名里的网址也只留主机名。没有更前面的正文时，表演者、礼物附言、论坛话题名、后加的投票选项、清单任务、付费视频文件名、隐藏转发显示名和作者签名成为正文。转发来源上的作者签名仍不读。见 ADR 0029、ADR 0053、ADR 0055、ADR 0063、ADR 0066、ADR 0067、ADR 0074、ADR 0075、ADR 0076、ADR 0077、ADR 0078、ADR 0079、ADR 0080、ADR 0081、ADR 0082、ADR 0083、ADR 0084、ADR 0085、ADR 0086、ADR 0087、ADR 0088、ADR 0089、ADR 0090、ADR 0091、ADR 0092 和 ADR 0101。Telegram 邀请只记主机名，邀请码不进事件。公开用户名链接保留。`tg://join?invite=` 和 `tg://addlist?slug=` 也记成 `t.me`。`tg://resolve` 仍保留。见 ADR 0030 和 ADR 0102。跨群黑名单默认关闭，只保存 actor id 或 sha256。没配 `POLICY_KV` 时留在 isolate 内存。配了之后每个租户一个键，只在开关或条目变化时写，本 isolate 缓存 60 秒。发出关闭的 isolate 下一条消息不再读这份名单。私聊 `remove` 删一条标识，回复不回显它。状态行带上这个租户的条目数。见 ADR 0012、ADR 0047、ADR 0048 和 ADR 0049。`llm` 检测器默认不跑。规则 `llm_hint` 是关闭的，提交的配置也不绑定 Workers AI。打开之后，额度错误或超时记 `llm_failed` 并放过。见 ADR 0015。`regex` 检测器同样默认不跑。规则 `regex_hint` 是关闭的。模式在创建时拒绝嵌套量词，命中只记 `regex:hit`。见 ADR 0023。关键词和正则在比较前去掉零宽字符、双向控制符、非常规空白、换行和变体选择符。普通空格保留，正文和哈希不变。见 ADR 0054、ADR 0060 和 ADR 0064。频道转发默认删除。事件只保留 `user`、`chat`、`channel`、`hidden` 这四类，不保留频道标题。用户转发、群转发和隐藏来源默认保留。见 ADR 0025。从群外加入时，昵称、姓氏和用户名会交给关键词检测。命中后封禁，不再发验证按钮。审计只存哈希。见 ADR 0028。从群外加入的其它 bot 带 `actor.bot`，默认封禁，不带用户名。见 ADR 0031。共享名片只留 `message.contact`，电话和姓名丢掉，默认删除。见 ADR 0032。`via_bot` 只留 `message.via`。规则 `via_inline` 默认关闭，打开后删除，不留 bot 用户名。见 ADR 0033。预过滤按租户和群从 `PolicyStore` 读取；没有记录时豁免管理员，所以管理员入群不会被要求验证。配了 `POLICY_KV` 时白名单走 KV，否则用内存。配了 `DB` 时审计和规则文档走 D1，否则审计留在内存，最多 200 条。规则热路径仍然是缓存加包内 JSON，不读 `Storage.getRuleSet`。配了 `TELEGRAM_BOT_TOKEN` 时，delete 调用 `deleteMessage`，mute 调用 `restrictChatMember`，ban 调用 `banChatMember` 且不撤回历史消息。各一次子请求。没有 token 时这三步只记在内存里。接口失败记 `action_failed`，决策保留，日志不写 token 和原文。见 ADR 0020。captcha 在有 `TELEGRAM_BOT_TOKEN` 时调用 `restrictChatMember` 和 `sendMessage`。没有 token 时限制会失败并回滚挑战，成员不会被卡住。没配 `DB` 时验证状态只在当前 isolate 的内存里。配了 `DB` 之后挑战写进 D1，另一个 isolate 也能对上按钮。表只有主键。坏行不回写。每 15 分钟的 Cron 清理已经到期的挑战，一次最多 64 条，并写一条不含原文的审计，不会解除限制。见 ADR 0009 和 ADR 0051。Telegram 的 `until_date` 自己到期。存储失败不改变决策。管理员可以在私聊导出或删除某个租户、某个群的审计；删除不碰规则和白名单。30 天自动清理还没有做。说明见 ADR 0007、ADR 0008 和 ADR 0009。

流水线抛错时 Worker 仍返回 200。日志代码是 `webhook_screen_failed`，只带 `eventId` 和 `chatId`。`JSON.parse` 和 zod 的异常文本可能含原文，所以这些失败只记固定代码。

`textSha256` 在这个包里用 Web Crypto 计算。`packages/sdk` 的 `sha256Hex` 依赖 `node:crypto`，Worker 不要 import 它。

## 部署形态放在哪

`apps/worker` 读取 `DEPLOYMENT_MODE`，只影响 `/health` 这样的进程元数据。把 bot 行为按模式拆开，需要新的 ADR。
