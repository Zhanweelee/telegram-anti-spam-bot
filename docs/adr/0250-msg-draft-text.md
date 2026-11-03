# ADR 0250：msg 用户名仍读 text，应用名也读

- 状态：已接受
- 日期：2026-11-03

## 背景

桌面端的 `t.me` 转换没有单独的 `msg/` 规则。`msg`、`msg/短名` 和 `msg/数字` 都落到用户名式子，普通用户仍写草稿。末尾斜杠也落在这个式子里。Android 只在路径以小写 `msg/` 开头时打开分享，裸的 `msg` 仍按用户名读取 `text`。`Msg/短名` 对不上这道小写斜杠，也按用户名写草稿。

`t.me/msg/url` 仍是分享链接。`t.me/msg?url=` 仍是用户名，查询里的 `url` 不读。`tg://msg` 仍按 ADR 0131 和 ADR 0133 读取。

## 决策

- 把 `msg` 从保留用户名里拿掉。
- `t.me`、`telegram.me`、`telegram.dog` 以及一层 `www.` 上，`msg`、后面一段应用名、后面一段数字，以及末尾斜杠，都从 `text` 抽主机名。
- `msg.t.me` 没有路径或后面是数字时同样读。后面是短名时不读。
- 再多一段路径不读。
- `tg://resolve?domain=msg` 仍读。
- 用户名上的 `url` 仍不读。`t.me/msg/url` 仍走分享链接。
- 这个主机名走现有的裸 IP、短链、邀请和 denylist 判断。只拆一层。`text` 不进入正文，也不参与关键词。
- 用户名和应用名不进证据。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 继续把 `msg` 放进保留名 | `t.me/msg?text=` 会漏掉。桌面端把它当成用户名。 |
| `msg/短名` 不读 | Android 打开分享。桌面端仍收成应用名并写草稿。 |
| 连 `t.me/msg?url=` 一起读 | ADR 0133 已把它和 `t.me/msg/url` 分开。 |

## 后果

- `t.me/msg`、`t.me/msg/`、`msg.t.me`、`tg://resolve?domain=msg`、`t.me/Msg/短名`、`t.me/msg/slug217`、`t.me/msg/5` 和 `msg.t.me/数字` 的 `text` 是裸 IP、默认短链或邀请时删除。证据仍只有主机名。
- `t.me/msg/短名/再一段` 和 `msg.t.me/短名` 留着。
- `t.me/msg?url=` 仍按外层主机名判断。
- 用户名和应用名不进证据。
