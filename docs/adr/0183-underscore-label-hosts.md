# ADR 0183：没有协议的标签把下划线留在中间

- 状态：已接受
- 日期：2026-11-02

## 背景

Android 没有协议时，标签中间可以有下划线，开头和结尾不行。`foo_bar.com/http://bit.ly/…` 和 `www.foo_bar.com/http://bit.ly/…` 都是一条链接。`foo_.com/http://bit.ly/…`、`_foo.com/http://bit.ly/…` 和 `foo-.com/http://bit.ly/…` 只打开后面的短链。`example.com_http://bit.ly/…` 和 `foo_http://bit.ly/…` 没有点出顶级域，Android 不打开。

带协议的主机名本来就允许下划线。汉字紧贴短链，例如 `点击bit.ly`，仍必须命中。见 ADR 0097。

## 决策

- 没有协议的 ASCII 标签以字母或数字开头和结尾。下划线只留在中间。
- 裸标签仍是纯 ASCII，或纯非 ASCII。不把汉字和拉丁字母收成同一个裸标签。
- 带协议的网址不改这条规则。
- 每段仍走现有的短链、裸 IP、邀请和 denylist 判断。只拆一层。最多 8 个。证据只留主机名。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 继续把下划线挡在裸标签外面 | `foo_bar.com/http://bit.ly` 会把 Android 留在同一段里的短链删掉。 |
| 裸标签改成和带协议一样的混合标签 | `点击bit.ly` 会收成一个国际域名，ADR 0097 要求的短链命中就没了。 |
| 下划线也可以开头或结尾 | `foo_.com/http://bit.ly` 和 `_foo.com/http://bit.ly` 在 Android 上只打开后面的短链。 |

## 后果

- `foo_bar.com/http://bit.ly/…` 和 `www.foo_bar.com/http://bit.ly/…` 留着。
- `foo_.com/http://bit.ly/…`、`_foo.com/http://bit.ly/…` 和 `foo-.com/http://bit.ly/…` 按后面的短链删除。证据仍只有主机名。
- `example.com_http://bit.ly/…` 留着。`点击bit.ly` 仍按短链删除。
- 下划线或连字符把不同字母接在同一个裸标签里时，这一段仍留着。标记在开头或结尾时，后面的网址仍单独打开。见 ADR 0184。
