# ADR 0035：运行时开关放进已有的 KV

- 状态：已接受
- 日期：2026-11-01

## 背景

ADR 0034 把 `/rule` 和 dry-run 放在 isolate 内存里。Worker 一重启，打开的 `via_inline` 或 `regex_hint` 就回到文件里的 `enabled`。白名单已经有可选的 `POLICY_KV`。`docs/limits.md` 写明 KV 每天大约 1,000 次写、100,000 次读，适合读多写少的热配置。

## 决策

- 不新增绑定，也不改 `RuntimeStore`。配了 `POLICY_KV` 时，`createKvRuntimeStore` 和白名单共用这份 KV。键前缀是 `runtime`，和 `policy` 分开。每个群一个 JSON：`dryRun` 加上最多 32 条 `{ ruleId, enabled }`。
- 没配 `POLICY_KV` 时仍用内存。内存最多 256 个群。KV 不按群数封顶，也不调用 `list`。
- 坏掉的文档当成没有 dry-run、没有覆盖。热路径不为了修复去写 KV。
- 每个 isolate 把读到的文档缓存 60 秒。同一次请求里的 dry-run 和规则覆盖共用这一次读取。写入后立刻更新本 isolate 的缓存。其它 isolate 最多晚 60 秒看见。
- 只有 `/dryrun` 和 `/rule` 的实际变化才写 KV。相同的值不写。放不下第 33 条时不写，命令仍回复 `参数无效`。
- 提交的 `wrangler.jsonc` 仍不写 KV id。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 新的 `RUNTIME_KV` | 操作者要多建一个命名空间。这份数据和白名单一样，都是按群记住的配置。 |
| 每次检测都读 KV | 一条消息会变成两次读。免费计划每天 100,000 次读，忙的群会很快用完。 |
| 用 KV 的 `list` 限制 256 个群 | `list` 也算每天 1,000 次，而且是最终一致的。单群一个键就不需要扫描。 |
| 把开关写进 D1 | 检测热路径不该为了开关打 D1。审计已经占着每天的行写。 |

## 后果

- 配了 `POLICY_KV` 之后，重启仍保留 `/rule` 和 dry-run。文件规则仍是底稿。
- 没配时行为和 ADR 0034 一样，重启回到文件。
- 一个群一分钟里，每个看到它的 isolate 大约读一次 KV，而不是每条消息读一次。
- 云额度的基础检测器名单不变。超额后仍会拿掉 `via`、`regex`、`bot`、`contact`。
