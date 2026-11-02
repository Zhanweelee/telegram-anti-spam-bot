# ADR 0185：没有协议的主机名在这类字母前结束

- 状态：已接受
- 日期：2026-11-02

## 背景

Android 的单词边界只认 ASCII 字母、数字和下划线。希腊字母、西里尔字母、亚美尼亚文和非 ASCII 拉丁字母可以留在标签里，但它们不是单词字符。`example.comα/http://bit.ly/…`、`www.example.comα?http://bit.ly/…` 和 `example.com_αhttp://bit.ly/…` 都会在这个字母前结束，再打开后面的网址。

带协议时，这个字母仍留在标签里。`http://example.comα/http://bit.ly/…` 和 `http://bit.lyαtail.example/…` 仍是一条链接。夹在两个 ASCII 字母中间时，整段折叠仍把 `bαit.ly` 收成短链。`xαbit.ly` 收成一个标签后不是短链。

`example.comα/https://t.me/+…` 会另外打开邀请。汉字紧贴短链，例如 `点击bit.ly`，仍必须命中。见 ADR 0097。

## 决策

- 留下 Android 停住字符的那次扫描，保留出现在已结束主机名后面的这些字母，也保留紧挨着后面网址的这些字母。
- 两个 ASCII 字母或数字中间的这类字母仍删掉。粘连扫描仍删掉全部这类字母。
- 这封扫描里单独打开的 `https://t.me/+…` 仍按邀请读取。被字母挡住、没有单独成段的路径不改记成邀请。
- 每段仍走现有的短链、裸 IP、邀请和 denylist 判断。只拆一层。最多 8 个。证据只留主机名。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 这封扫描继续删掉标签里的这些字母 | `example.comα/http://bit.ly` 会粘成一条普通网址，漏掉 Android 打开的短链。 |
| 字母后面一律另起主机名 | `xαbit.ly` 会把中间的 `bit.ly` 记成短链。Android 打开的是整段主机名。 |
| 粘连扫描也不再删这些字母 | `bαit.ly` 会漏掉。 |

## 后果

- `example.comα/http://bit.ly/…`、`www.example.comα?http://bit.ly/…`、`foo_bar.com` 加西里尔字母再接短链，以及 `203.0.113.152é/http://bit.ly/…` 按后面的短链删除。证据仍只有主机名。
- `example.comα/https://t.me/+…` 按邀请删除。路径不进证据。
- `http://example.comα/http://bit.ly/…`、`http://bit.lyαtail.example/…` 和 `xαbit.ly/…` 留着。`bαit.ly` 和 `点击bit.ly` 仍按短链删除。
