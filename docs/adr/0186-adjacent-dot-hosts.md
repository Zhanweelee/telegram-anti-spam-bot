# ADR 0186：ASCII 点后面的点状字符仍留在标签里

- 状态：已接受
- 日期：2026-11-02

## 背景

Android 把 `·`、`•`、`‧`、`∙`、`⋅`、`・`、`．`、`﹒` 和 `｡` 当作标签字符，不当作点。`http://example.com.．http://bit.ly/…`、`http://example.com.．/http://bit.ly/…` 和 `http://example.com.·?http://bit.ly/…` 都是一条链接，高亮停在后面的 `http` 前面，不会再打开短链。

主机名扫描如果把这个字符收成 ASCII `.`，就会出现 `..`，短链被单独打开。没有协议的 `example.com.．http://bit.ly/…` 和 `www.example.com.．http://bit.ly/…` 仍会在多出来的点前结束，后面的短链照样打开。真正的 `..` 也仍拆开。单独充当分隔符的 `bit．ly` 仍要收成短链。

## 决策

- 主机名扫描里，点状字符紧跟在 ASCII `.` 后面时保留。
- 前面不是 ASCII `.` 的点状字符仍收成 `.`。
- `foldDotLookalikes` 仍把全部点状字符收成点。关键词和结构化主机名不改。
- 每段仍走现有的短链、裸 IP、邀请和 denylist 判断。只拆一层。最多 8 个。证据只留主机名。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 点状字符一律不再收成点 | `bit．ly` 会漏掉。 |
| 只留下全角句点 | `·`、`﹒` 和 `｡` 紧跟在点后面时仍会拆开。 |
| 只在留下停住字符的扫描里保留 | 粘连扫描仍会把 `..` 拆开并命中短链。 |

## 后果

- `http://example.com.．http://bit.ly/…`、斜杠后面的同一段，以及问号前面的间隔号 `·`，都留着。`http://example.com.．/https://t.me/+…` 不记成邀请。
- `example.com.．http://bit.ly/…` 和 `www.example.com.．http://bit.ly/…` 按后面的短链删除。证据仍只有主机名。
- `bit．ly`、`example.com．/http://bit.ly/…` 和 `http://example.com..http://bit.ly/…` 仍按短链删除。
- `@` 后面的标签字符仍留在这一段，后面的 `http` 不再另开。见 ADR 0187。
