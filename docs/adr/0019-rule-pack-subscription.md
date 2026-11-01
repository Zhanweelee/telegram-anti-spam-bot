# ADR 0019：规则包订阅默认关闭，刷新失败保留上一份

- 状态：已接受
- 日期：2026-11-01

## 背景

P3-03 要让一个群自愿改用一份社区规则。验收是：订阅默认关闭；更新失败时保留上一份通过 schema 的 `RuleSet`，不能把空规则写到这份订阅上。

`docs/limits.md` 里 KV 每天只有 1,000 次写。热路径上的规则已经有 60 秒缓存，键是 `rules:<tenant>:<chat>`。白名单也用同一层缓存。如果把「订了哪一份」放进这层缓存，`/packs … off` 之后最多还要再读一分钟社区规则。跨群黑名单已经为了「关掉立刻生效」避开了这层缓存。

远程拉取还会在每条消息上多一次 HTTP，占用免费计划 10 ms 的 CPU，并且把第三方响应当成可信输入。

## 决策

- 新增三个端口：`RuleSubscriptionStore`（这个群订了哪一份，`null` 表示没订）、`RulePackSource`（按 pack id 取未校验文档）、`RulePackArchive`（上一份通过 schema 的 `RuleSet`）。
- `resolveRuleSet` 在没有 `pack` 时行为与 `loadRuleSet` 相同。未订阅的群不调用 `RulePackSource`。
- 订阅后的缓存键是 `pack:<tenant>:<chat>:<packId>`，和本地规则的 `rules:` 分开。命中且能通过 schema 就直接返回。坏缓存记 `rules_invalid`，范围 `pack_cache`，然后重新读取来源，不把空规则写进这个键。
- 来源抛错或文档通不过 schema 时记 `pack_update_failed`，字段只有 `tenantId`、`chatId`、`packId`。归档里有上一份就继续用它。没有上一份才回到 `loadRuleSet`。不把空规则写进归档。
- 归档写入失败记 `pack_archive_failed`，这一次仍返回刚解析好的规则。归档读取失败当成没有上一份。
- Worker 每次消息都读订阅存储。读失败记 `pack_store_failed`，并把这个群当成未订阅。`/packs … off` 下一条消息就不再读规则包。
- 默认来源是包内 `apps/worker/rules/packs.json`，提交的内容是 `{}`。未知 id 抛 `pack_missing`。这条字符串不进日志。热路径不发 HTTP。
- 订阅和归档都在 isolate 内存里。每个租户最多 128 个群，归档最多 128 份。满了抛 `pack_full`。命令捕获后回复「参数无效」。
- 私聊命令 `/packs <chatId> [packId|off]` 只给配置中的管理员。`off` 是取消订阅的词，先于 pack id 判断。非法 id 回复「参数无效」，不回显参数。不调用 `putRuleSet`。群聊里的同一段文字仍走检测流水线。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 每条消息向社区 URL 拉 YAML | 免费计划的 CPU 和出站请求不够，第三方响应也不能在失败时覆盖上一份合法规则。 |
| 把订阅写进 `PolicyStore` 的 60 秒缓存 | 关掉之后还会继续用社区规则。和黑名单 opt-in 的教训一样。 |
| 用 KV 或 D1 保存订阅和上一份规则 | 热路径不该为规则包付写入。持久化留到以后，仍然不能把消息原文写进去。 |
| 刷新失败时改用空规则集 | 空规则会把已经生效的社区规则静默放行。验收要求保留上一份通过 schema 的 `RuleSet`。 |

## 后果

- isolate 重启会丢掉订阅和上一份规则。之后回到本地 `default.json` / `chats.json`，直到管理员再次订阅。
- `off` 不能当作 pack id 使用。
- 第一次拉取就失败、归档里又没有上一份时，这个群用本地规则。这不是把空规则写进订阅。
- 不新增 npm 依赖，也不占用 KV、D1 或第二个 Cron。`wrangler.jsonc` 不增加绑定。
