# ADR 0285：没有协议的草稿在这类字母前结束

- 状态：已接受
- 日期：2026-11-03

## 背景

Android 的单词边界只认 ASCII 字母、数字和下划线。希腊字母、西里尔字母、亚美尼亚文和非 ASCII 拉丁字母可以留在标签里，但它们不是单词字符。`example.comα/http://bit.ly/…`、`www.example.comα?http://bit.ly/…`、`foo_bar.com` 加西里尔字母，以及 `203.0.113.152é/http://bit.ly/…` 都会在这个字母前结束，再打开后面的网址。`example.com_αhttp://bit.ly/…` 也一样。

带协议时，这个字母仍留在标签里。`http://example.comα/http://bit.ly/…` 和 `http://bit.lyαtail.example/…` 仍是一条链接。夹在两个 ASCII 字母中间时，整段折叠仍把 `bαit.ly` 收成短链。`xαbit.ly` 收成一个标签后不是短链。汉字紧贴短链，例如 `点击bit.ly`，仍必须命中。

看得见的正文已经这样切。隐藏的分享 `text` 把 `example.comα/http://bit.ly/…` 收成一条普通网址，短链被漏掉。见 ADR 0185。

## 决策

- 分享 `text`、分享 `url`、私聊预填 `tg://msg` 的 `text` 和用户名草稿的 `text`，没有协议的主机名在希腊文、西里尔文、亚美尼亚文或非 ASCII 拉丁字母前结束。字母紧贴协议，或中间只隔着下划线时，同样另开后面的网址。
- 带协议的网址不在这个字母处切开。两个 ASCII 字母或数字中间的这类字母仍删掉。
- 证据只留主机名。路径和邀请码不进证据。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 草稿继续把这个字母删掉再抽网址 | `example.comα/http://bit.ly` 会粘成一条普通网址，漏掉 Android 打开的短链。 |
| 停住字符的那次扫描整段再跑一遍 | 路径里的 U+1680 也会把后面的短链拆出来。Android 把这个空白留在带协议的路径里。 |
| 字母后面一律另起主机名 | `xαbit.ly` 会把中间的 `bit.ly` 记成短链。 |

## 后果

- `t.me/share/url?text=example.comα/http://bit.ly/…`、`www.example.comα?http://bit.ly/…`、`foo_bar.com` 加西里尔字母、`203.0.113.152é/http://bit.ly/…` 和 `example.com_αhttp://bit.ly/…` 删除。分享 `url` 同样删除。证据仍只有主机名。
- `example.comα/https://t.me/+…` 按邀请删除。路径和邀请码不进证据。
- `http://example.comα/http://bit.ly/…`、`http://bit.lyαtail.example/…` 和 `xαbit.ly/…` 留着。`bαit.ly` 和 `点击bit.ly` 仍按短链删除。
