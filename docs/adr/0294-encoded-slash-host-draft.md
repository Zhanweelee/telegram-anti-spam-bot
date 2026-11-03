# ADR 0294：编码斜杠贴在草稿主机名前面时留下十六进制

- 状态：已接受
- 日期：2026-11-03

## 背景

Android 不会在匹配前把 `%2F` 收成斜杠。`%2Fbit.ly/…`、`see%2Fbit.ly/…` 和 `www%2Fbit.ly/…` 打开的是 `2fbit.ly`，不是 `bit.ly`。`example.com%2Fbit.ly/…` 只打开前面的主机名。`%2Fexample.com/bit.ly/…` 整段的主机名是 `2fexample.com`。`%2F203.0.113.166/…` 不会打开这个地址。

`example.com%2Fwww.bit.ly/…` 和 `%2Fwww.bit.ly/…` 打开的是 `2fwww.bit.ly`。这个主机名仍以 `.bit.ly` 结尾。

真正的斜杠仍然会拆开。换行、空格、制表符或再写一个斜杠隔在 `%2F` 和主机名之间时，后面的短链也会打开。`http:%2F/bit.ly/…` 会打开短链。`t.me%2F+…` 仍是邀请。`https://bit.ly%2F…` 仍是短链。紧挨协议的 `%2F` 仍不另开。`https://bit.ly%2Fhttp://t.co/…` 仍停在 `bit.ly`。`203.0.113.166%2Fbit.ly/…` 仍是裸 IP。

看得见的正文已经这样切。隐藏的分享 `text` 先把这段主机名的最后一段收成 `arpa`，`2fwww.bit.ly` 不再以 `.bit.ly` 结尾。见 ADR 0198。

## 决策

- 分享 `text`、私聊预填 `tg://msg` 的 `text` 和用户名草稿的 `text`，`%2F` 后面已经是字面点分开的主机名或点分 IPv4，且后面不是字面斜杠或 `http://` / `https://` 时，百分号改成空格，两位十六进制留下。
- 紧挨协议的 `%2F`、字面斜杠隔开的 `%2F` 和 `%252F` 仍按原规则。
- 换行、空格或制表符隔开的 `%2F` 仍打开后面的主机名。
- 证据只留主机名。路径不进证据。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 继续把最后一段收成 `arpa` | `2fwww.bit.ly` 不再以 `.bit.ly` 结尾，短链会漏掉。 |
| 删掉百分号并把十六进制粘在前一个主机名上 | `example.com%2Fwww.bit.ly` 会收成 `example.com2fwww.bit.ly`，证据不再是 `2fwww.bit.ly`。 |
| `%2F` 一律改成空格 | `t.me%2F+…` 和 `https://bit.ly%2F…` 会漏掉，`%2Fhttp://bit.ly` 也会单独打开。 |

## 后果

- `t.me/share/url?text=%2Fbit.ly/…`、`example.com%2Fbit.ly/…` 和 `%2Fexample.com/bit.ly/…` 留着。`%2Fhttp://bit.ly/…` 留着。
- `example.com%2Fwww.bit.ly/…` 按短链删除。证据是 `2fwww.bit.ly`。路径不进证据。
- 换行、空格、制表符或再一条斜杠隔开的 `%2F`，以及 `http:%2F/bit.ly/…` 和 `https://bit.ly%2F…`，仍按短链删除。`t.me%2F+…` 仍按邀请删除。
- `https://bit.ly%2Fhttp://t.co/…` 仍按短链删除。证据是 `bit.ly`。
- `203.0.113.166%2Fbit.ly/…` 仍按裸 IP 删除。证据是这个地址。`%2F203.0.113.166/…` 留着。
