# Cloudflare 免费额度与设计约束

查证日期：2026-11-04。数字来自当天检索到的官方文档，不是记忆。额度会变。每周健康检查要人工对照下面的链接，再改这份文件。

免费额度按账号、在 **00:00 UTC（北京时间 08:00）** 重置的，按日计；文档写明按月的，另注。

## Workers

来源：[Workers limits](https://developers.cloudflare.com/workers/platform/limits/)、[2026-02-11 subrequest changelog](https://developers.cloudflare.com/changelog/post/2026-02-11-subrequests-limit/)。

| 项目 | Workers Free |
| --- | --- |
| 请求 | 100,000 / 天。超出后 Error 1027。安全相关路由应设 fail closed |
| CPU | HTTP 与 Cron 都是 **10 ms / 次**。等待 fetch、KV、D1 不算 CPU |
| 内存 | 128 MB |
| 子请求 | 表内写 50 / 请求。2026-02-11 changelog：免费计划仍是 50 次外部子请求，另加 1,000 次发往 Cloudflare 服务的子请求 |
| 同时对外连接 | 6 / 请求 |
| Worker 数量 | 100 |
| Cron Triggers | **5 / 账号** |
| 脚本启动 | 1 秒 |
| HTTP 墙钟 | 无硬限制；`waitUntil` 在响应后最多约 30 秒 |
| Cron 墙钟 | 15 分钟，但免费计划 CPU 仍是 10 ms |

设计约束：

- 热路径上的检测必须是短字符串上的关键词 / 正则。不要在请求里做重 CPU 循环。10 ms 是硬边界。内置正则在创建时拒绝嵌套量词，因为同步 `RegExp` 不会被检测器超时打断。见 ADR 0023。
- 「并行检测」在 Workers 里仍是单线程。`Promise.all` 只重叠 I/O，不重叠 CPU。
- 外部子请求要省着用。一次处罚通常是 1 次 Telegram API 调用。不要对每条消息扇出。链接信誉默认只做本地判断，见 ADR 0011。
- 整个账号只用 1 个 Cron。清理任务必须小步、可重入，不能指望 10 ms 里扫完整库。
- 同一群 10 秒内只处理前 30 条更新，其余返回 200，避免 Telegram 重试放大 100,000 次/天的请求额度。同一条更新在最近 32 次计数里只计一次。计数在 isolate 内存里，不写 KV 或 D1。见 ADR 0024 和 ADR 0339。这不是每群云额度。

## D1

来源：[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)（页面标注更新于 2026-10-30）、[2026-09-01 免费额度强制执行](https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/)、[D1 limits](https://developers.cloudflare.com/d1/platform/limits/)（页面标注更新于 2026-10-30）。

| 项目 | Workers Free |
| --- | --- |
| 行读 | 5,000,000 / 天 |
| 行写 | 100,000 / 天 |
| 存储 | 账号合计 5 GB。单个数据库 500 MB |
| 数据库个数 | 10 |
| 单条 SQL | 最大语句长度 100 KB。`db.batch()` 里每条语句仍受这个限制 |
| 每次 invocation | 50 次查询。`db.batch()` 整批只算一次 |
| 查询结果 | 50 MB。limits 页写明 2026-11-04 起超限失败 |

从 2026-09-01 起，超出当日行读或行写后，查询直接失败，数据还在，要等到次日 UTC 零点。索引列会额外算一行写入。

设计约束：

- 每条消息最多写一行审计，并且 allow / dry-run 不写。
- 配了 `DB` 时，入群验证每个挑战一行，通过、超时或回滚再删一行。不建二级索引。没配 `DB` 时挑战仍在 isolate 内存。见 ADR 0051。
- 少建索引。行写预算比行读紧两个数量级。
- 免费计划每次 invocation 最多 50 次查询。`db.batch()` 整批只算一次，单条语句仍受 100 KB 限制。2026-11-04 再次核对了这条：一批里可以有很多条语句，仍只算 1 次查询。Cron 清理 64 条到期挑战时，审计写入和删除各用一批。见 ADR 0328。
- 单个数据库先写满 500 MB，到不了账号合计的 5 GB。导出按 100 行一页读。删除一个租户或一个群每次最多 1000 行，一次命令最多 32 页。删不完时回复还剩多少条。这两步不在消息热路径上。见 ADR 0361。
- D1 失败必须 fail-open：处罚决策可以已经做出，但存储失败不能把 Worker 打成 500 给 Telegram 造成重试风暴。

## Workers KV

来源：[KV pricing](https://developers.cloudflare.com/kv/platform/pricing/)（2026-10-30）、[KV limits](https://developers.cloudflare.com/kv/platform/limits/)。

| 项目 | Workers Free |
| --- | --- |
| 读 | 100,000 / 天 |
| 写 | 1,000 / 天 |
| 删除 | 1,000 / 天 |
| list | 1,000 / 天 |
| 存储 | 1 GB |
| 同一 key 写入 | 1 次 / 秒 |
| 值大小 | 25 MiB |
| 每次 invocation 操作数 | 1,000 |
| 最小 cacheTtl | 30 秒 |

KV 是最终一致的。

设计约束：

- KV 只放读多写少的数据：规则、白名单、热配置。不要用 KV 记审计。`/rule` 和 dry-run 在配了 `POLICY_KV` 时每个群一个键，写入只发生在命令真的改了值的时候。读进 isolate 缓存 60 秒，一条消息不会打两次 KV。见 ADR 0035。动作覆盖另用 `runtime-action` 键，每个群最多 32 条，和开关不共用名额。见 ADR 0458。上报目的地另用 `runtime-report` 键，一个群一个值，相同的值不写。见 ADR 0459。洪泛窗口另用 `runtime-flood` 键，一个群一份条数和秒数，相同的值不写，写成默认会清掉。见 ADR 0460。额外关键词另用 `runtime-keyword` 键，一个群最多 32 个词，相同的词不写。见 ADR 0461。重复窗口另用 `runtime-repeat` 键，一个群一份条数和秒数，相同的值不写，写成默认会清掉。见 ADR 0462。接入目录也是每个租户一个键，只在成员变更时写。见 ADR 0036。规则包订阅也是每个群一个键，只在 `/packs` 真的改了值时写，读进 isolate 缓存 60 秒。见 ADR 0037。上一份通过 schema 的规则另用 `pack-rules` 键，只在 JSON 变化时写，超过 16384 个字符不写。见 ADR 0046。跨群黑名单也是每个租户一个键，只在开关或条目变化时写。删掉一条不存在的标识不写。查看条数也不写。见 ADR 0047、ADR 0048 和 ADR 0049。
- 规则热更新合并进少量 key，避免每个群一次写入就把 1,000 次日预算打光。
- 读可以带 `cacheTtl`，接受最多几十秒的旧规则。需要强一致的计数不要放 KV。

## Queues

来源：[Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/)（2026-10-30）、[Queues limits](https://developers.cloudflare.com/queues/platform/limits/)、[2026-02-04 免费计划](https://developers.cloudflare.com/changelog/post/2026-02-04-queues-free-plan/)。

| 项目 | Workers Free |
| --- | --- |
| 操作 | 10,000 / 天。一次操作 = 写入、读取或删除的每个 64 KB |
| 投递一条小消息 | 通常 3 次操作：写 + 读 + 删。约 3,000 条/天 |
| 队列个数 | 10,000 |
| 保留 | 24 小时，不可配置 |
| 消息大小 | 128 KB |
| 单次 sendBatch | 最多 100 条，或合计 256 KB |
| 消费端墙钟 | 15 分钟；CPU 仍受 Workers 计划约束（免费是 10 ms） |

设计约束：

- 不要把每条群消息都放进队列。队列只给低频异步：批量刷审计、可降级的 LLM、opt-in 的跨群名单。
- 消息小于 64 KB，避免一条消息算多次操作。
- 免费计划保留只有 24 小时。队列不是审计库。

## Durable Objects

来源：[Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)（2026-10-18）、[Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/)。

| 项目 | Workers Free |
| --- | --- |
| 可用后端 | 只有 SQLite |
| 请求 | 100,000 / 天（HTTP、RPC session、WebSocket 消息、alarm） |
| 时长 | 13,000 GB-s / 天 |
| 行读 / 行写 | 与 D1 相同：5,000,000 / 100,000 每天 |
| 存储 | 账号合计 5 GB；单个对象免费计划写满约 1 GB 时 `SQLITE_FULL` |
| 单对象吞吐 | 软限制约 1,000 请求/秒，然后过载 |

免费计划上，每个 RPC 方法调用单独计一次请求。若每条群消息都叫醒一个 DO，Worker 请求和 DO 请求各算一笔。

设计约束：

- 洪泛计数优先考虑可降级的近似方案。DO 适合「必须强一致」的每群状态，但默认路径不能假设 DO 预算无限。
- 空闲且可休眠的对象不计时长。不要在 DO 里空转。
- 写满时读和删除仍然可用。清理逻辑要能在 `SQLITE_FULL` 下删旧数据。

## Workers AI

来源：[Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)（2026-10-20）、[错误码](https://developers.cloudflare.com/workers-ai/platform/errors/)、[2026-07-28 部分模型需要付费计划](https://developers.cloudflare.com/changelog/post/2026-07-28-models-require-workers-paid/)。

| 项目 | 额度 |
| --- | --- |
| 免费 Neurons | 10,000 / 天。用尽返回 HTTP 429，内部码 3036 |
| 超出后 | 免费计划不能继续付费使用，必须升级 Workers Paid |
| 部分模型 | `@cf/moonshotai/kimi-k2.6`、`kimi-k2.7-code`、`@cf/zai-org/glm-5.2`、`glm-5.3`、`glm-5.3-flash`、DeepSeek V4 Flash、V4.1 Flash 和 V4 Pro 在免费计划上直接 403 |

设计约束：

- LLM 是最后一级，默认关闭。规则和关键词先处理。
- 调用要有熔断：额度错误或超时则跳过，流水线 fail-open。
- 2026-11-01 选用仍在免费计划上的 `@cf/huggingface/distilbert-sst-2-int8`。定价页写 2394 neurons / 1,000,000 input tokens。它是情感分类，不是垃圾消息模型。见 ADR 0015。
- 不要把需要付费计划的模型写进默认配置。已知会在免费计划上 403 的包括 `@cf/moonshotai/kimi-k2.6`、`kimi-k2.7-code`、`@cf/zai-org/glm-5.2`、`glm-5.3`、`glm-5.3-flash`、`@cf/deepseek-ai/deepseek-v4-flash-0731`、`deepseek-v4.1-flash-1017` 和 `deepseek-v4-pro-0813`。2026-11-04 核对时，Workers 限额页标注 2026-10-29，D1 标注 2026-10-30，Workers AI 定价页仍标注 2026-10-20。免费请求、CPU、子请求、D1 查询次数和 Neurons 数字没有变。默认模型仍是 `@cf/huggingface/distilbert-sst-2-int8`。

## Cron

来源：[Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/) 指向的 Workers 账号限制。

免费计划全账号 5 个 Cron。本项目只用 1 个：`*/15 * * * *`，清理到期的入群验证并写审计。配了 `DB` 时读 D1，一次最多 64 条。没配时只看见当前 isolate 的内存。以后的保留清理要共用这个触发器，不要再占第二个。不要为指标、评测、名单同步各占一个。

## 这些额度如何影响流水线

1. 规则与白名单：KV 读，写必须合并、限频。
2. 审计：D1 单行、批量、allow 不写。失败只记日志。导出按页读，删除不在热路径上。
3. 队列：只承载可丢弃或可延迟的工作。
4. 强一致计数：默认洪泛和重复用 isolate 内存窗口（ADR 0010）。可选绑定 `RATE_WINDOW` 后按群放进 Durable Object，对象里不写 SQLite 行。调用失败则跳过该检测器。提交的配置不绑定它。同一条事件 id 在该 key 最近 32 次计数里只计一次。KV 不放这种计数。见 ADR 0050 和 ADR 0338。
5. 跨群黑名单：默认关闭。没配 `POLICY_KV` 时名单和开关在 isolate 内存。配了之后每个租户一个键，只在变化时写，读进本 isolate 缓存 60 秒，不按每条消息写。发出关闭的 isolate 下一条消息不再读这份名单。坏文档不回写。见 ADR 0012 和 ADR 0047。
6. LLM：默认规则关闭，也不绑定 `AI`。打开后额度错误或超时则跳过。见 ADR 0015。
