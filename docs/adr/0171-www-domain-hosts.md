# ADR 0171：裸域名结束后再打开的主机名也留下

- 状态：已接受
- 日期：2026-11-02

## 背景

Android `LinkifyPort.WEB_URL` 里，没有协议的域名和 `www.` 开头的域名按严格标签结束。最后一个标签后面如果是连字符、点，或别的标签字符，当前匹配就停住。后面如果还有网址，会再打开一次。

`www.example.com-http://bit.ly/…` 因此会打开 `bit.ly`。整段当成一个主机名时，短链被粘进 `example.com-http`。`example.com.http://bit.ly/…` 也一样：`http://` 不是这个标签。连字符不能当作标签的开头，所以 `example.com:80-bit.ly` 打开的是 `bit.ly`，不是 `-bit.ly`。

斜杠或问号后面的地址仍属于前一个路径。带 `http://` 的主机名仍按放松规则把标签字符粘在同一个主机名里，`http://example.com` 后接 U+00A1 再接 `http://bit.ly` 不会单独打开后面的短链。

## 决策

- 裸域名和 `www.` 由标签加点组成，停在最后一个标签。标签不能以连字符开头。`http://` 和 `https://` 不能当成这个标签。
- `www.` 后面可以接非 ASCII 标签，最后一截仍是 ASCII 标签。可选端口和以 `/` 或 `?` 开头的路径留在这一段里。
- 带协议的一段仍按原来的主机名、端口和路径规则，不因为这处改动提前切开。
- 每段仍走现有的裸 IP、短链、邀请和 denylist 判断。只拆一层。最多 8 个。证据只留主机名。
- 切开之后单独的邀请地址仍按邀请读取。同一段路径里的邀请不改记。
- 已经写在 `text_link`、按钮或其它结构化字段里的地址整段打开。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 整段只留第一个主机名 | 标签后面的短链和裸 IP 点得开。 |
| 这些字符在路径里也切开 | `www.example.com/!http://bit.ly` 仍是一个网址。 |
| 带协议的主机名也在这里切开 | `http://example.com` 后接标签字符时，后面的地址仍属于前一个主机名。 |

## 后果

- `www.example.com-http://bit.ly/…`、`www.example.com.http://t.co/…`、`www.example.com` 后接 U+00A1 再接 `http://bit.ly/…`、`example.com.http://203.0.113.138/…` 和 `http://example.com:80-bit.ly/…` 按现有短链或裸 IP 规则删除。证据仍只有主机名。
- `www.example.com/!http://bit.ly/…` 和 `www.example.com?http://bit.ly/…` 留着。`www.bit.ly/…` 仍按短链删除。
- `http://example.com` 后接 U+00A1 再接 `http://bit.ly/…` 留着。
- `www.t.me.evil.example/+…` 不记成邀请。`www.example.com-https://t.me/+…` 按邀请删除。路径不进证据。
- 带协议的主机名里，点号后面接不上标签时，Android 另外打开的主机名也留下。见 ADR 0172。
