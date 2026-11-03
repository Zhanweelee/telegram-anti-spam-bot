# ADR 0278：路径里的单引号仍留在隐藏草稿这一段

- 状态：已接受
- 日期：2026-11-03

## 背景

Android 的路径在 `/` 或 `?` 开始之后可以包含单引号。`http://example.com/'http://bit.ly/…`、`example.com/'http://bit.ly/…` 和 `www.example.com/'http://bit.ly/…` 都是一条链接。路径还没开始时，单引号会停住：`http://example.com'http://bit.ly/…` 和 `example.com'bit.ly/…` 会再打开后面的短链。双引号不属于路径，`http://example.com/"http://bit.ly/…` 也会再打开。

看得见的正文已经这样切。隐藏的分享 `text` 在单引号处停住，路径里的短链被另抽出来。分享 `url` 则把路径还没开始的单引号和双引号留在主机名上，后面的短链不再打开。

## 决策

- 分享 `text`、分享 `url`、私聊预填 `tg://msg` 的 `text` 和用户名草稿的 `text`，路径或问号已经开始后，单引号留在这一段里。这段里面的另一个主机名不另记。
- 路径还没开始时，单引号仍结束这一段。后面的网址单独打开。
- 双引号仍结束这一段。
- 第一段自己是短链或裸 IP 时，仍按现有规则删除。证据只留这一段的主机名。
- 邀请仍要求路径本身是邀请码。单引号接在邀请码后面时，整段路径不再记成邀请。
- 路径和邀请码不进证据。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 单引号一律切开 | `http://example.com/'http://bit.ly` 会删掉 Android 留成一条普通链接的消息。 |
| 单引号一律留在主机名上 | `example.com'bit.ly` 会漏掉后面打开的短链。 |
| 双引号也留在路径里 | Android 在双引号处结束，后面的短链会再打开。 |

## 后果

- `t.me/share/url?text=http://example.com/'http://bit.ly/…`、`example.com/'http://bit.ly/…`、`www.example.com/'http://bit.ly/…` 和 `http://example.com?x='http://bit.ly/…` 留着。
- `bit.ly/'http://t.co/…` 仍按短链删除。证据只有 `bit.ly`。
- `203.0.113.245/'http://bit.ly/…` 仍按裸 IP 删除。证据只有这个地址。
- `http://example.com'http://bit.ly/…`、`example.com'bit.ly/…` 和 `http://example.com/"http://bit.ly/…` 仍删除后面的短链。
- 分享 `url` 里的同一组写法同样处理。
- `https://t.me/+…'http://bit.ly/…` 留着。邀请码和路径不进证据。
