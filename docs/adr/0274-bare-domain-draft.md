# ADR 0274：裸域名结束后仍留下后面的主机名

- 状态：已接受
- 日期：2026-11-03

## 背景

Android 读没有协议的域名和 `www.` 开头的域名时，停在最后一个标签。标签不能以连字符开头。`http://` 和 `https://` 不能当成这个标签。

看得见的正文已经这样切。隐藏的分享 `text` 和分享 `url` 把整段交给地址解析。`www.example.com-http://bit.ly/…` 的主机名收成 `www.example.com-http`，短链留在路径里。`www.example.com.http://t.co/…` 也一样。`www.example.com` 后接 U+00A1 再接短链时，中间这个字让整段不再是一个主机名。

斜杠或问号后面的地址仍属于前一个路径。带 `http://` 的主机名仍按放松规则把标签字符粘在同一个主机名里。

## 决策

- 分享 `text`、分享 `url`、私聊预填 `tg://msg` 的 `text` 和用户名草稿的 `text`，按最后一个标签结束裸域名和 `www.`。
- 连字符、点号紧挨着 `http://` 或 `https://`，或别的标签字符紧挨着协议时，从那里另抽网址。
- 一到五位数字的端口后面如果是连字符，或点号紧挨着协议，同样另抽。
- `/` 或 `?` 已经开始之后，后面的网址仍留在这一条里。
- 带协议的一段不因为这处改动提前切开。`http://example.com.http://…` 和带协议后再接 U+00A1 仍是一条。
- `www.t.me.evil.example/+…` 不改记成邀请。标签后面单独的邀请地址仍按邀请读取。
- 路径和邀请码不进证据。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 整段交给地址解析 | 短链留在路径里，或主机名收成 `example.com-http`。 |
| 路径和问号里也切开 | `www.example.com/!http://bit.ly` 仍是一个网址。 |
| 带协议的主机名也在这里切开 | `http://example.com.http://bit.ly` 仍是一条。 |

## 后果

- `t.me/share/url?text=www.example.com-http://bit.ly/…`、点号后面的 `t.co`、U+00A1 后面的短链，以及 `example.com.http://` 后面的裸 IP，删除。证据仍只有主机名。
- `http://example.com:80-bit.ly/…` 和六位端口后面的裸 IP 同样删除。
- 分享 `url` 里的同样写法同样删除。
- `www.example.com/!http://bit.ly` 和 `www.example.com?http://bit.ly` 留着。`www.bit.ly/…` 仍按短链删除。
- `http://example.com` 后接 U+00A1 再接短链，以及 `http://example.com.http://bit.ly`，留着。
- `www.example.com-https://t.me/+…` 按邀请删除。`www.t.me.evil.example/+…` 不改记成邀请。路径不进证据。
