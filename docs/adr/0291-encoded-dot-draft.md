# ADR 0291：已经结束的草稿主机名后面不再把编码点收成点

- 状态：已接受
- 日期：2026-11-03

## 背景

Android 不会在匹配前把 `%2E` 收成点。`example.com%2Ehttp://bit.ly/…`、`www.example.com%2Ehttp://bit.ly/…` 和 `%2Ehttp://bit.ly/…` 都不会打开后面的短链。`example.com%2Ehttps://t.me/+…` 也不会打开邀请。`http://example.com%2Ehttp://bit.ly/…` 只留下前面的主机名。

真正的点仍然会拆开：`example.com.http://bit.ly/…` 会打开后面的短链。换行、空格或斜杠隔在 `%2E` 和网址之间时，后面的短链也会打开。`bit%2Ely` 仍是短链。`http://bit.ly%2E…` 仍停在 `bit.ly`。`203.0.113.159%2Ehttp://bit.ly/…` 仍是裸 IP。

看得见的正文已经这样切。隐藏的分享 `text` 先把 `%2E` 收成点，`http://bit.ly%2Eevil.example` 变成 `bit.ly2eevil.example`，短链就不再是 `bit.ly`。见 ADR 0192。

## 决策

- 分享 `text`、分享 `url`、私聊预填 `tg://msg` 的 `text` 和用户名草稿的 `text`，已经结束的主机名后面紧挨 `%2E`、且后面不是 `http://` 或 `https://` 时，主机名在这里结束。
- 紧挨协议的 `%2E` 仍不另开后面的网址。其它位置的 `%2E` 仍收成点。
- `bit%2Ely` 仍是短链。真正的点、换行、空格或斜杠隔开的 `%2E` 仍另开后面的网址。
- 证据只留主机名。路径不进证据。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 草稿继续把这段 `%2E` 收成点 | `http://bit.ly%2Eevil.example` 会收成 `bit.ly2eevil.example`，漏掉短链。 |
| `%2E` 一律不再收成点 | `bit%2Ely` 会漏掉。 |
| 紧挨协议的 `%2E` 也改成空格 | `example.com%2Ehttp://bit.ly` 会单独打开短链。 |

## 后果

- `t.me/share/url?text=example.com%2Ehttp://bit.ly/…` 留着。`%2Ehttp://bit.ly/…` 和 `http://example.com%2Ehttp://bit.ly/…` 也留着。`example.com%2Ehttps://t.me/+…` 不记成邀请。
- `http://bit.ly%2Eevil.example/…` 按短链删除。证据仍是 `bit.ly`。路径不进证据。
- `example.com.http://bit.ly/…`、换行或斜杠隔开的 `%2E`，以及 `bit%2Ely`，仍按短链删除。
- `203.0.113.159%2Ehttp://bit.ly/…` 仍按裸 IP 删除。证据是这个地址。
