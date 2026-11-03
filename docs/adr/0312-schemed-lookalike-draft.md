# ADR 0312：带协议的草稿主机名里，点状间隔号留在标签里

- 状态：已接受
- 日期：2026-11-03

## 背景

Android 把带协议主机名后面的点状间隔号留在标签里。路径、问号、结尾、写完的端口，或后面再接一个点，都还是这一条链接。`http://bit.ly·/…`、`https://t.co•?…`、`http://203.0.113.10∙/…` 和 `http://bit.ly·:80/…` 的主机名不是前面的短链或裸 IP。`http://bit.ly·/http://t.co/…` 的路径仍属于这一条。`http://bit.ly·.notarealtld/…` 也留着。见 ADR 0223。

没有协议的 `bit.ly·/…`、`http://bit.ly·@evil.com/…`、`http://bit.ly·#…` 和 `http://bit.ly。/…` 仍打开前面的短链。

隐藏的分享 `text` 先按主机名扫描把间隔号留下，随后解析主机名时又把它收成点。`http://bit.ly·/…` 被记成 `bit.ly`。

## 决策

- 分享 `text`、私聊预填 `tg://msg` 的 `text` 和用户名草稿的 `text`，在 `http://` 或 `https://` 的主机名后面遇到一段点状间隔号时，先把这段间隔号写成 `x`。
- 主机名取最长的严格域名，不在中间的短链后缀停住。点分 IPv4 同样。用户信息仍可以放在主机名前面。
- 后面是路径、问号、结尾、1 到 5 位端口，或一个 ASCII 点时才写。点后面是不是严格域名都写。
- `@`、`#` 和空格不写。句号 `。` 仍按原来的规则收成点。
- 没有协议的主机名不写。路径里的另一台主机名不写。
- 不改带协议网址的整段匹配。闭合分享链接里的网址不走这道切开。公开的折叠不改。
- 证据只留主机名。路径不进证据。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 间隔号一律收成点 | `http://bit.ly·/…` 会按短链删除。Android 打开的不是 `bit.ly`。 |
| 裸主机名也把斜杠前的间隔号留下 | `bit.ly·/…` 会漏掉。Android 只打开 `bit.ly`。 |
| `#` 和 `@` 也留在标签里 | `http://bit.ly·#…` 和 `http://bit.ly·@evil.com/…` 会漏掉已经打开的短链。 |
| 改公开折叠 | 看得见的正文已经按 ADR 0223 留下这段间隔号。隐藏草稿要在解析前写成 `x`。 |

## 后果

- `t.me/share/url?text=http://bit.ly·/…`、`https://t.co•?…`、`http://www.bit.ly‧/…`、`http://203.0.113.10∙/…` 和 `http://bit.ly·:80/…` 留着。路径不进证据。
- `http://bit.ly·/http://t.co/…` 留着。路径里的短链不另记。
- `bit.ly·.com/…`、`http://bit.ly·.evil.com/…`、`http://bit.ly·.日本.com/…` 和 `http://bit.ly．.notarealtld/…` 留着。
- `bit.ly·/…`、`www.bit.ly•/…` 和 `203.0.113.10·/…` 仍按短链或裸 IP 删除。
- `http://bit.ly·@evil.com/…`、`http://bit.ly·#…`、`http://bit.ly。/…`、`bit.ly·.notarealtld/…` 和 `http://bit.ly· evil.com/…` 仍按短链删除。
- `example.com·.bit.ly/…` 仍按短链删除。证据是 `example.comx.bit.ly`。
- 带协议的主机名里，希腊文、西里尔文、亚美尼亚文和非 ASCII 拉丁字母留在标签里。见 ADR 0224。
