# ADR 0215：写完的主机名后面不再粘上单字母

- 状态：已接受
- 日期：2026-11-03

## 背景

Android 的裸主机名在最后一个标签结束。`bit.lyª/…`、`www.bit.lyª/…`、`bit.lyℹ/…`、`t.coа/…` 和 `203.0.113.10ª/…` 各自只打开写完的那一台。问号、端口和后面没有点的字母也是这样。`bit.lyªx/…` 仍只打开 `bit.ly`。

把这个单字母收成 ASCII 会粘到标签上。`bit.lyª/…` 变成 `bit.lya`，短链漏掉。`bit.lyªx/…` 若把字母删掉，又会变成 `bit.lyx`。

后面还有域名时，Android 仍收成一条。`bit.lyªevil.com/…`、`bit.lyℹevil.com/…` 和 `example.comℹbit.ly/…` 都是。带协议的 `http://bit.lyª/…` 和 `https://www.bit.lyª/…` 也是一条，字母留在标签里。标签中间的 `bªit.ly`、`bаit.ly` 和 `bℹt.ly` 仍按原来的映射处理。

## 决策

- 写完的裸主机名或点分 IPv4 后面，单字母不再映成 ASCII，除非后面还有域名。
- 带 `http://` 或 `https://` 的主机名仍映射。后面紧接 `http://` 或 `https://` 时仍不映射。
- 这个字母若留在原文里，不再从主机名扫描里删掉，也不再收成 `x`。否则后面的 ASCII 会粘到已经写完的主机名上。
- 标签中间的单字母仍映射。`bℹt.ly` 仍是 `bit.ly`。`bаit.ly` 仍是 `bait.ly`。
- 公开的 `foldCyrillicLookalikes`、`foldFullwidthLatin` 和关键词比较不改。停住扫描仍只在没有协议时留下这些字母。
- 每段仍走现有的短链、裸 IP、邀请和 denylist 判断。只拆一层。最多 8 个。证据只留主机名。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 一律映射 | `bit.lyª/…` 会变成 `bit.lya`。Android 已经单独打开 `bit.ly`。 |
| 写完之后一律删掉 | `bit.lyªx/…` 会变成 `bit.lyx`。短链又被盖住。 |
| 只在两个 ASCII 之间映射 | `ℹbit.ly` 会漏掉。ADR 0206 已经放弃这个方案。 |

## 后果

- `bit.lyª/…`、`www.bit.lyª/…`、`bit.lyℹ/…`、`t.coа/…` 和 `203.0.113.10ª/…` 删除。证据只有主机名。
- `bit.lyªx/…`、`bit.lyª:80/…` 和 `bit.lyª?…` 仍删除。
- `bit.lyªevil.com/…`、`bit.lyℹevil.com/…` 和 `example.comℹbit.ly/…` 留着。
- `http://bit.lyª/…` 和 `https://www.bit.lyª/…` 留着。`bℹt.ly/…` 仍删除。`bаit.ly/…` 留着。
- 路径不进证据。
