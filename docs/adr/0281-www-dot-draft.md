# ADR 0281：没有协议的 www. 在点号处结束

- 状态：已接受
- 日期：2026-11-03

## 背景

Android 没有协议时，`www.` 和裸域名的尾巴只有一到五位端口，以及以 `/` 或 `?` 开头的路径。点号不属于这一段。`www.example.com./http://bit.ly/…`、`www.example.com.?http://bit.ly/…` 和 `www.example.com.:80/http://bit.ly/…` 都会先停在 `www.example.com`，再打开后面的短链。

带协议的网址仍把这个点留在当前这一段。`http://www.example.com./http://bit.ly/…` 仍是一条链接。问号直接接在主机名后面时也仍是一条链接。

看得见的正文已经这样切。隐藏的分享 `text` 把点号和后面的路径收成一条，短链留在路径里。`www.t.me./+…` 还被记成邀请。

## 决策

- 分享 `text`、分享 `url`、私聊预填 `tg://msg` 的 `text` 和用户名草稿的 `text`，没有协议的 `www.` 和裸域名不把路径前的点号留在这一段。
- 点号后面是 `/`、`?` 或端口时，从点号后面另抽网址。
- 带协议的网址仍把这个点留在当前这一段。问号直接接在主机名后面时也留着。
- 点号挡住的邀请路径不改记成邀请。没有这个点时，`www.t.me/+…` 仍按邀请读取。带协议的 `https://t.me./+…` 仍按邀请读取。
- 证据只留主机名。路径和邀请码不进证据。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 带协议的点号也切开 | `http://www.example.com./http://bit.ly` 仍是一个网址。 |
| 问号也从 `www.` 上拿掉 | `www.example.com?http://bit.ly` 仍是一个网址。 |
| 点号后面的邀请仍算邀请 | `www.t.me./+…` 点不开这条邀请。 |

## 后果

- `t.me/share/url?text=www.example.com./http://bit.ly/…`、`www.example.com.?http://bit.ly/…` 和 `www.example.com.:80/http://bit.ly/…` 删除。证据仍只有主机名。
- `www.example.com./bit.ly/…` 同样删除。
- `www.example.com?http://bit.ly/…` 和 `http://www.example.com./http://bit.ly/…` 留着。
- `www.bit.ly./…` 仍按短链删除。路径不进证据。
- `www.t.me./+…` 留着。`www.t.me/+…` 和 `https://t.me./+…` 仍按邀请删除。邀请码不进证据。
- Android 不认的顶级域后来同样停住，后面的短链另留。见 ADR 0282。
