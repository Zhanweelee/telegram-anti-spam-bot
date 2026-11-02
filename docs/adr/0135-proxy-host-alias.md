# ADR 0135：代理链接的 host 只留主机名

- 状态：已接受
- 日期：2026-11-02

## 背景

Android 客户端解析 `t.me/proxy`、`t.me/socks`、`t.me/webproxy` 以及对应的 `tg:` 命令时，地址先读 `server`。没有这个参数时改读 `host`。生成出来的链接仍写 `server`。短链和裸 IP 可以只写在 `host` 上，外层主机名仍是 `t.me`。

`server=` 存在但为空时，客户端不改读 `host`。名叫 `proxy` 的查询参数不是这个地址。

## 决策

- 在 ADR 0129 和 ADR 0134 已经认出的代理链接上，`server` 缺省时从 `host` 抽出主机名。已有 `server` 时不读 `host`，包括 `server` 为空的情况。
- 这个主机名走现有的裸 IP、短链和 denylist 判断。路径、折叠、长度和 8 个主机名的上限不变。
- `secret`、端口、用户名、密码和 `host` 里的路径不进证据，也不进隐藏链接的事件字段。不把 `host` 记成邀请。
- 其它网站路径里的 `host` 不读。`t.me/web` 不读。名叫 `proxy` 的查询参数不读。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| `host` 整段都不读 | 裸 IP 和短链可以只写在这个参数上。 |
| 空的 `server` 也改读 `host` | 客户端在参数存在时不改读。 |
| 连名叫 `proxy` 的参数一起读 | 官方链接和桌面端写的是 `server`。 |

## 后果

- 代理链接的 `host` 是裸 IP 或默认短链，且没有 `server` 时，现有链接规则删除这条消息。证据仍只有主机名。
- `proxy.example.com` 留着。`example.com/proxy?host=` 和 `t.me/web?host=` 仍按外层主机名判断。
- 正文就是这条链接时，链接原文仍在 `message.text`。按钮和隐藏链接只留下主机名。
- 网页代理上长度为 0 的 `server` 后来由 ADR 0136 改读 `host`。SOCKS、MTProto 和只含空白的 `server` 仍不改读。
