# ADR 0308：写完的草稿主机名后面接不上严格域名时不再把标签字收成 x

- 状态：已接受
- 日期：2026-11-03

## 背景

Android 在写完的主机名后面遇到标签字时，后面是严格域名就整段留在主机名里，否则在标签字前面停住。`bit.ly点evil.com/…`、`bit.ly点free.com/…` 和 `bit.ly点free.中国/…` 各是一条主机名。`bit.ly点free/…`、`bit.ly가free/…` 和 `bit.ly点free.notarealtld/…` 只打开 `bit.ly`。`bit.ly点203.0.113.10/…` 还另外打开这条裸 IP。见 ADR 0219。

隐藏的分享 `text` 把第一个标签字丢掉。`bit.ly点evil.com/…` 被拆成 `bit.ly` 和 `evil.com`。

## 决策

- 分享 `text`、私聊预填 `tg://msg` 的 `text` 和用户名草稿的 `text`，在写完的裸主机名或点分 IPv4 后面遇到一段 Android 标签字时，后面是 Android 的严格域名就留给主机名扫描，收成 `x`。
- 后面接不上严格域名时，仍在第一个标签字前结束。`bit.ly点free` 仍按 `bit.ly` 删除。后面的裸 IP 仍单独打开。
- 带协议的同一串仍是一条。
- 不改带协议网址的整段匹配。闭合分享链接里的网址不走这道切开。公开的折叠不改。
- 证据只留主机名。路径不进证据。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 标签字一律留下 | `bit.ly点free` 会收成 `bit.lyxfree`。Android 只打开 `bit.ly`。 |
| 标签字一律切开 | `bit.ly点evil.com` 会删掉 Android 留成一条主机名的消息。 |
| 只改检测器分词 | 分享 `text` 在扫描之前已经把标签字丢掉。 |

## 后果

- `t.me/share/url?text=bit.ly点free/…`、`bit.ly가free/…`、`bit.ly点free.notarealtld/…` 和 `t.co点hello/…` 按短链删除。证据是前面的短链。路径不进证据。
- `bit.ly点203.0.113.10/…` 按短链和裸 IP 删除。`example.com点203.0.113.10/…` 按裸 IP 删除。证据是 `203.0.113.10`。
- `bit.ly点evil.com/…`、`bit.ly点free.com/…`、`bit.ly点free.中国/…` 和 `203.0.113.10点bit.ly/…` 留着。
- `http://bit.ly点free/…` 和 `http://bit.ly点203.0.113.10/…` 仍是一条，不另开。
- 点号后面仍是严格域名时，夹在中间的标签字收成 `x`。见 ADR 0220。
