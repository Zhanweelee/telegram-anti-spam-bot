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
  → audit            非 allow 且非 dry-run 时先用一次插入占住审计。占住才执行动作。已经有记录就跳过动作。插入失败仍执行动作。见 ADR 0335 和 ADR 0336。
```

检测器抛错或超时：默认 fail-open（当作没命中，并记一条 `detector_error`）。`failureMode: "closed"` 时把该检测器当作 score 1。配置错误（重复插件、非法超时、非法事件）直接抛出，不吞掉。

动作抛错同样不推翻已经做出的决策，结果记为 `failed`。`log` 写一条不含原文的日志。`report` 调用 `Notifier`，通知里没有消息原文和证据摘要。见 ADR 0021。

## 插件

Detector、Action、以及以后的 RuleSource、Notifier、Storage 都走同一套元数据：`id`、`version`、`capabilities`、zod `configSchema`。`defineDetector` / `defineAction` 在创建时校验配置。

规则是 JSON，由 `ruleSetSchema` 校验。版本字段目前只有 `1`。YAML 解析器还没有引入。

`loadRuleSet` 先读 `Cache`。未命中才向 `RuleSource` 要该群的文档，没有覆盖时再要默认文档。校验失败或来源抛错时返回空规则集，流水线放行，日志代码是 `rules_invalid`，不写异常文本。缓存读写失败只记 `rules_cache_failed`，已经解析好的规则仍然使用。这条路径不调用 `Storage.getRuleSet`，所以热路径不会为了规则去打 D1。

`resolveRuleSet` 在没有规则包时调用 `loadRuleSet`。群通过 `/packs` 订阅之后，缓存键换成 `pack:<tenant>:<chat>:<packId>`。刷新失败时使用归档里上一份通过 schema 的规则，不把空规则写进去。没有上一份才回到本地规则。未订阅的群不读取规则包。见 ADR 0019。配了 `POLICY_KV` 时，订阅指针和上一份通过 schema 的规则按群各一个键写进同一份 KV。规则 JSON 没变不写，超过 16384 个字符不写。见 ADR 0037 和 ADR 0046。私聊 `/rules` 走同一份 `resolveRuleSet`，所以列出的是检测正在用的规则。已订阅时标题带上 pack id。每一行标明 `file` 或 `switch`。超额之后，不在基础检测器里的规则行末尾加上 `paused`，标题末尾带上窗口结束时间，这次查看不计数。见 ADR 0038、ADR 0039、ADR 0040、ADR 0041 和 ADR 0044。放不下全部规则时，按原顺序列出前面的若干条，并写上剩下的条数。见 ADR 0333。规则开关是运行时覆盖，套在读出缓存之后，不是第二份规则集。见 ADR 0034。配了 `POLICY_KV` 时，这份覆盖和 dry-run 按群写进同一个 KV，每个 isolate 缓存 60 秒。见 ADR 0035。

Self-host 的 `RuleSource` 是 `apps/worker/rules/default.json` 和 `chats.json`。群覆盖是整份替换。缓存目前是进程内内存，接口留给以后的 KV。

`loadPolicy` 同样先读 `Cache`，键是 `policy:<tenantId>:<chatId>`。未命中再读 `PolicyStore`。该群没有记录时使用调用方给的 fallback。Worker 的 fallback 是豁免管理员、空白名单。某个群把 `exemptAdmins` 存成 false 之后，只关闭这一群的豁免。白名单不跨租户、不跨群。存储抛错时记 `policy_store_failed` 并使用 fallback，不写异常文本。坏掉的缓存不当成「没有策略」，会再读一次存储。`put` 本身不清缓存。`savePolicy` 会在写入后覆盖这条缓存，私聊命令用的是它。说明见 ADR 0005 和 ADR 0006。私聊 `/whitelist` 放不下全部 id 时，按原顺序列出前面的若干个，并写上剩下的个数。见 ADR 0332。

私聊命令的固定回复来自 core 里的 `zh` / `en` 目录。缺省中文。Worker 的可选 `LOCALE` 只接受这两种，别的值仍用中文。缺键时回复 key 本身。见 ADR 0013。`direct === true` 的事件才进入管理命令。群里的 `/whitelist`、`/dryrun` 仍走检测流水线，不写策略，也不改 dry-run。dry-run 和单条规则的启用覆盖都存在 `RuntimeStore`，按 tenant + chat 读取。`/logs` 只返回审计摘要，不包含证据原文。一行里的规则或原因放不下时，按原顺序保留前面的若干个，并写上剩下的个数。见 ADR 0334。`/appeal` 把一条审计标成误判或确认，样本进 `ReviewQueue`，不改规则。见 ADR 0014。`/evals` 把这些样本导出成评测文档：确认是 spam，误判是 ham，只有哈希和特征。放不下全部样本时返回最近的一页，并写上省略条数。一条也放不下时只回复条数。见 ADR 0016 和 ADR 0330。回复经 `ReplyPort` 送出。`/unban` 只对已经封禁的人调用 `unbanChatMember`，`only_if_banned` 为 true。见 ADR 0362。`/unmute` 先看成员状态，只有 `restricted` 才把每一项权限打开。见 ADR 0363。`/ban` 调用 `banChatMember`，`revoke_messages` 为 false，不带 `until_date`。见 ADR 0364。`/mute` 不写秒数时禁言 3600 秒，写出的秒数要落在 30 秒到 366 天。见 ADR 0365。`/member` 只回报成员状态。姓名、标签和订阅到期不进回复。见 ADR 0366。`/delete` 按消息号调用 `deleteMessage`，不带接收者。见 ADR 0367。`/deletes` 一次提交最多 100 个消息号，并写明找不到的会跳过。见 ADR 0374。`/decline` 按成员号调用 `declineChatJoinRequest`，不带查询号。见 ADR 0368。`/approve` 按成员号调用 `approveChatJoinRequest`，不带查询号。见 ADR 0369。`/bansender` 按频道号调用 `banChatSenderChat`，不封用户。见 ADR 0370。`/unbansender` 按频道号调用 `unbanChatSenderChat`，不解封用户。见 ADR 0371。`/lock` 把一群的默认发言权限全部关掉，管理员仍可发言。见 ADR 0372。`/unlock` 把默认发言权限全部打开，并写明可能比锁定前更宽。见 ADR 0373。`/perms` 只回报当前默认的十六项权限。见 ADR 0375。`/clearreact` 清除一个用户或频道最近的反应。见 ADR 0376。

## 多租户

每条事件、规则和审计都带 `tenantId` 与 `chatId`。Self-host 是「一个租户、默认不计额度」的配置，不是另一套程序。免费额度的开关、次数、周期和基础检测器只放在 `apps/cloud`。core 只认识一份只读快照。见 ADR 0026。

`DEPLOYMENT_MODE=cloud` 时默认打开：每个群每个 UTC 自然月 3000 次。超过之后，只留下 `QUOTA_BASIC` 里的检测器，默认不含 `llm`。自部署默认关闭。`QUOTA_ENABLED` 可以覆盖。计数在 isolate 内存，最多 256 个群，重启清零。放不下或抛错时不降级。管理员消息不计数。`/quota <chatId>` 只读。状态行末尾带窗口结束时间。超额时下一行列出基础检测器 id，默认名单仍是 ADR 0026。见 ADR 0042 和 ADR 0043。支付和 Telegram Stars 没有实现。同一条事件 id 在该群最近 64 次计数里只计一次。见 ADR 0337。

接入目录也在 `apps/cloud`。授予 bot 管理员的人，以及之后被标成管理员的人，只能在私聊操作自己的群。`ADMIN_USER_IDS` 仍可操作全部群。`/chats` 返回群 id。额度打开时每一行带上已用次数和上限，每个群只读一次，不计数。读失败的那一行只留群 id。名单超过私聊长度时末尾是 `+` 和省略条数。目录最多 256 个群、每群 32 人。没配 `POLICY_KV` 时重启清空。配了之后按租户一个键留在同一份 KV 里，本 isolate 缓存 60 秒。见 ADR 0027、ADR 0036 和 ADR 0045。

## 隐私

请求处理期间，`Event.message.text` 可以留在内存里，检测器需要它。存储端口的 `AuditRecord` 没有原文栏位，只有 `textSha256`、原因和截断后的证据摘要。写入前会拒绝与原文完全相同的字符串，以及名为 `text` / `body` / `caption` / `raw` / `messageText` / `content` 的字段。

日志字段同样会丢掉这些键。检测器异常的 `message` 不会进入日志，避免把用户原文从错误对象里漏出去。`aggregateMetrics` 只从这些日志汇总拦截率、动作、检测器错误和存储失败。分组标签只接受租户 id 和群 id。见 ADR 0017。插件能否加载由 `admitPlugin` 决定。core 只比较调用方算好的摘要和签名是否有效，不读部署模式。见 ADR 0018。

## Telegram 接入

`POST /telegram/webhook` 由 `packages/platform-telegram` 处理。

1. 读取 `X-Telegram-Bot-Api-Secret-Token`。`WEBHOOK_SECRET` 未配置、请求头缺失或不相等时返回 401，不调用 `onEvent`。比较时对两侧做 SHA-256，再按固定长度逐字节异或。密钥最长 256 字符，和 Telegram 的 `secret_token` 限制一致。
2. 正文超过 64 KiB 返回 413。JSON 无法解析，或缺少 `update_id`，返回 400。
3. `message` 收成 `kind: "message"`。`chat_member` 收成 `kind: "chat_member"`，不带 `message`。主体是 `new_chat_member.user`；`from` 只表示谁执行了操作。`new_chat_member.status` 为 `administrator` 或 `creator` 时 `actor.isAdmin` 为 true。从群外进入（旧状态缺失、`left` 或 `kicked`，新状态是 `member` 或 `restricted`，且不是 bot）时带 `membership: "join"`。人从 `member`、`restricted`、`administrator` 或 `creator` 变成 `left` 或 `kicked` 时带 `membership: "leave"`。人从 `member` 或 `restricted` 变成 `administrator` 或 `creator` 时带 `membership: "promote"`。人从 `restricted` 变成 `member` 时带 `membership: "unrestrict"`。状态仍是 `restricted` 且 `is_member` 为 false 时也带 `membership: "leave"`。这种状态再回到群里时带 `membership: "join"`。昵称只在入群时进入 `profile`。成员标签在入群时并进昵称，已经在群里改成新标签时单独进入 `profile`。见 ADR 0345、ADR 0351、ADR 0352、ADR 0355、ADR 0358 和 ADR 0359。`callback_query` 的 `data` 为 `c:` 加 16 位十六进制时收成 `kind: "challenge"`，只带 nonce 和这颗按钮的 message id，不带消息正文。其它回调仍忽略。`edited_message` 收成同一条 `kind: "message"`，并带 `edited: true`。正文仍只留在当次请求的内存里。群和超级群的 `my_chat_member` 收成 `kind: "bot_membership"`，只带 `admin` 或 `gone`，不带群名。私聊和频道忽略。见 ADR 0027。`chat_join_request` 收成 `kind: "join_request"`。简介放进 `profile`，最长 256 字符。安全的 `query_id` 记成 `joinQueryId`。命中时答复 `decline`，未命中时答复 `queue`。邀请链接、姓名和私聊 id 不进事件。见 ADR 0116 和 ADR 0360。其它更新返回 200，正文是 `{ "ok": true, "ignored": true }`，避免 Telegram 重试。设置 webhook 时把 `message`、`edited_message`、`chat_member`、`chat_join_request`、`callback_query`、`my_chat_member` 都放进 `allowed_updates`。见 ADR 0022。配了 bot token 时，回调会再应答一次，清掉按钮上的转圈。
4. 没有 `text` 时仍保留 `message.id`，正文记成空字符串并哈希。有 `caption` 且没有文本时用 caption。两者都没有时，用投票题干、抽奖奖品说明、清单标题、游戏标题、账单标题、场馆标题、动图或视频或文件的文件名、音频标题、表演者、内联按钮文字，或一条手动引用，见 ADR 0056、ADR 0057、ADR 0058、ADR 0059、ADR 0061、ADR 0062、ADR 0063 和 ADR 0092。作者签名和其余字段见 [message-surface.md](message-surface.md)。贴纸包名、文件 id、回复键盘、自动引用和被回复的原消息不进事件。纯位置消息没有名称，正文仍是空字符串。
5. 管理员不调用 `getChatMember`。`sender_chat.id` 与 `chat.id` 相同（匿名管理员），或 `from.id` 出现在 Worker 的 `ADMIN_USER_IDS`（逗号分隔）时，`actor.isAdmin` 为 true。
6. Worker 在跑流水线之前按租户和群计数。同一群 10 秒内超过 30 条更新时返回 200，正文是 `{ "ok": true, "limited": true }`，不调用 `onEvent`。其他群继续检测。计数失败时放过。同一条事件 id 在该群最近 32 次计数里只计一次。见 ADR 0024 和 ADR 0339。

`apps/worker` 在归一化之后跑 core 流水线：关键词、入群、洪泛、重复和链接检测器，以及 delete、mute、ban、captcha。付费帖不删除。见 ADR 0356。洪泛和重复的窗口默认在 isolate 内存里，满了就跳过该条检测。配了 `RATE_WINDOW` 之后按群放进 Durable Object，调用失败则跳过。提交的配置不绑定它。同一条事件 id 在这个 key 最近 32 次计数里只计一次。见 ADR 0010、ADR 0050、ADR 0052 和 ADR 0338。贴纸、图片、视频笔记和语音没有可当正文的名称时，用文件摘要参加重复判断。文件 id 和贴纸包名不进事件。动图、视频、音频和普通文件没有更前面的正文时，文件名或音频标题成为正文，重复改按这段正文计次。有其它正文时仍按正文摘要。见 ADR 0052 和 ADR 0062。其余字段见 [message-surface.md](message-surface.md)。链接检测默认不发网络请求；可选信誉源失败时返回未命中。抽主机名之前先做和关键词相同的折叠，再去掉两层百分号编码的格式字符，并把 `%2E`、`%2F` 和 `%2B` 收成分隔符，再把一层字母、数字、连字符和下划线的 `%HH` 和 `%25HH` 收成字符。普通空格、`%20`、`%252E`、`%252F`、`%252B` 和第三层 `%252545` 保留。见 ADR 0011、ADR 0065、ADR 0067、ADR 0068、ADR 0069、ADR 0070、ADR 0071、ADR 0072 和 ADR 0073。点状间隔号在抽主机名前收成 ASCII 点，关键词和正则比较前直接去掉。一层百分号编码的间隔号先收成对应字符。第二层和句号 `。` 的编码保留。句号、普通空格和全角加号保留。见 ADR 0093、ADR 0098 和 ADR 0099。全角拉丁字母收成半角。全角数字保留。见 ADR 0094。七个西里尔字母和乌克兰语 `і` 收成拉丁字母。西里尔 `т` 不映成 `t`。抽主机名时再去掉剩下的西里尔、希腊、亚美尼亚文和非 ASCII 拉丁字母。汉字仍可紧贴短链。见 ADR 0095、ADR 0096、ADR 0097 和 ADR 0100。括号里的点、按钮和每一种旁路文本见同一份清单。跨群黑名单默认关闭，只保存 actor id 或 sha256。没配 `POLICY_KV` 时留在 isolate 内存。配了之后每个租户一个键，只在开关或条目变化时写，本 isolate 缓存 60 秒。发出关闭的 isolate 下一条消息不再读这份名单。私聊 `remove` 删一条标识，回复不回显它。状态行带上这个租户的条目数。见 ADR 0012、ADR 0047、ADR 0048 和 ADR 0049。`llm` 检测器默认不跑。规则 `llm_hint` 是关闭的，提交的配置也不绑定 Workers AI。打开之后，额度错误或超时记 `llm_failed` 并放过。见 ADR 0015。`regex` 检测器同样默认不跑。规则 `regex_hint` 是关闭的。模式在创建时拒绝嵌套量词，命中只记 `regex:hit`。见 ADR 0023。关键词和正则在比较前去掉零宽字符、双向控制符、非常规空白、换行和变体选择符。普通空格保留，正文和哈希不变。见 ADR 0054、ADR 0060 和 ADR 0064。频道转发默认删除。事件只保留 `user`、`chat`、`channel`、`hidden` 这四类，不保留频道标题。用户转发、群转发和隐藏来源默认保留。见 ADR 0025。从群外加入时，昵称、姓氏和用户名会交给关键词检测。命中后封禁，不再发验证按钮。审计只存哈希。见 ADR 0028。同一份可见名字里的短链或邀请也会封禁。进群用的邀请链接不读。见 ADR 0117。从群外加入的其它 bot 带 `actor.bot`，默认封禁，不带用户名。限制着但不在群里再回来同样封禁。见 ADR 0031 和 ADR 0357。共享名片只留 `message.contact`，电话和姓名丢掉，默认删除。见 ADR 0032。`via_bot` 只留 `message.via`。规则 `via_inline` 默认关闭，打开后删除，不留 bot 用户名。见 ADR 0033。预过滤按租户和群从 `PolicyStore` 读取；没有记录时豁免管理员，所以管理员入群不会被要求验证。配了 `POLICY_KV` 时白名单走 KV，否则用内存。配了 `DB` 时审计和规则文档走 D1，否则审计留在内存，最多 200 条。规则热路径仍然是缓存加包内 JSON，不读 `Storage.getRuleSet`。配了 `TELEGRAM_BOT_TOKEN` 时，delete 调用 `deleteMessage`，mute 调用 `restrictChatMember`，ban 调用 `banChatMember` 且不撤回历史消息。各一次子请求。没有 token 时这三步只记在内存里。接口失败记 `action_failed`，决策保留，日志不写 token 和原文。见 ADR 0020。captcha 在有 `TELEGRAM_BOT_TOKEN` 时调用 `restrictChatMember` 和 `sendMessage`。没有 token 时限制会失败并回滚挑战，成员不会被卡住。没配 `DB` 时验证状态只在当前 isolate 的内存里。配了 `DB` 之后挑战写进 D1，另一个 isolate 也能对上按钮。同一份 nonce 只有第一次取走时解除限制并写入 `captcha_passed`。表只有主键。坏行不回写。每 15 分钟的 Cron 清理已经到期的挑战，一次最多 64 条，只取走仍然是这份 nonce 的行。这些审计不含原文，写入和删除各打成一批，不会解除限制。同一条入群再投递时，挑战还在就再发一次按钮；这次发送失败不解除限制。记下按钮的 message id 后，通过、到期、再发一颗或再次入群换掉挑战时删掉旧提示。成员离群或被移出时删掉还在的按钮和挑战；被限制时不删。入群改成封禁、禁言或删除时，也删掉上一颗。记不上 id 就删掉刚发出的按钮。点到另一颗也删。别人点了不删。别人的活按钮也不删。被升为管理员时删掉还在的按钮，不解除限制。提前解除且还没到期时也删。通过时把每一项权限都打开。限制时把反应和标签也关上。不足 30 秒或超过 366 天时先收到这个区间。状态仍是 `restricted`、`is_member` 为 false 时也删。回到群里重新验证。见 ADR 0009、ADR 0051、ADR 0328、ADR 0340、ADR 0341、ADR 0342、ADR 0343、ADR 0344、ADR 0345、ADR 0346、ADR 0347、ADR 0348、ADR 0349、ADR 0350、ADR 0351、ADR 0352、ADR 0353、ADR 0354 和 ADR 0355。Telegram 的 `until_date` 自己到期。存储失败不改变决策。管理员可以在私聊导出或删除某个租户、某个群的审计。删除直接返回条数，不先读出这些行。导出在最短文档也放不进私聊时，用一次列表取出最近一页；一条也放不下时只计数。两者都不碰规则和白名单。30 天自动清理还没有做。说明见 ADR 0007、ADR 0008、ADR 0009、ADR 0326、ADR 0327 和 ADR 0331。私聊 `/logs` 列出最近 10 条，时间从早到晚。还有更早的记录时，回复指向 `/export`。见 ADR 0329。

流水线抛错时 Worker 仍返回 200。日志代码是 `webhook_screen_failed`，只带 `eventId` 和 `chatId`。`JSON.parse` 和 zod 的异常文本可能含原文，所以这些失败只记固定代码。

`textSha256` 在这个包里用 Web Crypto 计算。`packages/sdk` 的 `sha256Hex` 依赖 `node:crypto`，Worker 不要 import 它。

## 部署形态放在哪

`apps/worker` 读取 `DEPLOYMENT_MODE`，只影响 `/health` 这样的进程元数据。把 bot 行为按模式拆开，需要新的 ADR。
