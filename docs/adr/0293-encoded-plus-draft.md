# ADR 0293：编码加号贴在草稿主机名前面时留下十六进制

- 状态：已接受
- 日期：2026-11-03

## 背景

Android 不会在匹配前把 `%2B` 收成加号。`%2Bbit.ly/…` 打开的是 `2bbit.ly`，不是 `bit.ly`。`example.com%2Bbit.ly/…` 和 `http://example.com%2Bbit.ly/…` 同样不会打开 `bit.ly`。`example.com%2Bt.co/…` 打开的是 `2bt.co`。`%2Bexample.com/bit.ly/…` 整段的主机名是 `2bexample.com`。

`%2Bwww.bit.ly/…` 和 `example.com%2Bwww.bit.ly/…` 打开的是 `2bwww.bit.ly`。这个主机名仍以 `.bit.ly` 结尾。

真正的加号仍然会拆开。换行、空格、制表符或斜杠隔在 `%2B` 和主机名之间时，后面的短链也会打开。`t.me/%2B…` 和 `t.me%2F%2B…` 仍是邀请。紧挨协议的 `%2B` 仍不另开。`203.0.113.164%2Bbit.ly/…` 仍是裸 IP。`example.com%2B203.0.113.165` 不打开这个地址。

看得见的正文已经这样切。隐藏的分享 `text` 先把这段主机名的最后一段收成 `arpa`，`2bwww.bit.ly` 不再以 `.bit.ly` 结尾。见 ADR 0197。

## 决策

- 分享 `text`、私聊预填 `tg://msg` 的 `text` 和用户名草稿的 `text`，不在路径里、也不紧挨 `http://` 或 `https://` 的 `%2B`，后面已经是字面点分开的主机名或点分 IPv4 时，百分号改成空格，两位十六进制留下。
- 路径里的 `%2B`、`%2F%2B` 和紧挨协议的 `%2B` 仍按原规则。`%252B` 仍保留。
- 换行、空格、制表符或斜杠隔开的 `%2B` 仍打开后面的主机名。
- 证据只留主机名。路径不进证据。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 继续把最后一段收成 `arpa` | `2bwww.bit.ly` 不再以 `.bit.ly` 结尾，短链会漏掉。 |
| 删掉百分号并把十六进制粘在前一个主机名上 | `example.com%2Bwww.bit.ly` 会收成 `example.com2bwww.bit.ly`，证据不再是 `2bwww.bit.ly`。 |
| `%2B` 一律改成空格 | `t.me/%2B…` 会漏掉，`%2Bhttp://bit.ly` 也会单独打开。 |

## 后果

- `t.me/share/url?text=%2Bbit.ly/…` 和 `example.com%2Bbit.ly/…` 留着。`example.com%2Bt.co/…` 留着。`%2Bexample.com/bit.ly/…` 留着。
- `example.com%2Bwww.bit.ly/…` 按短链删除。证据是 `2bwww.bit.ly`。路径不进证据。
- `example.com+bit.ly/…`，以及换行、空格、制表符或斜杠隔开的 `%2B`，仍按短链删除。`t.me/%2B…` 仍按邀请删除。
- `203.0.113.164%2Bbit.ly/…` 仍按裸 IP 删除。证据是这个地址。`example.com%2B203.0.113.165` 留着。
- 贴在 `www.bit.ly` 前面的 `%2F` 仍把主机名收成 `arpa`，短链不再以 `.bit.ly` 结尾。见 ADR 0294。
