# ADR 0190：网址前面的形近字母仍保留

- 状态：已接受
- 日期：2026-11-02

## 背景

Android 不把七个西里尔形近字母、乌克兰语 `і` 和全角拉丁字母当成单词字符。`example.comАhttp://bit.ly/…`、`example.comＡhttp://bit.ly/…`、`www.example.comＡhttp://bit.ly/…`、`bАhttp://bit.ly/…` 和 `203.0.113.157Аhttp://bit.ly/…` 都会在这个字母前结束，再打开后面的网址。`example.comАhttps://t.me/+…` 会另外打开邀请。

带协议的 `http://example.comАhttp://bit.ly/…` 仍是一条链接，标签把后面的 `http` 留在同一段。斜杠后面的全角字母也留在路径里。`bАbit.ly` 和 `xАbit.ly` 是一条链接，主机名不是 `bit.ly`。

Android 扫描如果先把这个字母收成 ASCII，`example.comAhttp://bit.ly` 会把 `http` 粘进标签，短链不再出现。夹在 ASCII 字母中间、后面不是网址时，`bАit.ly` 仍要收成 `bAit.ly`，`bіt.ly` 和全角的 `ｂｉｔ.ly` 仍要收成短链。

## 决策

- Android 边界扫描里，西里尔形近字母或全角拉丁字母紧挨在 `http://` 或 `https://` 前面时保留。
- 其他位置仍收成对应的 ASCII 字母。粘连扫描仍全部收成 ASCII。
- 每段仍走现有的短链、裸 IP、邀请和 denylist 判断。只拆一层。最多 8 个。证据只留主机名。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 网址前面的字母也收成 ASCII | `example.comАhttp://bit.ly` 会把 `http` 粘进标签，漏掉 Android 打开的短链。 |
| 这些字母一律不再收成 ASCII | `bіt.ly` 和全角的 `ｂｉｔ.ly` 会漏掉。 |
| 夹在标签里的形近字母也不收 | `bАbit.ly` 会从中间拆出 `bit.ly`。Android 打开的是整段主机名。 |

## 后果

- `example.comАhttp://bit.ly/…`、`example.comＡhttp://bit.ly/…`、`www.example.comＡhttp://bit.ly/…`、`bАhttp://bit.ly/…` 和 `203.0.113.157Аhttp://bit.ly/…` 按后面的短链删除。证据仍只有主机名。
- `example.comАhttps://t.me/+…` 按邀请删除。路径不进证据。
- `http://example.comАhttp://bit.ly/…` 和 `http://example.com/Ａhttp://bit.ly/…` 留着。`bАbit.ly` 留着。`bіt.ly` 和全角的 `ｂｉｔ.ly` 仍按短链删除。
- 组合附加符号紧挨在裸主机名和网址之间时，不再单独打开后面的短链。见 ADR 0191。
