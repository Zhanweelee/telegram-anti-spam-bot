# ADR 0298：编码点贴在草稿主机名后面时留下十六进制

- 状态：已接受
- 日期：2026-11-03

## 背景

Android 不把 `%2E` 收成点。`example.com%2Ebit.ly/…` 打开的是 `2Ebit.ly`，不是 `bit.ly`。`%2Ewww.bit.ly/…` 打开的是 `2Ewww.bit.ly`。`%2E.bit.ly/…` 打开的是 `2E.bit.ly`。`http://bit.ly%2Eevil.com/…` 仍先打开 `bit.ly`，下一段从 `2E` 开始。`http://%2Ebit.ly/…` 打开的是 `2Ebit.ly`。

`%2E` 贴在 `http://` 或 `https://` 前面时什么都不打开。`bit%2Ely` 和 `t%2Eme/+…` 仍按现有规则删除。换行、空格或制表符隔开的 `%2E` 后面仍会打开短链。第二层 `%252E` 仍留下。路径里的 `%2E` 仍收成点。

看得见的正文用停住扫描把百分号当成主机名边界，十六进制留给下一段。隐藏的分享 `text` 把已经结束的主机名后面的 `%2E` 收成空格，十六进制丢掉。`example.com%2Ebit.ly` 就变成 `bit.ly`。见 ADR 0203 和 ADR 0291。

## 决策

- 分享 `text`、私聊预填 `tg://msg` 的 `text` 和用户名草稿的 `text`，已经结束的主机名或点分 IPv4 后面紧挨 `%2E`、且后面不是 `http://` 或 `https://` 时，改成空格加这两位十六进制。
- 紧挨协议的 `%2E` 仍交给粘连扫描，不另开后面的网址。
- 标签中间的 `%2E`、路径里的 `%2E`、第二层 `%252E`、换行、空格和制表符仍按原规则。
- 证据只留主机名。路径不进证据。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 继续丢掉十六进制 | `example.com%2Ebit.ly` 会另开 `bit.ly`。 |
| 已经结束的主机名后面不再切开 | `http://bit.ly%2Eevil.com` 会收成 `bit.ly2eevil.com`，漏掉短链。 |
| 只在下一段本身是短链时留下十六进制 | `2Ewww.bit.ly` 和 `2Ebit.ly` 要用同一条规则。 |

## 后果

- `t.me/share/url?text=example.com%2Ebit.ly/…`、`%2Ebit.ly/…`、`%2Ehttp://bit.ly/…` 和 `http://%2Ebit.ly/…` 留着。`%2E203.0.113.170/…` 留着。
- `%2Ewww.bit.ly/…` 和 `http://%2Ewww.bit.ly/…` 按短链删除。证据是 `2ewww.bit.ly`。`%2E.bit.ly/…` 按短链删除。证据是 `2e.bit.ly`。路径不进证据。
- `http://bit.ly%2Eevil.com/…` 和 `bit.ly%2Eevil.com/…` 仍按短链删除。证据是 `bit.ly`。`203.0.113.170%2Eevil.com/…` 仍按裸 IP 删除。`%2E.203.0.113.170/…` 按裸 IP 删除。
- `bit%2Ely`、换行、空格或制表符后面的网址仍按短链删除。`t%2Eme/+…` 仍按邀请删除。`%2E203.0.113.170/http://t.co/…` 按 `t.co` 删除。
- 第二层 `%252E` 仍留下。路径里的 `%2E` 不另开一条短链。
