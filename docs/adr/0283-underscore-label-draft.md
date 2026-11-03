# ADR 0283：没有协议的草稿把下划线留在标签中间

- 状态：已接受
- 日期：2026-11-03

## 背景

Android 没有协议时，标签以字母或数字开头和结尾，下划线只留在中间。`foo_bar.com/http://bit.ly/…` 和 `www.foo_bar.com/http://bit.ly/…` 都是一条链接。`foo_.com/http://bit.ly/…`、`_foo.com/http://bit.ly/…` 和 `foo-.com/http://bit.ly/…` 只打开后面的短链。`example.com_http://bit.ly/…` 和 `foo_http://bit.ly/…` 没有点出顶级域，Android 不打开。

带协议的主机名本来就允许下划线。汉字紧贴短链，例如 `点击bit.ly`，仍必须命中。

看得见的正文已经这样切。隐藏的分享 `text` 不把下划线算进裸标签，`foo_bar.com/http://bit.ly/…` 里的短链被另抽出来。

## 决策

- 分享 `text`、分享 `url`、私聊预填 `tg://msg` 的 `text` 和用户名草稿的 `text`，没有协议的 ASCII 标签以字母或数字开头和结尾。下划线只留在中间。
- 下划线贴在协议前面时，不把后面的网址另开。`://` 后面的主机名也不再单独成段。
- 下划线在标签开头或结尾，以及连字符在标签结尾时，后面的短链仍另开。
- 带协议的网址不改这条规则。
- 证据只留主机名。路径不进证据。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 继续把下划线挡在裸标签外面 | `foo_bar.com/http://bit.ly` 会把 Android 留在同一段里的短链删掉。 |
| 下划线也可以开头或结尾 | `foo_.com/http://bit.ly` 和 `_foo.com/http://bit.ly` 在 Android 上只打开后面的短链。 |
| `://` 后面的裸域名也单独抽取 | `example.com_http://bit.ly` 会把 Android 没打开的短链删掉。 |

## 后果

- `t.me/share/url?text=foo_bar.com/http://bit.ly/…` 和 `www.foo_bar.com/http://bit.ly/…` 留着。路径不进证据。
- `foo_.com/http://bit.ly/…`、`_foo.com/http://bit.ly/…` 和 `foo-.com/http://bit.ly/…` 删除。证据仍只有主机名。
- `example.com_http://bit.ly/…` 和 `foo_http://bit.ly/…` 留着。
- `点击bit.ly/…` 仍按短链删除。
