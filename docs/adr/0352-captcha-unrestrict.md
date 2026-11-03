# ADR 0352：提前解除限制时删掉验证按钮

- 状态：已接受
- 日期：2026-11-04

## 背景

验证还没通过时，管理员可以先把成员从 `restricted` 改回 `member`。按钮和挑战还在。成员已经能发言，按钮再点一次仍会记 `captcha_passed`。`until_date` 到点时 Telegram 也会把状态改回 `member`。那一次应该留给到期清理写 `captcha_expired`。

## 决策

- `membership` 增加 `unrestrict`。人从 `restricted` 变成 `member` 时带上它。不带昵称。bot 不带。
- 从群外变成 `member` 仍是 `join`。`member` 变成 `restricted` 不带 `unrestrict`。
- 挑战还没到期时，`unrestrictChallenge` 删掉按钮和挑战。不解除限制，不写 `captcha_expired`。日志是 `captcha_unrestricted`，只有事件 id 和群 id。
- 挑战已经到期，或这一行已经不在时，什么都不做。到期清理仍按 ADR 0341。
- 删不掉或没有删除端口时留下这一行。删除这一行失败时记 `captcha_unrestrict_failed`，流水线继续。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 每次变回 `member` 都删掉挑战 | `until_date` 到点也会变回 `member`。到期审计就丢了。 |
| 提前解除时再调用解除限制 | 成员已经是 `member`。按钮清掉就够了。 |

## 后果

- 管理员提前解除限制后，还没到期的验证按钮会清掉。
- 到期那一次仍由到期清理写 `captcha_expired` 并删按钮。
- 30 天保留期不动。
