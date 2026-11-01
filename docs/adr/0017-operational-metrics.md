# ADR 0017：运营指标从日志汇总

- 状态：已接受
- 日期：2026-11-01

## 背景

P2-04 要求拦截率、动作计数、检测器错误和存储失败能从日志汇总。指标标签不能含消息原文或用户昵称。免费计划的 D1 行写很少，不能为了计数给每条消息再写一行。

## 决策

- core 提供纯函数 `aggregateMetrics`。输入是已经写好的 `LogEntry`。它不读存储，也不认识部署模式。
- 一次 `pipeline_exempt` 或非 dry-run 的 `pipeline_completed` 记一次 screened。`captcha`、`delete`、`mute`、`ban` 记为拦截。`allow`、`log`、`report` 留在动作计数里，不记拦截。dry-run 只记 `dryRun`，不进入 screened，也不进入拦截率。
- 拦截率是 `intercepted / screened`。screened 为 0 时比率是 0。
- 检测器错误认这些消息：`detector_error`、`llm_failed`、`blocklist_failed`、`reputation_failed`、`rate_window_failed`。`rate_window_skipped` 是窗口放不下，不是检测器抛错。
- 存储失败认 `audit_failed` 且 `code` 为 `storage_failed`，以及 `policy_store_failed`。`raw_content_rejected` 是隐私拒绝，不记成存储失败。
- 分组标签只接受 `tenantId` 和 `chatId`，并且必须匹配 `^[A-Za-z0-9_.:-]{1,64}$`。句子、空格、昵称和原文键都不会出现在结果里。缺任一 id 的行仍计入 totals。
- `detector_error`、`audit_failed`，以及各检测器的失败日志，带上 `tenantId` 和 `chatId`，方便按群汇总。不写昵称，不写原文。
- 不新增计数表，也不把指标写进 KV。汇总发生在已经产出的日志上。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 每条消息给 D1 加一行计数 | 免费计划的行写会先被审计打满。计数失败不该再拖热路径。 |
| isolate 内存计数器当唯一来源 | 重启就丢，也无法把多次部署的日志合在一起。日志才是可回放的来源。 |
| 私聊 `/stats` 读当前 isolate 的内存日志 | 那只是这一分钟的样本，会让管理员以为那是全量。 |

## 后果

- 公共导出增加 `aggregateMetrics`、`MetricCounts`、`ChatMetrics`、`MetricReport`。
- 检测器失败日志多了 `tenantId`。已有字段不变。
- 误判率和额度消耗不在这一份报告里。误判要等审核标签，额度要等 P2-03 的数字。
