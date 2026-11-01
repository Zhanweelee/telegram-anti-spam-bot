# ADR 0034：私聊只改一条规则

- 状态：已接受
- 日期：2026-11-01

## 背景

`via_inline` 和 `regex_hint` 默认关闭。要打开它们，以前只能改 `default.json`，或在 `chats.json` 里整份换掉规则。私聊的 `/rules` 只读。

文件规则需要继续当底稿。重启之后应当回到文件里的 `enabled`，这轮不把开关写进 KV。

## 决策

- `RuntimeStore` 增加 `listRuleSwitches`、`setRuleSwitch`、`clearRuleSwitch`。一条记录是 `{ ruleId, enabled }`。
- 内存实现最多 256 个群，每个群最多 32 条。已有 id 可以改。新群或新 id 放不下时返回 false，命令回复 `参数无效`，日志代码是 `rule_switch_full`。重启清空。
- `applyRuleSwitches` 在 `loadRuleSet` 和 `resolveRuleSet` 返回前套上覆盖。缓存里仍是文件或规则包的底稿，所以开关立即生效，不等 60 秒。未知 id 忽略。覆盖值和底稿一样时返回原对象。
- 私聊命令是 `/rule [chatId] <ruleId> [on|off|reset]`。`on` 和 `off` 写入覆盖，`reset` 删掉覆盖。回复带 `enabled` 或 `disabled`，以及来源 `switch` 或 `file`。
- 全局管理员必须写群 id。只有一个群的操作者可以省略群 id。多个群又不写群 id 时回复用法。别的群回复 `没有权限`。规则 id 必须符合 schema，并且已经出现在该群的文件规则里。非法文本回复 `参数无效`，不回显原文。
- `/rules` 和检测都读同一份覆盖。检测在覆盖之后才做额度降级。读取抛错时检测记 `runtime_failed` 并按文件规则继续；命令回复 `参数无效`。
- 不改 ADR 0026 的基础检测器名单，也不改 `default.json` 里 `via_inline` 和 `regex_hint` 的默认关闭。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 把 `enabled` 写回 JSON 文件 | Worker 上没有可写的规则文件。整份替换也容易丢掉以后新增的默认规则。 |
| 新开一个端口 | 这和 dry-run 一样，是按群记住的运行时开关。 |
| 覆盖写进 KV | 这轮要的是能打开默认关闭的规则。持久化可以以后再加，不改端口形状。 |
| 命令直接改规则包 | `/rules` 展示的是文件规则。包里没有这个 id 时，覆盖先记着，等退订后再生效。 |

## 后果

- 开关只在当前 isolate 的内存里。重启后每个群回到文件里的 `enabled`。
- `chats.json` 整份替换如果没有这条规则 id，命令会拒绝，不会凭空造出一条规则。
- 订阅了规则包时，命令仍按文件规则校验 id，再按 id 套到 `resolveRuleSet` 的结果上。包里没有这个 id 时，这条覆盖暂时不起作用。
- 云模式超额后，`via`、`regex`、`bot`、`contact` 仍会被降级拿掉。先套开关，再降级。
- 不新增 wrangler 变量，也不新增依赖。
