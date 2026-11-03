# ADR 0311：写完的草稿主机名和句号后面的标签字收成一个点

- 状态：已接受
- 日期：2026-11-03

## 背景

Android 在写完的主机名后面把句号或点状间隔号收成一个 ASCII 点，后面的域名可以含 Android 标签字，而且中间至少还有一个点。`bit.ly。日本.com/…`、`bit.ly。点日本.com/…`、`203.0.113.10。日本.com/…` 和 `bit.ly点日本。evil.com/…` 各是一条。`example.com。日本.bit.ly/…` 收成点之后仍以 `.bit.ly` 结尾。`bit.ly。com/…`、`bit.ly。中国/…`、`bit.ly。/` 和 `bit.ly。点日本.notarealtld/…` 只打开前面的短链。`bit.ly。com.日本/…` 也只打开 `bit.ly`。带协议的同一串仍是一条。见 ADR 0222。

隐藏的分享 `text` 只在句号后面认 ASCII 域名。`bit.ly。日本.com/…` 被拆成 `bit.ly`。

## 决策

- 分享 `text`、私聊预填 `tg://msg` 的 `text` 和用户名草稿的 `text`，在写完的裸主机名或点分 IPv4 后面遇到一段句号或点状间隔号时，后面的域名可以含 Android 标签字。最后一个标签仍是 Android 的严格顶级域，而且中间至少还有一个点。
- 后面是这种域名时，把间隔号收成一个点，并把非 ASCII 标签写成 ASCII，让整段主机名留在一次扫描里。
- 间隔号前面还有一段 Android 标签字，而且后面是这种域名时，标签字收成 `x`，间隔号收成一个点。
- 单独的顶级域、路径、空标签和接不上严格域名的尾巴仍在间隔号前结束。
- 前面没有 ASCII 的标签字不收成点。`点日本。bit.ly` 仍打开后面的短链。
- 带协议的同一串仍是一条。
- 不改带协议网址的整段匹配。闭合分享链接里的网址不走这道切开。公开的折叠不改。
- 证据只留主机名。路径不进证据。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 句号后面一律收成点 | `bit.ly。com` 和 `bit.ly。中国` 会把已经打开的短链粘没。 |
| 只把间隔号留下，不写成 ASCII | `bit.ly。日本.com` 仍会从点号后再拆出短链。 |
| 把裸网址的字符类扩到全部非 ASCII | `例子.中国` 会变成一条新的主机名。 |

## 后果

- `t.me/share/url?text=bit.ly。日本.com/…`、`www.bit.ly。日本.com/…`、`t.co。日本.com/…`、`203.0.113.10。日本.com/…`、`bit.ly。中国.com/…`、`bit.ly·点日本.com/…`、`bit.ly点日本。evil.com/…` 和 `http://bit.ly。日本.com/…` 留着。路径不进证据。
- `bit.ly。com/…`、`bit.ly。中国/…`、`bit.ly点日本。com/…`、`bit.ly。点日本.notarealtld/…`、`bit.ly。com.日本/…` 和 `bit.ly。/…` 按短链删除。证据是 `bit.ly`。
- `example.com。日本.bit.ly/…` 按短链删除。证据是 `example.com.xn--wgv71a.bit.ly`。`example.com点。日本.bit.ly/…` 按短链删除。证据是 `example.comx.xn--wgv71a.bit.ly`。
- `点日本。bit.ly/…` 仍按短链删除。证据是 `bit.ly`。
- 带协议的点状间隔号留在标签里。见 ADR 0223。
