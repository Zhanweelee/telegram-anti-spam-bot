# ADR 0310：写完的草稿主机名和点号后面的标签字仍算严格域名

- 状态：已接受
- 日期：2026-11-03

## 背景

Android 在点号后面的域名里仍算 Android 标签字。`bit.ly点.日本.com/…`、`bit.ly点日.本.com/…`、`bit.ly가.가.com/…`、`203.0.113.10点.日本.com/…`、`bit.ly点.中国/…` 和 `bit.ly点.中国com/…` 各是一条。`bit.ly点.com日本/…` 在 ASCII 顶级域结束处仍留在这一条里。`bit.ly点.日本.notarealtld/…`、`bit.ly点.日本com/…`、`bit.ly点.中国日本/…` 和空标签 `bit.ly点..com/…` 只打开 `bit.ly`。`example.com点.日本.bit.ly/…` 收成 `x` 之后仍以 `.bit.ly` 结尾。带协议的同一串仍是一条。见 ADR 0221。

隐藏的分享 `text` 只认点号后面的 ASCII 标签。`bit.ly点.日本.com/…` 被拆成 `bit.ly`。

## 决策

- 分享 `text`、私聊预填 `tg://msg` 的 `text` 和用户名草稿的 `text`，在写完的裸主机名或点分 IPv4 后面遇到一段 Android 标签字时，点号后面的域名可以含 Android 标签字。最后一个标签，或词边界上已经结束的标签，仍必须是 Android 的严格顶级域。
- 后面是这种域名时，把前面的标签字收成 `x`，并把非 ASCII 标签写成 ASCII，让整段主机名留在一次扫描里。
- ASCII 顶级域紧贴非 ASCII 时结束，例如 `com日本`。非 ASCII 顶级域紧贴 ASCII 时结束，例如 `中国com`。两边都不是 ASCII 词字符时不拆开，例如 `中国日本`。
- 点号后面不是严格域名，或出现空标签时，仍在第一个标签字前结束。
- 前面没有 ASCII 的标签字不收成 `x`。`点.日本.bit.ly` 仍打开后面的短链。
- 带协议的同一串仍是一条。
- 不改带协议网址的整段匹配。闭合分享链接里的网址不走这道切开。公开的折叠不改。
- 证据只留主机名。路径不进证据。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 点号后面的非 ASCII 一律切开 | `bit.ly点.日本.com` 会删掉 Android 留成一条主机名的消息。 |
| 把裸网址的字符类扩到全部非 ASCII | `例子.中国` 会变成一条新的主机名。 |
| 见到严格顶级域的前缀就收成 `x` | `bit.ly点.中国日本` 会把已经打开的短链粘没。 |

## 后果

- `t.me/share/url?text=bit.ly点.日本.com/…`、`www.bit.ly点.日本.com/…`、`t.co点.日本.com/…`、`203.0.113.10点.日本.com/…`、`bit.ly点日.本.com/…`、`bit.ly가.가.com/…`、`bit.ly点.中国/…`、`bit.ly点.中国com/…`、`bit.ly点.com日本/…` 和 `http://bit.ly点.日本.com/…` 留着。路径不进证据。
- `bit.ly点.日本.notarealtld/…`、`bit.ly点.日本com/…`、`bit.ly点.中国日本/…` 和 `bit.ly点..com/…` 按短链删除。证据是 `bit.ly`。
- `example.com点.日本.bit.ly/…` 按短链删除。证据是 `example.comx.xn--wgv71a.bit.ly`。`bit.ly点.日本.bit.ly/…` 按短链删除。证据是 `bit.lyx.xn--wgv71a.bit.ly`。
- `点.日本.bit.ly/…` 仍按短链删除。证据是 `bit.ly`。
- 句号和点状间隔号后面的域名也可以含 Android 标签字。见 ADR 0222。
- 写完的主机名和句号后面的标签字仍可能把前面的短链单独打开。`bit.ly。日本.com` 留着。见 ADR 0311。
