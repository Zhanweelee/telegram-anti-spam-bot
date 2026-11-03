# ADR 0309：写完的草稿主机名和点号后面的严格域名之间的标签字收成 x

- 状态：已接受
- 日期：2026-11-03

## 背景

Android 在写完的主机名和点号后面的严格域名之间，把标签字收成一条主机名。`bit.ly点日本.com/…`、`www.bit.ly点日本.com/…`、`t.co点日本.com/…`、`203.0.113.10点日本.com/…`、`bit.ly가.com/…`、`bit.ly点日本.中国/…` 和 `bit.ly点日本.evil.com/…` 各是一条。`example.com点.bit.ly/…` 和 `bit.ly点日本.bit.ly/…` 收成 `x` 之后仍以 `.bit.ly` 结尾。`bit.ly点日本.notarealtld/…` 只打开 `bit.ly`。带协议的同一串仍是一条。见 ADR 0220。

隐藏的分享 `text` 在点号前面把标签字丢掉。`bit.ly点日本.com/…` 被拆成 `bit.ly`。

## 决策

- 分享 `text`、私聊预填 `tg://msg` 的 `text` 和用户名草稿的 `text`，在写完的裸主机名或点分 IPv4 后面遇到一段 Android 标签字时，后面是点号加 ASCII 标签和 Android 的严格顶级域，就留给主机名扫描，收成 `x`。
- 点号后面不是严格域名时，仍在第一个标签字前结束。`bit.ly点日本.notarealtld` 仍按 `bit.ly` 删除。
- 点号后面的标签含 Android 标签字时，这一轮仍切开。`bit.ly点.日本.com` 仍按 `bit.ly` 删除。
- 前面没有 ASCII 的标签字仍切开。`点日本.bit.ly` 仍按短链删除。
- 带协议的同一串仍是一条。
- 不改带协议网址的整段匹配。闭合分享链接里的网址不走这道切开。公开的折叠不改。
- 证据只留主机名。路径不进证据。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 点号后面一律留下 | `bit.ly点日本.notarealtld` 会把已经打开的短链粘没。 |
| 点号后面的非 ASCII 标签也收成 `x` | `bit.ly点.日本.com` 是下一条规则。这一轮先对齐只认 ASCII 标签的扫描。 |
| 只改检测器分词 | 分享 `text` 在扫描之前已经把标签字丢掉。 |

## 后果

- `t.me/share/url?text=bit.ly点日本.com/…`、`www.bit.ly点日本.com/…`、`t.co点日本.com/…`、`203.0.113.10点日本.com/…`、`bit.ly가.com/…`、`bit.ly点日本.中国/…`、`bit.ly点日本.evil.com/…` 和 `http://bit.ly点日本.com/…` 留着。路径不进证据。
- `bit.ly点日本.notarealtld/…` 按短链删除。证据是 `bit.ly`。
- `example.com点.bit.ly/…` 按短链删除。证据是 `example.comx.bit.ly`。`bit.ly点日本.bit.ly/…` 按短链删除。证据是 `bit.lyx.bit.ly`。
- `点日本.bit.ly/…` 仍按短链删除。证据是 `bit.ly`。
- 点号后面的标签可以是 Android 标签字。`bit.ly点.日本.com` 仍按短链删除。见 ADR 0221。
