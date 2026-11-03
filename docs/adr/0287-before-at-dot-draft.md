# ADR 0287：点状字符紧挨在草稿 `@` 前面时仍保留

- 状态：已接受
- 日期：2026-11-03

## 背景

Android 不把 `·`、`•`、`‧`、`∙`、`⋅`、`・`、`．`、`﹒` 和 `｡` 当成点。`http://example.com．@http://bit.ly/…`、`http://example.com·@http://bit.ly/…` 和 `http://203.0.113.155．@http://bit.ly/…` 都会在这个字符前结束，再打开后面的网址。`http://example.com．@https://t.me/+…` 会另外打开邀请。

把这个字符收成 ASCII `.` 之后，`example.com.@http` 会变成一条用户信息，短链不再出现。真正的 `http://example.com.@http://bit.ly/…` 本来就是一条链接。斜杠前面的点状字符仍收成点，带协议时路径留在同一段。单独充当分隔符的 `bit．ly` 仍要收成短链。

看得见的正文已经这样切。隐藏的分享 `text` 把 `http://example.com．@http://bit.ly/…` 收成用户信息，主机名变成 `http`，短链被漏掉。见 ADR 0188。

## 决策

- 分享 `text`、分享 `url`、私聊预填 `tg://msg` 的 `text` 和用户名草稿的 `text`，带协议的主机名在点状字符紧挨 `@` 前面时结束，后面的网址另开。
- 真正的 ASCII `.` 紧挨 `@` 前面时仍是一条用户信息，不另开后面的网址。
- 斜杠前面的点状字符在带协议时仍留在这一段。没有协议时仍打开后面的网址。
- 前面不是 `@` 的点状字符仍收成点。`bit．ly` 和 `http://user@bit．ly/…` 仍是短链。
- 证据只留主机名。路径和邀请码不进证据。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 草稿继续把 `@` 前面的点状字符收成点 | `http://example.com．@http://bit.ly` 会变成用户信息，漏掉 Android 打开的短链。 |
| ASCII `.` 紧挨 `@` 前面时也另开 | `http://example.com.@http://bit.ly` 在 Android 上是一条链接。 |
| 点状字符一律不再收成点 | `bit．ly` 会漏掉。 |

## 后果

- `t.me/share/url?text=http://example.com．@http://bit.ly/…`、间隔号 `·` 和 `http://203.0.113.155．@http://bit.ly/…` 删除。分享 `url` 同样删除。证据仍只有主机名。
- `http://example.com．@https://t.me/+…` 按邀请删除。路径和邀请码不进证据。
- `http://example.com.@http://bit.ly/…` 和 `http://example.com．/http://bit.ly/…` 留着。`bit．ly` 和 `http://user@bit．ly/…` 仍按短链删除。
- 只用点状字符当点、又没有协议的主机名后来仍盖住后面的网址。见 ADR 0288。
