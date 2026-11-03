# ADR 0295：编码连字符贴在草稿主机名前面时留下十六进制

- 状态：已接受
- 日期：2026-11-03

## 背景

Android 不会在匹配前把 `%2D` 或 `%252D` 收成连字符。`%2Dbit.ly/…` 打开的是 `2dbit.ly`，不是 `bit.ly`。`%252Dbit.ly/…` 打开的是 `252dbit.ly`。`example.com%2Dbit.ly/…` 只打开前面的主机名。`%2D203.0.113.167/…` 不会打开这个地址。再套一层 `%25252Dbit.ly/…` 仍留着。

`%2Dwww.bit.ly/…` 和 `example.com%2Dwww.bit.ly/…` 打开的是 `2dwww.bit.ly`。`%252Dwww.bit.ly/…` 打开的是 `252dwww.bit.ly`。这两个主机名仍以 `.bit.ly` 结尾。

真正的连字符仍然会拆开。`-bit.ly/…` 会打开短链。换行、空格、制表符或斜杠隔在 `%2D` 和主机名之间时，后面的短链也会打开。`bit%2Dly` 仍收成 `bit-ly`，不是短链。`example.com-bit.ly/…` 仍是一整段。紧挨协议的 `%2D` 仍不另开。`203.0.113.167%2Dbit.ly/…` 仍是裸 IP。

看得见的正文已经这样切。隐藏的分享 `text` 先把这段主机名的最后一段收成 `arpa`，`2dwww.bit.ly` 不再以 `.bit.ly` 结尾。见 ADR 0199。

## 决策

- 分享 `text`、私聊预填 `tg://msg` 的 `text` 和用户名草稿的 `text`，不在路径里、也不紧挨 `http://` 或 `https://` 的 `%2D` 和 `%252D`，后面已经是字面点分开的主机名或点分 IPv4 时，百分号改成空格，十六进制留下。
- 路径是前面已经有 `/` 或 `%2F`。路径里的编码连字符、紧挨协议的 `%2D` 和再套一层的 `%25252D` 仍按原规则。`bit%2Dly` 仍收成 `bit-ly`。
- 换行、空格、制表符或斜杠隔开的 `%2D` 和 `%252D` 仍打开后面的主机名。
- 证据只留主机名。路径不进证据。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 继续把最后一段收成 `arpa` | `2dwww.bit.ly` 不再以 `.bit.ly` 结尾，短链会漏掉。 |
| 删掉百分号并把十六进制粘在前一个主机名上 | `example.com%2Dwww.bit.ly` 会收成 `example.com2dwww.bit.ly`，证据不再是 `2dwww.bit.ly`。 |
| `%2D` 一律改成空格 | `bit%2Dly` 不再收成 `bit-ly`，`%2Dhttp://bit.ly` 也会单独打开。 |

## 后果

- `t.me/share/url?text=%2Dbit.ly/…`、`%252Dbit.ly/…`、`example.com%2Dbit.ly/…` 和 `%25252Dbit.ly/…` 留着。`bit%2Dly` 和 `example.com-bit.ly/…` 留着。
- `%2Dwww.bit.ly/…` 和 `example.com%2Dwww.bit.ly/…` 按短链删除。证据是 `2dwww.bit.ly`。`%252Dwww.bit.ly/…` 按短链删除。证据是 `252dwww.bit.ly`。路径不进证据。
- `-bit.ly/…`，以及换行、空格、制表符或斜杠隔开的 `%2D`，仍按短链删除。紧挨协议的 `%2D` 不另开短链。
- `203.0.113.167%2Dbit.ly/…` 仍按裸 IP 删除。证据是这个地址。`%2D203.0.113.167/…` 留着。
- 贴在还含百分号的主机名前面时，最后一段仍收成 `arpa`，`77ww.bit.ly` 不再以 `.bit.ly` 结尾。换行后面的 `b%69t.ly` 会收成 `bit.ly`。见 ADR 0296。
