# ADR 0219：写完的主机名后面接不上域名时不再收成 x

- 状态：已接受
- 日期：2026-11-03

## 背景

ADR 0205 把夹在 ASCII 中间的标签字收成 `x`。`bit.ly点evil.com/…` 因此留着，因为 Android 把它收成一条主机名。

后面接不上严格域名时，Android 会在标签字前面停住。`bit.ly点free/…`、`bit.ly点free.notarealtld/…` 和 `bit.ly点203.0.113.10/…` 都打开 `bit.ly`。后一条还另外打开 `203.0.113.10`。`example.com点203.0.113.10/…` 和 `203.0.113.10点203.0.113.11/…` 也打开这些裸 IP。

收成 `x` 会把它们粘成 `bit.lyxfree` 或 `bit.lyx203.0.113.10`。短链和裸 IP 都对不上。

`bit.ly点free.com/…`、`bit.ly点free.中国/…` 和 `http://bit.ly点free/…` 仍是一条。带协议的整段网址，地址解析器给出的主机名不是 `bit.ly`。

## 决策

- 只改主机名扫描。公开的折叠不改。
- 一段 Android 标签字夹在 ASCII 中间时，前面已经是写完的主机名，而且后面不是 Android 的严格域名，就留下这些标签字。
- 后面仍是严格域名时，继续收成 `x`。`http://` 和 `https://` 前面的标签字仍留下。前面没有 ASCII 的标签字仍留下。
- 停住扫描也按这一步，避免粘连扫描留下短链之后又被停住扫描盖住。
- 每段仍走现有的短链、裸 IP、邀请和 denylist 判断。只拆一层。最多 8 个。证据只留主机名。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 写完的主机名后面一律不收成 `x` | `bit.ly点evil.com/…` 会按短链删除。Android 只打开这一整条。 |
| 只认裸 IP，不认没有点的尾巴 | `bit.ly点free/…` 仍被收成 `bit.lyxfree`。Android 已经单独打开 `bit.ly`。 |
| 任何两到六十三位字母都当成域名 | `bit.ly点free.notarealtld/…` 仍被粘住。Android 的严格顶级域名单里没有这段。 |

## 后果

- `bit.ly点free/…`、`bit.ly가free/…` 和 `bit.ly点free.notarealtld/…` 按短链删除。证据是 `bit.ly`。
- `bit.ly点203.0.113.10/…` 按短链和裸 IP 删除。`example.com点203.0.113.10/…` 按裸 IP 删除。证据是 `203.0.113.10`。
- `bit.ly点evil.com/…`、`bit.ly点free.com/…`、`bit.ly点free.中国/…` 和 `http://bit.ly点203.0.113.10/…` 留着。
- `example.com点bit.ly/…` 和 `203.0.113.10点bit.ly/…` 仍留着。见 ADR 0205。
- 点号后面仍是严格域名时，夹在中间的标签字收成 `x`。见 ADR 0220。
- 路径不进证据。
