# ADR 0188：点状字符紧挨在 `@` 前面时仍保留

- 状态：已接受
- 日期：2026-11-02

## 背景

Android 不把 `·`、`•`、`‧`、`∙`、`⋅`、`・`、`．`、`﹒` 和 `｡` 当成点。`http://example.com．@http://bit.ly/…`、`http://example.com·@http://bit.ly/…` 和 `http://203.0.113.155．@http://bit.ly/…` 都会在这个字符前结束，再打开后面的网址。`http://example.com．@https://t.me/+…` 会另外打开邀请。

主机名扫描如果把这个字符收成 ASCII `.`，`example.com.@http` 会变成一条用户信息，短链不再出现。真正的 `http://example.com.@http://bit.ly/…` 本来就是一条链接。斜杠前面的点状字符仍收成点，带协议时路径留在同一段。单独充当分隔符的 `bit．ly` 仍要收成短链。

## 决策

- 主机名扫描里，点状字符紧挨在 `@` 前面时保留。
- 紧跟在 ASCII `.` 或 `@` 后面的点状字符仍按 ADR 0186 和 ADR 0187 保留。
- 其他位置的点状字符仍收成 `.`。
- 每段仍走现有的短链、裸 IP、邀请和 denylist 判断。只拆一层。最多 8 个。证据只留主机名。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| `@` 前面的点状字符也收成点 | `http://example.com．@http://bit.ly` 会变成用户信息，漏掉 Android 打开的短链。 |
| 点状字符一律不再收成点 | `bit．ly` 会漏掉。 |
| 只留下全角句点 | `·` 紧挨在 `@` 前面时仍会藏住后面的短链。 |

## 后果

- `http://example.com．@http://bit.ly/…`、`http://example.com·@http://bit.ly/…` 和 `http://203.0.113.155．@http://bit.ly/…` 按后面的短链删除。证据仍只有主机名。
- `http://example.com．@https://t.me/+…` 按邀请删除。路径不进证据。
- `http://example.com.@http://bit.ly/…` 和 `http://example.com．/http://bit.ly/…` 留着。`bit．ly` 和 `http://user@bit．ly/…` 仍按短链删除。
