# ADR 0136：网页代理空的 server 改读 host

- 状态：已接受
- 日期：2026-11-02

## 背景

ADR 0135 在 `server` 缺省时从 `host` 留主机名。Android 在参数存在但为空时不改读，所以空的 `server` 当时整段留下。

Telegram Desktop 的网页代理不是这样。`ProxyDataFromFields` 在类型是 WEB 时，`server` 为空就改读 `host`。SOCKS 和 MTProto 仍只用 `server`。只含空格的 `server` 不算空，桌面端拿它当地址，规范化失败后这条代理无效。

因此 `https://t.me/webproxy?server=&host=203.0.113.9` 会在桌面端弹出网页代理确认，外层主机名仍是 `t.me`。短链和裸 IP 可以只写在这个 `host` 上。

## 决策

- 只在 ADR 0134 认出的网页代理链接上，`server` 为空字符串时改读 `host`，并只留主机名。
- `server` 缺省时的行为仍按 ADR 0135。已有非空 `server` 时仍不读 `host`。
- SOCKS 和 MTProto 的空 `server` 不改读 `host`。
- 只含空白的 `server` 不改读。`secret` 和路径不进证据，也不进隐藏链接的事件字段。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 所有代理的空 `server` 都改读 | SOCKS 和 MTProto 在桌面端不读 `host`，Android 在参数存在时也不改读。 |
| 空白的 `server` 也改读 | 桌面端只把长度为 0 的 `server` 当成没有。 |
| 维持 ADR 0135，空的 `server` 一律不读 | 桌面端网页代理会连到 `host`。 |

## 后果

- 网页代理的 `server` 为空、`host` 是裸 IP 或默认短链时，现有链接规则删除这条消息。证据仍只有主机名。
- `proxy.example.com` 留着。SOCKS 和 MTProto 的空 `server` 仍不读 `host`。
- 正文就是这条链接时，链接原文仍在 `message.text`。按钮和隐藏链接只留下主机名。
