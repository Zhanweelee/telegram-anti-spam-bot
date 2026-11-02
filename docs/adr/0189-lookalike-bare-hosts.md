# ADR 0189：点状字符拼成的主机名不再盖住后面的网址

- 状态：已接受
- 日期：2026-11-02

## 背景

Android 不把 `·`、`•`、`‧`、`∙`、`⋅`、`・`、`．`、`﹒` 和 `｡` 当成点。`bit．ly．com/http://t.co/…`、`bit·ly·com/http://t.co/…`、`safe．com/http://bit.ly/…` 和 `www.example．com/http://bit.ly/…` 都不是前面那段域名，只会打开后面的网址。`bit．ly．com/https://t.me/+…` 会另外打开邀请。

带协议的 `http://bit．ly．com/http://t.co/…` 仍是一条链接，路径把后面的短链留在同一段。`b·it.ly` 也是一条链接，主机名不是 `bit.ly`。

粘连扫描如果先把这些字符收成 ASCII `.`，`bit．ly．com/http://t.co` 会变成 `bit.ly.com/http://t.co`，路径盖住 `t.co`。单独充当分隔符的 `bit．ly` 仍要在粘连扫描里收成短链。换行拆开的 `bit．` 加 `ly` 也仍要收成短链。

## 决策

- Android 边界扫描留下点状字符，不再把它们收成 `.`。
- 粘连扫描仍把充当分隔符的点状字符收成 `.`。紧跟在 ASCII `.` 或 `@` 后面、以及紧挨在 `@` 前面的点状字符仍按 ADR 0186、ADR 0187 和 ADR 0188 保留。
- 每段仍走现有的短链、裸 IP、邀请和 denylist 判断。只拆一层。最多 8 个。证据只留主机名。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| Android 扫描也把点状字符收成点 | `bit．ly．com/http://t.co` 会收成 `bit.ly.com`，路径盖住后面的短链。 |
| 粘连扫描也不再收成点 | `bit．ly` 会漏掉。 |
| 只留下全角句点 | `·` 拼成的主机名仍会盖住后面的短链。 |

## 后果

- `bit．ly．com/http://t.co/…`、`bit·ly·com/http://t.co/…`、`safe．com/http://bit.ly/…` 和 `www.example．com/http://bit.ly/…` 按后面的短链删除。证据仍只有主机名。
- `bit．ly．com/https://t.me/+…` 按邀请删除。路径不进证据。
- `http://bit．ly．com/http://t.co/…` 和 `b·it.ly/…` 留着。`bit．ly` 和换行拆开的 `bit．` 加 `ly` 仍按短链删除。
- 点状字符后面紧挨换行再接字母时，粘连扫描会吃掉换行，这段不再单独命中。Android 本来也不打开 `bit．ly`。
