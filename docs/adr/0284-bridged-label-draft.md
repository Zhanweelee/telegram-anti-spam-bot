# ADR 0284：连字符或下划线可以把草稿里的裸标签接在一起

- 状态：已接受
- 日期：2026-11-03

## 背景

Android 没有协议时，一个标签可以用连字符或下划线把字母接在一起。`例_foo.com/http://bit.ly/…`、`foo-例.com/http://bit.ly/…` 和 `www.例_foo.com/http://bit.ly/…` 都是一条链接。`点击_bit.ly/…` 也是一条链接，主机名不是 `bit.ly`。

标签仍不能以连字符或下划线开头、结尾。`例_.com/http://bit.ly/…` 只打开后面的短链。点号后面另起的网址也单独打开。空格后面没有单词边界，`见 例_foo.com/http://bit.ly/…` 会打开后面的短链。不是这份严格顶级域的后缀也一样。

汉字紧贴短链，例如 `点击bit.ly`，仍必须命中。

看得见的正文已经这样切。隐藏的分享 `text` 把 `例_foo.com/http://bit.ly/…` 拆开，短链被另抽出来。

## 决策

- 分享 `text`、分享 `url`、私聊预填 `tg://msg` 的 `text` 和用户名草稿的 `text`，没有协议的标签在含有连字符或下划线时，可以同时包含 ASCII 字母和其他 Android 留在标签里的字母。
- 标签仍以字母开头和结尾，最长 63 个字符。没有连字符或下划线时，标签仍是纯 ASCII。
- 带协议的网址不改这条规则。严格顶级域、点号和空格的边界仍按已经落地的草稿规则。
- 证据只留主机名。路径不进证据。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 继续把纯 ASCII 和纯非 ASCII 分成两个标签 | `例_foo.com/http://bit.ly` 和 `foo-例.com/http://bit.ly` 会删掉 Android 留在同一段里的短链。 |
| 任何相邻字母都收成一个裸标签 | `点击bit.ly` 会收成一个国际域名，短链命中就没了。 |
| 连字符和下划线也可以开头或结尾 | `例_.com/http://bit.ly` 在 Android 上只打开后面的短链。 |

## 后果

- `t.me/share/url?text=例_foo.com/http://bit.ly/…`、`foo-例.com/http://bit.ly/…`、`www.例_foo.com/http://bit.ly/…` 和 `点击_bit.ly/…` 留着。路径不进证据。
- `例_.com/http://bit.ly/…`、`例_foo.com./http://bit.ly/…`、`例_foo.example/http://bit.ly/…` 和空格后面的 `例_foo.com/http://bit.ly/…` 删除。证据仍只有主机名。
- `点击bit.ly` 仍按短链删除。
- 没有协议的主机名在希腊文、西里尔文、亚美尼亚文或非 ASCII 拉丁字母前结束时，后面的网址后来仍不另开。见 ADR 0285。
