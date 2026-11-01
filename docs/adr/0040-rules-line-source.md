# ADR 0040：`/rules` 每一行标明 file 或 switch

- 状态：已接受
- 日期：2026-11-01

## 背景

ADR 0034 的单条 `/rule` 回复已经区分 `file` 和 `switch`。`/rules` 只写 enabled 或 disabled。管理员要知道哪一条被改过，只能再对每个 id 发一次 `/rule`。

## 决策

- 每一行是 `{id} {state} {source} threshold {threshold} actions {actions}`。`source` 用现有的 `file` 和 `switch`。中英文这两个词相同。
- 订阅存储里有这条 rule id 的覆盖时标 `switch`，即使覆盖后的启用状态和底稿一样。没有这条覆盖时标 `file`。这和单条 `/rule` 的判断相同。
- 覆盖的 id 不在当前规则里时，不另起一行。`/rule` 仍按文件规则校验 id。
- 规则包里的底稿也标 `file`。`switch` 只表示这一群的运行时覆盖。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 只在启用状态变了时标 `switch` | 和单条 `/rule` 不一致。覆盖还在，清除之后才会回到底稿。 |
| 为规则包另造一个来源词 | 包是这一群当前的底稿。覆盖仍然是 `switch`。 |

## 后果

- 一次 `/rules` 能看出哪些行是覆盖。
- 清除覆盖后，这一行回到 `file`。
- 未出现在当前规则里的覆盖仍然不显示。
