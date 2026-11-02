# ADR 0182：没有协议的主机名只用 Android 认的顶级域

- 状态：已接受
- 日期：2026-11-02

## 背景

Android 没有协议时，主机名的最后一段必须是 `LinkifyPort` 里的 IANA 顶级域，或 `xn--` 开头的 punycode 后缀。`foo.example/http://bit.ly/…`、`foo.test/http://bit.ly/…` 和 `www.foo.example/http://bit.ly/…` 都不会把后面的短链收进前一段。`.bar` 在名单里，所以 `foo.bar.example/http://bit.ly/…` 停在 `foo.bar`，再打开后面的短链。

`example.com`、`example.xn--p1ai` 和 `例子.中国` 仍是一条链接。带协议的网址不看这份名单。`http://foo.example/http://bit.ly/…` 仍是一条链接。

空格和汉字都不是 ASCII 单词字符，中间没有单词边界。`见 例子.中国/http://bit.ly/…` 会打开后面的短链。正文开头的 `例子.中国/…` 仍是一条链接。

## 决策

- 没有协议的主机名和 `www.` 的最后一段使用 Android 这份严格顶级域，外加 `xn--` 后最多 59 个 punycode 字符的后缀。
- 标签可以是纯 ASCII，或纯非 ASCII。正文开头允许直接写非 ASCII 标签。空格和其他非单词字符后面，非 ASCII 标签不开始新的裸域名。
- 带协议的网址仍按放松主机名读取，不要求这份顶级域名单。
- 每段仍走现有的短链、裸 IP、邀请和 denylist 判断。只拆一层。最多 8 个。证据只留主机名。
- 后缀挡住的邀请路径不改记成邀请。后缀后面单独的 `https://t.me/+…` 仍按邀请读取。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 继续接受任意两个以上字母的后缀 | `foo.example/http://bit.ly` 会漏掉 Android 打开的短链。 |
| 带协议的网址也改用这份名单 | `http://foo.example/http://bit.ly` 仍是一个网址。 |
| 空格后面也收进国际域名 | `见 例子.中国/http://bit.ly` 会漏掉后面的短链。 |

## 后果

- `foo.example/http://bit.ly/…`、`foo.example?http://bit.ly/…`、`www.foo.example/http://bit.ly/…` 和 `foo.bar.example/http://bit.ly/…` 按后面的短链删除。证据仍只有主机名。
- `example.com/http://bit.ly/…`、`example.xn--p1ai/http://bit.ly/…`、`例子.中国/http://bit.ly/…` 和 `http://foo.example/http://bit.ly/…` 留着。
- 空格后面的 `例子.中国/http://bit.ly/…` 按后面的短链删除。
- `foo.example/https://t.me/+…` 按邀请删除。路径不进证据。
- 下划线夹在没有协议的标签中间时仍属于这一段。下划线开头或结尾时，后面的网址仍单独打开。见 ADR 0183。
