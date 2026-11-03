# ADR 0292：编码斜杠后面的字面斜杠仍分开草稿网址

- 状态：已接受
- 日期：2026-11-03

## 背景

Android 不会在匹配前把 `%2F` 收成斜杠。`%2Fhttp://bit.ly/…`、`http:%2F%2Fbit.ly/…`、`http:/%2Fbit.ly/…` 和 `example.com%2Fhttp://bit.ly/…` 都不会打开后面的短链。`%252Fhttp://bit.ly/…` 同样不会。

真正的斜杠仍然会拆开。`http:%2F/bit.ly/…` 会打开后面的短链。换行、空格或再写一个斜杠隔在 `%2F` 和网址之间时，后面的短链也会打开。`t.me%2F+…` 仍是邀请。`https://bit.ly%2F…` 仍是短链。`https://bit.ly%2Fhttp://t.co/…` 仍停在 `bit.ly`。`203.0.113.163%2Fhttp://bit.ly/…` 仍是裸 IP。

看得见的正文已经这样切。隐藏的分享 `text` 先把 `%2F` 收成斜杠，`example.com%2F/http://bit.ly` 变成同一段路径，`http:%2F/bit.ly` 收成 `xbit.ly`，短链不再是 `bit.ly`。见 ADR 0196。

## 决策

- 分享 `text`、私聊预填 `tg://msg` 的 `text` 和用户名草稿的 `text`，`%2F` 后面紧挨一条字面斜杠时，先在这两段之间断开。
- 两道编码斜杠、`%2F` 紧挨协议，以及路径里的 `%2F`，仍不另开后面的网址。
- `http:%2F/…`、`https:%2F/…` 和换行、空格或斜杠隔开的 `%2F` 仍打开后面的主机名。
- 证据只留主机名。路径不进证据。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 草稿继续把 `%2F/` 收成路径 | `http:%2F/bit.ly` 会收成 `xbit.ly`，漏掉短链。 |
| `%2F` 一律改成空格 | `t.me%2F+…` 和 `https://bit.ly%2F…` 会漏掉，`%2Fhttp://bit.ly` 也会单独打开。 |
| 只改 `http:%2F/` | `example.com%2F/http://bit.ly` 仍被收进前一段。 |

## 后果

- `t.me/share/url?text=example.com%2Fhttp://bit.ly/…`、`http:%2F%2Fbit.ly/…` 和 `%2Fhttp://bit.ly/…` 留着。
- `http:%2F/bit.ly/…` 按短链删除。证据是 `bit.ly`。路径不进证据。
- 换行、空格或再一条斜杠隔开的 `%2F`，以及 `https://bit.ly%2F…`，仍按短链删除。`t.me%2F+…` 仍按邀请删除。
- `https://bit.ly%2Fhttp://t.co/…` 仍按短链删除。证据是 `bit.ly`。
- `203.0.113.163%2Fhttp://bit.ly/…` 仍按裸 IP 删除。证据是这个地址。`http:%2F/203.0.113.170/…` 也按这个地址删除。
- 不在路径里的 `%2B` 贴在 `www.bit.ly` 前面时，隐藏草稿仍把主机名收成 `arpa`，短链不再以 `.bit.ly` 结尾。见 ADR 0293。
