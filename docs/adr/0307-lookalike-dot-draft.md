# ADR 0307：写完的草稿主机名和后面的域名之间的点状间隔号收成一个点

- 状态：已接受
- 日期：2026-11-03

## 背景

Android 把中间点、项目符号、全角句点和同类点状间隔号算进标签。`bit.ly·evil.com/…`、`www.bit.ly．evil.com/…`、`bit.ly··evil.com/…` 和 `203.0.113.10·evil.com/…` 各是一条主机名。`example.com·bit.ly/…` 连起来仍以 `.bit.ly` 结尾。`bit.ly·/…` 和 `bit.ly·evil·com/…` 只打开 `bit.ly`。`bit·ly/…` 仍是短链。`example.com.·http://bit.ly/…` 仍打开后面的短链。见 ADR 0217。

隐藏的分享 `text` 把第一个间隔号当成标签字丢掉。`bit.ly·evil.com/…` 被拆成 `bit.ly` 和 `evil.com`。

## 决策

- 分享 `text`、私聊预填 `tg://msg` 的 `text` 和用户名草稿的 `text`，在写完的裸主机名或点分 IPv4 后面遇到一段点状间隔号时，后面是 ASCII 域名就留给主机名扫描。
- 后面是斜杠、路径，或不是 ASCII 域名时，仍在这段间隔号前结束。`bit.ly·evil·com` 仍按 `bit.ly` 删除。
- 间隔号是主机名里唯一的点时仍收成短链。`bit·ly` 仍删除。
- ASCII 点后面再粘着间隔号、然后是 `http://` 或 `https://` 时，后面的网址仍单独打开。
- 带协议的同一串仍是一条。
- 不改带协议网址的整段匹配。闭合分享链接里的网址不走这道切开。
- 证据只留主机名。路径不进证据。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 间隔号一律留下 | `bit.ly·evil·com` 会收成 `bit.ly.evil.com`。Android 只打开 `bit.ly`。 |
| 间隔号一律切开 | `bit.ly·evil.com` 会删掉 Android 留成一条主机名的消息。 |
| 只改检测器分词 | 分享 `text` 在扫描之前已经把间隔号丢掉。 |

## 后果

- `t.me/share/url?text=bit.ly·evil.com/…`、`www.bit.ly．evil.com/…`、`bit.ly··evil.com/…`、`203.0.113.10·evil.com/…` 和 `http://bit.ly·evil.com/…` 留着。项目符号和半角句点同样留着。路径不进证据。
- `example.com·bit.ly/…` 按短链删除。证据是 `example.com.bit.ly`。
- `203.0.113.10·bit.ly/…` 按短链删除。证据是 `203.0.113.10.bit.ly`，不是那条裸 IP。
- `bit.ly·/…` 和 `bit.ly·evil·com/…` 按短链删除。证据是 `bit.ly`。`bit·ly/…` 仍按短链删除。
- `example.com.·http://bit.ly/…` 按短链删除。证据是 `bit.ly`。
- 裸 IP 前面的单字母仍可能粘上去。见 ADR 0218。
