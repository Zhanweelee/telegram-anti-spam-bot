# ADR 0306：写完的草稿主机名和后面的域名之间的句号收成一个点

- 状态：已接受
- 日期：2026-11-03

## 背景

Android 把句号 `。` 算进标签。`bit.ly。evil.com/…`、`www.bit.ly。evil.com/…`、`bit.ly。。evil.com/…` 和 `203.0.113.10。evil.com/…` 各是一条主机名。地址解析器给出的主机名是 `bit.ly.evil.com` 这一类，不是前面的短链或裸 IP。`example.com。bit.ly/…` 连起来仍以 `.bit.ly` 结尾。`bit.ly。/…` 在斜杠前停住，只打开 `bit.ly`。`bit。ly/…` 没有写成完整主机名。带协议的 `http://bit.ly。evil.com/…` 已经是一条。见 ADR 0216。

隐藏的分享 `text` 把这个句号当成标签字丢掉。`bit.ly。evil.com/…` 被拆成 `bit.ly` 和 `evil.com`。

## 决策

- 分享 `text`、私聊预填 `tg://msg` 的 `text` 和用户名草稿的 `text`，在写完的裸主机名或点分 IPv4 后面遇到句号 `。` 时，把这一段留给主机名扫描。
- 后面还有域名时，一段句号收成一个 ASCII 点。`bit.ly。evil.com` 留着。`example.com。bit.ly` 仍是短链。
- 斜杠、路径和字符串结尾仍只打开前面的主机名。`bit。ly` 仍不打开。
- 带协议的同一串仍是一条。
- 不改带协议网址的整段匹配。闭合分享链接里的网址不走这道切开。
- 证据只留主机名。路径不进证据。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 句号后面一律切开 | `bit.ly。evil.com` 会删掉 Android 留成一条主机名的消息。 |
| 任何句号都收成点 | `bit。ly` 会变成短链。Android 并不打开它。 |
| 只改检测器分词 | 分享 `text` 在扫描之前已经把句号丢掉。 |

## 后果

- `t.me/share/url?text=bit.ly。evil.com/…`、`www.bit.ly。evil.com/…`、`bit.ly。。evil.com/…`、`203.0.113.10。evil.com/…`、`bit。ly/…`、`http://bit.ly。evil.com/…` 和 `http://www.bit.ly。evil.com/…` 留着。路径不进证据。
- `example.com。bit.ly/…` 按短链删除。证据是 `example.com.bit.ly`。
- `203.0.113.10。bit.ly/…` 按短链删除。证据是 `203.0.113.10.bit.ly`，不是那条裸 IP。
- `bit.ly。/…` 和 `http://bit.ly。/…` 按短链删除。证据是 `bit.ly`。
- 写完的主机名和后面的域名之间的点状间隔号仍可能再打开前面的短链。见 ADR 0217。
