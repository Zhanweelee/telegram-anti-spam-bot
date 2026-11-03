# ADR 0134：网页代理链接的 server 只留主机名

- 状态：已接受
- 日期：2026-11-02

## 背景

Telegram Desktop 的网页代理用 `https://t.me/webproxy` 和 `tg://webproxy` 分享。要连的主机在 `server` 里，可以带一段路径。外层主机名是 `t.me`，`/webproxy` 不是邀请路径。链接规则现在只认 `/proxy` 和 `/socks`，裸 IP 和短链可以只写在网页代理的 `server` 上。

`secret` 是连接材料。`t.me/web` 是另一条保留路径，不是网页代理。

## 决策

- 在 ADR 0129 的范围上增加：`t.me`、`telegram.me`、`telegram.dog` 及其子域上恰好为 `/webproxy` 的路径，以及 `tg://webproxy` 和 `tg:webproxy`。仍只从 `server` 抽出主机名。
- 这个主机名走现有的裸 IP、短链和 denylist 判断。路径、折叠、长度和 8 个主机名的上限不变。
- `secret` 和 `server` 里的路径不进证据，也不进隐藏链接的事件字段。不把 `server` 记成邀请。
- 其它网站路径里的 `server` 不读。`t.me/web` 和其它 `tg:` 命令不读。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 网页代理整段都不读 | 裸 IP 和短链可以只写在 `server` 上。 |
| 连 `t.me/web` 一起读 | 那是另一条保留路径，不是网页代理。 |
| 把 `secret` 放进证据 | 连接材料和原文默认不落盘冲突。 |

## 后果

- 网页代理的 `server` 是裸 IP 或默认短链时，现有链接规则删除这条消息。证据仍只有主机名。
- `proxy.example.com` 留着。`example.com/webproxy?server=` 和 `t.me/web?server=` 仍按外层主机名判断。
- `t.me/web?text=` 后来由 ADR 0249 按用户名读取。`server` 仍不是网页代理。
- 正文就是这条链接时，链接原文仍在 `message.text`。按钮和隐藏链接只留下主机名。
- 没有 `server` 时的 `host` 后来由 ADR 0135 只留下主机名。长度为 0 的 `server` 后来由 ADR 0136 改读 `host`。
