# ADR 0305：写完的草稿主机名后面不再粘上单字母

- 状态：已接受
- 日期：2026-11-03

## 背景

Android 的裸主机名在最后一个标签结束。`bit.lyª/…`、`www.bit.lyª/…`、`bit.lyℹ/…`、`t.coа/…` 和 `203.0.113.10ª/…` 各自只打开写完的那一台。`bit.lyªx/…`、`bit.lyª:80/…` 和 `bit.lyａ/…` 也是。`bℹt.ly/…` 仍按映射收成 `bit.ly`。

后面还有域名时，这个字母留在同一条里。`bit.lyℹevil.com/…`、`bit.lyªevil.com/…` 和 `example.comℹbit.ly/…` 都不是短链。带协议的 `http://bit.lyª/…` 和 `https://www.bit.lyª/…` 也是一条。`bit.lyªhttp://t.co/…` 只打开 `bit.ly`。见 ADR 0215。

隐藏的分享 `text` 把 `bit.lyℹevil.com/…` 在这个字母处切开，前面的 `bit.ly` 和后面的 `evil.com` 都单独打开。

## 决策

- 分享 `text`、私聊预填 `tg://msg` 的 `text` 和用户名草稿的 `text`，在写完的裸主机名或点分 IPv4 后面遇到会映成一个 ASCII 字母的字时，后面还有域名就留在这一段。
- 这个字后面紧挨 `http://` 或 `https://` 时，不另开后面的网址。
- 后面是路径、问号、端口或单个 ASCII 字母时，仍在这个字前面结束。
- 带协议的主机名仍映射。标签中间的字母仍映射。
- 不改带协议网址的整段匹配。闭合分享链接里的网址不走这道切开。
- 证据只留主机名。路径不进证据。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 域名继续时也切开 | `bit.lyℹevil.com` 会删掉 Android 留成一条主机名的消息。 |
| 协议紧挨在后面时也另开 | `bit.lyªhttp://t.co` 会多删一条 Android 没有打开的短链。 |
| 写完之后一律映射 | `bit.lyª/…` 会变成 `bit.lya`。短链漏掉。 |

## 后果

- `t.me/share/url?text=bit.lyª/…`、`www.bit.lyª/…`、`bit.lyℹ/…`、`t.coа/…`、`goo.glª/…`、`bit.lyａ/…`、`bit.lyªx/…` 和 `bit.lyª:80/…` 按短链删除。证据是原来的主机名。`203.0.113.10ª/…` 按裸 IP 删除。`bℹt.ly/…` 仍按短链删除。路径不进证据。
- `bit.lyℹevil.com/…`、`bit.lyªevil.com/…`、`example.comℹbit.ly/…`、`http://bit.lyª/…`、`https://www.bit.lyª/…`、`http://user@bit.lyª/…`、`bаit.ly/…` 和 `notbit.lyª/…` 留着。
- `bit.lyªhttp://t.co/…` 按短链删除。证据是 `bit.ly`。`t.co` 不另开。
- 写完的主机名和后面的域名之间的句号仍可能再打开前面的短链。见 ADR 0216。
- 写完的主机名和后面的域名之间的句号仍可能把前面的短链单独打开。`bit.ly。evil.com` 留着。见 ADR 0306。
