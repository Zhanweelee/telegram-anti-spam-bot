# ADR 0357：被限制后离群的 bot 再回来仍要封禁

- 状态：已接受
- 日期：2026-11-04

## 背景

ADR 0031 只把旧状态是 `left`、`kicked` 或缺失的 bot 标成从群外加入。ADR 0355 说明 `restricted` 且 `is_member` 为 false 的人其实已经不在群里。bot 用同一种状态离开后再回来时，`actor.bot` 不会出现，默认的 `bot_join` 也就不会封禁。

## 决策

- 旧状态是 `restricted` 且 `is_member` 为 false 时，和新状态是 `member`、仍在群里的 `restricted` 或 `administrator` 一起，带 `actor.bot: true`。
- 新状态是 `restricted` 且 `is_member` 为 false 时不带。bot 这时还没回到群里。
- `is_member` 缺失时仍按 ADR 0031。已经在群里的升降级不带。不设 `membership`，不写用户名。
- 新状态是管理员时，`isAdmin` 仍只看配置里的 id。不把 `bot` 加进 ADR 0026 的基础检测器。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 任何 `restricted` 都当成群外 | 还在群里的 bot 被解除限制时会被当成新加入并封禁。 |
| 给 bot 写 `membership: join` | 人类用的验证规则会套到 bot 上。ADR 0031 已经分开。 |

## 后果

- 被限制后离群的 bot 再进群，会走原来的 `bot_join` 封禁。
- 限制记录还在、人还没回来时，不封禁。
- 云模式超过当月次数后，这条规则仍会停，直到 `QUOTA_BASIC` 写上 `bot`。
- 30 天保留期不动。
