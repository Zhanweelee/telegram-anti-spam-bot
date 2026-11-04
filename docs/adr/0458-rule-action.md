# ADR 0458：私聊可以把一条规则换成一个动作

- 状态：已接受
- 日期：2026-11-04

## 背景

ADR 0034 让 `/rule` 只改启用状态。ADR 0454 把 `warn` 加进动作名单，但要生效仍得改 `default.json` 或 `chats.json`。云上的群管没有这些文件。

## 决策

- `RuntimeStore` 增加 `listRuleActions`、`setRuleAction`、`clearRuleAction`。一条记录是 `{ ruleId, action }`。`action` 只能是 `log`、`report`、`captcha`、`decline`、`delete`、`warn`、`mute`、`ban`。
- 覆盖整份替换这条规则的 `actions`。文件里原来的 `delete` 加 `report`，换成 `warn` 之后只剩 `warn`。`file` 删掉覆盖，下一次读回文件里的动作。
- 记录和开关分开。内存各有一张表，各最多 256 个群、每个群 32 条。已有 id 可以改。新群或新 id 放不下时返回 false，命令回复「参数无效」，日志代码是 `rule_action_full`。
- 配了 `POLICY_KV` 时，动作写在 `runtime-action` 键。原来的运行时文档仍只有 `dryRun` 和 `switches`。坏掉的动作文档读成空列表，不把开关清掉。每个 isolate 缓存 60 秒。相同的值不写。
- `applyRuleActions` 在 `loadRuleSet` 和 `resolveRuleSet` 里套在开关之后、缓存之外。未知 id 忽略。覆盖和底稿一样时返回原对象。
- 私聊 `/rule` 仍最多 3 个参数。`on`、`off`、`reset` 只动启用状态。动作名写入覆盖。`file` 清除动作覆盖。不认识的词回复用法。`allow` 不是处置，也回复用法。
- 单条回复在原来的状态后面写上 `actions`。`/rules` 每一行本来就有动作，现在用套过覆盖的那一份。来源 `file` 或 `switch` 仍只表示启用状态有没有被改过。
- 规则 id 必须已经出现在该群的文件规则里。群聊里的同样文本不执行。接入目录里的人只能改自己的群。读或写失败回复「参数无效」，日志是 `operator_rejected`。不写姓名、消息原文或 token。
- 检测读取失败时记 `runtime_failed`，按文件里的动作继续。开关读取失败不会丢掉已经读到的动作，反过来也一样。
- `default.json` 仍是 `delete`。不改 `WARN_LIMIT`，不改相册删除，不改 30 天保留期。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 把动作写进现有运行时文档 | 旧 Worker 看到多出来的字段会把整份文档当成空的，开关和 dry-run 一起丢。 |
| 一次命令改成多个动作 | 三个参数已经用完。云上先能换成一个处置，文件里的组合仍是底稿。 |
| 把默认关键词改成 `warn` | 现在只删消息的人会被第三次命中封禁。默认行为要另一次决定。 |
| 新开一条命令 | 菜单已经 91 条。`/rule` 本来就是改这一条规则的地方。 |

## 后果

- 私聊 `/rule -100 spam_keywords warn` 之后，这个群的关键词命中走警告。别的群仍按文件删除。
- `file` 回到文件动作。`reset` 仍只清启用开关。
- 云额度的基础检测器名单没有改。30 天保留期没有改。
