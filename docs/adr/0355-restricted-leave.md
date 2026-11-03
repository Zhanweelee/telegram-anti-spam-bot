# ADR 0355：被限制的成员离开时状态可以仍是 restricted

- 状态：已接受
- 日期：2026-11-04

## 背景

`ChatMemberRestricted` 用 `is_member` 表示这个人此刻还在不在群里。验证把成员收成 `restricted` 之后，离群可以不把状态改成 `left`，只把 `is_member` 设为 false。限制记录还在。现有离群只认 `left` 和 `kicked`，所以按钮留着。人再回来时也不是 `join`。等到 `until_date`，这条更新会被当成提前解除，挑战被删掉，人没有点过按钮。

## 决策

- 人还在群里，新状态仍是 `restricted` 且 `is_member` 为 false 时，带 `membership: "leave"`。不解除限制，不写 `captcha_expired`。
- 旧状态是这种「限制着但不在群里」，新状态回到 `member` 或仍在群里的 `restricted` 时，带 `membership: "join"`。不带 `unrestrict`，也不带 `promote`。
- `is_member` 缺失时仍按原来的状态判断。`member` 变成还在群里的 `restricted` 不是离群。
- bot 不带。昵称只在入群时进入 `profile`。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 只认 `left` 和 `kicked` | 被限制的人离群时按钮留着。到期那次更新会把没点过的验证清掉。 |
| 任何 `restricted` 都当成离群 | 验证自己发出的 `member` 到 `restricted` 会删掉刚写的挑战。 |

## 后果

- 被限制的人离群后，验证按钮和挑战会清掉。原来的 `until_date` 还在。
- 再回到群里会重新验证。
- 从群外直接成为管理员仍不带 `promote`。
- 30 天保留期不动。
