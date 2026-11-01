# ADR 0129：Telegram 代理链接的 server 只留主机名

- 状态：已接受
- 日期：2026-11-02

## 背景

`https://t.me/proxy`、`https://t.me/socks`，以及 `tg://proxy` 和 `tg://socks`，把真正要连的主机放在 `server` 参数里。外层主机名是 `t.me`。`/proxy` 和 `/socks` 不是邀请路径，链接规则看到的是 `t.me`，裸 IP 和短链可以藏在参数里。

`secret`、端口、socks 的用户名和密码是连接材料。证据里只该有主机名。

ADR 0102 把其它 `tg:` 命令留在邀请和主机名之外。这条不把命令本身记成主机名，只读 `proxy` 和 `socks` 的 `server`。

## 决策

- `t.me`、`telegram.me`、`telegram.dog` 及其子域上的 `/proxy` 和 `/socks`，以及 `tg://proxy`、`tg://socks`、`tg:proxy`、`tg:socks`，从 `server` 抽出主机名。
- 这个主机名走现有的裸 IP、短链和 denylist 判断。折叠、长度和 8 个主机名的上限不变。
- 其它网站路径里的 `server` 不读。`tg://resolve` 和其它 `tg:` 命令仍不读。
- `secret`、端口、用户名、密码和路径不进证据，也不进隐藏链接的事件字段。
- 不把 `server` 记成邀请。不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 代理链接整段都不读 | 裸 IP 和短链可以只写在 `server` 上。 |
| 任何网址的 `server` 参数都读 | 普通网站的查询参数不是 Telegram 代理。 |
| 把 `secret` 放进证据 | 连接材料和原文默认不落盘冲突。 |

## 后果

- 代理或 socks 的 `server` 是裸 IP 或默认短链时，现有链接规则删除这条消息。证据仍只有主机名。
- `proxy.example.com` 留着。`example.com/proxy?server=` 仍按外层主机名判断。
- 正文就是这条链接时，链接原文仍在 `message.text`。按钮和隐藏链接只留下主机名。
