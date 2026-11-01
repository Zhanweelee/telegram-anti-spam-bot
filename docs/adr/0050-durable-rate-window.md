# ADR 0050：洪泛计数可以选一个 Durable Object

- 状态：已接受
- 日期：2026-11-01

## 背景

ADR 0010 把洪泛和重复放在 isolate 内存里。Cloudflare 会同时跑多个 isolate，同一群的 5 条消息可能被拆开，窗口各自少计，检测漏掉。`docs/limits.md` 允许以后用 Durable Object，并且要求对象不可用时跳过该检测器。默认路径不能假设每天 100,000 次 DO 请求无限。

## 决策

- 提交的 `wrangler.jsonc` 不绑定 Durable Object。没配 `RATE_WINDOW` 时仍用 isolate 内存，包括 webhook 预算。
- 配了 `RATE_WINDOW` 之后，`RateWindowObject` 按检测器种类、租户和群各一个对象。对象里仍是现有的内存窗口，不写 SQLite 行。对象被换掉时少计，方向是漏报。
- 同一次检测里，洪泛和重复各打一次这个对象。调用抛错时换成 `rate_window_unavailable`，不把远端异常文本交出去。检测器记 `rate_window_failed` 并返回未命中。窗口满了仍返回 null，检测器记 `rate_window_skipped`。
- 不改 ADR 0026 的默认额度，也不把额度计数放进这个对象。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 默认就绑定 Durable Object | 每条群消息都是额外的 DO 请求。免费计划每天大约 100,000 次。 |
| 把计数写进 KV 或 D1 | ADR 0010 已经拒绝。写预算和最终一致都不适合这条热路径。 |
| 对象里用 SQLite 保住重启后的计数 | 每条消息一次行写，和审计抢每天 100,000 次行写。少计比误罚安全。 |

## 后果

- 自部署的默认配置不增加绑定，也不增加 DO 请求。
- 打开 `RATE_WINDOW` 之后，同一个群的洪泛计数能跨 isolate 累加。重复计数也是。
- 对象调用失败时这条检测放过。其它检测继续。
- 测试用一个本地替身代替 `cloudflare:workers`，不新增依赖。
- 只有 `apps/worker` 可以 import `cloudflare:workers`。core 和适配器仍然禁止。
