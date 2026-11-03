# ADR 0282：没有协议的草稿只用 Android 认的顶级域

- 状态：已接受
- 日期：2026-11-03

## 背景

Android 没有协议时，主机名的最后一段必须是严格顶级域，或 `xn--` 开头的 punycode 后缀。`foo.example/http://bit.ly/…`、`foo.test/http://bit.ly/…` 和 `www.foo.example/http://bit.ly/…` 都不会把后面的短链收进前一段。`.bar` 在名单里，所以 `foo.bar.example/http://bit.ly/…` 停在 `foo.bar`，再打开后面的短链。

带协议的网址不看这份名单。`http://foo.example/http://bit.ly/…` 仍是一条链接。`example.com/http://bit.ly/…` 和 `example.xn--p1ai/http://bit.ly/…` 仍是一条链接。

看得见的正文已经这样切。隐藏的分享 `text` 把任意两个字母以上的后缀都当成主机名，短链留在路径里。

## 决策

- 分享 `text`、分享 `url`、私聊预填 `tg://msg` 的 `text` 和用户名草稿的 `text`，没有协议的主机名和 `www.` 的最后一段使用 Android 这份严格顶级域。
- 最后一段认不出时，从这段后面另抽网址。前面还有认得出的顶级域时，停在那一段。
- 带协议的网址仍按放松主机名读取。问号直接接在认得出的主机名后面时也留着。
- 点分 IPv4 仍按地址读取，问号留在这一段。
- 证据只留主机名。路径和邀请码不进证据。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 继续接受任意两个以上字母的后缀 | `foo.example/http://bit.ly` 会漏掉 Android 打开的短链。 |
| 带协议的网址也改用这份名单 | `http://foo.example/http://bit.ly` 仍是一个网址。 |
| 点分地址也按顶级域拆开 | `203.0.113.243?http://bit.ly` 仍是一个地址。 |

## 后果

- `t.me/share/url?text=foo.example/http://bit.ly/…`、`foo.example?http://bit.ly/…`、`foo.test/http://bit.ly/…` 和 `www.foo.example/http://bit.ly/…` 删除。证据仍只有主机名。
- `foo.bar.example/http://bit.ly/…` 按后面的短链删除。
- `example.com/http://bit.ly/…`、`www.example.com/http://bit.ly/…`、`example.xn--p1ai/http://bit.ly/…`、`foo.xn--a/http://bit.ly/…` 和 `http://foo.example/http://bit.ly/…` 留着。
- `example.http://bit.ly/…` 按后面的短链删除。
- `foo.example/https://t.me/+…` 按邀请删除。路径和邀请码不进证据。
