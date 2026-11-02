# ADR 0133：其余分享链接写法只留主机名

- 状态：已接受
- 日期：2026-11-02

## 背景

ADR 0130 读了 `t.me/share/url`、`t.me/iv` 和 `tg://msg_url` 的 `url`。Telegram 的深链说明还列出另外几种同样会打开分享的写法：`t.me/share?url=`、`t.me/msg/url?url=`，以及客户端里的 `tg://share` 和 `tg://iv`。`tg://msg` 除了 `text` 也可以带 `url`，点开后同样进入分享。这些外层仍是 `t.me` 或没有主机名，短链、裸 IP 和邀请可以只写在 `url` 上。

`t.me/msg?url=` 是用户名 `msg`，不是 `t.me/msg/url`。`t.me/share/other` 和其它网站的 `share` 也不是这几种写法。

## 决策

- 在 ADR 0130 的范围上增加：`t.me`、`telegram.me`、`telegram.dog` 及其子域上恰好为 `/share` 或 `/msg/url` 的路径，以及 `tg://share`、`tg:share`、`tg://iv` 和 `tg:iv`。仍只从 `url` 抽出一条链接，并按原规则读同一条上的 `text`。
- `tg://msg` 和 `tg:msg` 额外读取 `url`，规则与分享链接的 `url` 相同。`text` 仍按 ADR 0131。`to` 仍不读。
- 只拆一层。用户名上的 `url`、其它路径、`rhash` 和其它网站的查询参数不读。
- `text` 不进入 `message.text`，也不参与关键词。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 只认 `/share/url` | `t.me/share?url=` 是文档里的第一种写法，短链可以只写在这里。 |
| 任何 `t.me/名字?url=` 都读 | 公开用户名不是分享链接。 |
| 连 `to` 一起读 | 收件人用户名不是要打开的地址。 |

## 后果

- 这些写法的 `url` 是裸 IP、默认短链或邀请时，现有链接规则删除这条消息。证据仍只有主机名。
- `example.com` 留着。`t.me/msg?url=`、`t.me/share/other` 和其它网站的 `url` 仍按外层主机名判断。
- 附带句子里的关键词留着。正文就是这条链接时，链接原文仍在 `message.text`。
- 再套一层分享链接仍停在外层。`rhash` 和收件人用户名不进证据。
- 网页代理链接的 `server` 后来由 ADR 0134 只留下主机名。`secret` 和路径仍不进证据。
- `share.t.me/url` 和 `msg.t.me/url` 后来由 ADR 0149 按这两条分享链接读取。`share.t.me/other` 仍不读。
