# ADR 0137：用户名链接的 text 只留主机名

- 状态：已接受
- 日期：2026-11-02

## 背景

ADR 0131 读了 `tg://msg` 的 `text`，并认为公开用户名 `t.me/durov?text=` 不是这条预填。

Android 在打开用户对话时把这个 `text` 放进 `start_text`。桌面端把它放进 `PeerByLinkInfo.text`。`t.me/用户名`、`t.me/s/用户名`、`tg://resolve?domain=` 和 `tg://resolve?phone=` 都会带上这段字。外层仍是公开用户名，短链、裸 IP 和邀请可以只写在 `text` 里。

帖子路径 `t.me/用户名/123`、代理和分享命令、以及 `telegrampassport` 不把 `text` 放进私聊输入框。

## 决策

- 在 `t.me`、`telegram.me`、`telegram.dog` 及其子域名上，路径只有一个公开用户名，或是 `s/` 再加一个公开用户名时，从 `text` 抽出主机名。
- `tg://resolve` 和 `tg:resolve` 在 `domain` 是公开用户名，或没有 `domain` 但 `phone` 是号码时，同样从 `text` 抽出主机名。
- 这个主机名走现有的裸 IP、短链、邀请和 denylist 判断。只拆一层。`text` 不进入正文，也不参与关键词。
- 用户名、号码、路径和查询里的其它参数不进证据。
- 帖子、故事和其它多段路径不读。保留的命令名不读，包括 `proxy`、`share`、`msg` 和 `telegrampassport`。
- 其它网站的 `text` 参数不读。`tg://search` 不读。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 公开用户名上的 `text` 继续不读 | 点开会把短链放进私聊输入框。 |
| 任何路径的 `text` 都读 | 帖子链接和代理命令不会把这段字放进输入框。 |
| 把用户名或号码记进证据 | 证据仍然只该有主机名。 |

## 后果

- 这些链接的 `text` 是裸 IP、默认短链或邀请时，现有链接规则删除这条消息。证据仍只有主机名。
- `example.com` 留着。没有 `text` 的 `t.me/durov` 和 `tg://resolve?domain=durov` 仍放行。
- 正文就是这条链接时，链接原文仍在 `message.text`。按钮和隐藏链接只留下主机名。
- `https://t.me/+` 后全是数字的写法后来由 ADR 0138 改成同一条电话预填。带字母的加号路径仍不读 `text`。
- 一段数字的 `t.me/用户名/123` 和 `用户名.t.me` 后来由 ADR 0139 读取 `text`。用户名后再加一段应用名后来由 ADR 0146 读取 `text`。讨论串、子域上的应用名和 Passport 的 `text` 仍不读。
- `domain` 和 `phone` 后来由 ADR 0140 不区分大小写，取第一次出现的值。Passport 仍不读 `text`。
- Passport 的 `callback_url` 后来由 ADR 0145 只留主机名。`nonce`、公钥和路径仍不进证据。
- `tg://resolve?domain=s&appname=` 后来由 ADR 0148 改写成用户名后再读 `text`。`domain` 必须正好是小写 `s`。
- 其它子域上的单段路径后来由 ADR 0146 不再读取。精确主机和一层 `www.` 上的单段公开用户名仍读。
- `proxy` 后来由 ADR 0259 从保留名里拿掉。`t.me/proxy` 和 `t.me/proxy/短名` 的 `text` 会读。`socks` 和 `webproxy` 仍不读 `text`。
