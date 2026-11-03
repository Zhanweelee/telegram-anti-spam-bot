# ADR 0261：webproxy 用户名仍读 text，网页代理仍读 server

- 状态：已接受
- 日期：2026-11-03

## 背景

桌面端把 `webproxy` 或 `webproxy/` 后面紧跟的查询收成 `tg://webproxy`。网页代理只读取 `server`，不把 `text` 放进输入框。`webproxy/短名` 和 `webproxy/数字` 对不上这道式子，落到用户名式子并写草稿。

Android 没有单独的 `webproxy/` 路径。裸的 `t.me/webproxy`、末尾斜杠、短名和数字都按用户名读取 `text`。对方是用户时，这段字进入输入框。

`webproxy.t.me` 没有路径时，桌面端改写后的结果是 `tg://webproxy`，不是 `tg://resolve`，于是留在原来的地址。Android 仍按用户名写草稿。后面是数字时，两边都改写成帖子。后面是短名时对不上这道改写。

`t.me/webproxy` 和 `tg://webproxy` 上的 `server` 已由 ADR 0134 只留主机名。没有 `server` 或 `server` 为空时改读 `host`。短名路径不是网页代理命令。

## 决策

- 把 `webproxy` 从保留用户名里拿掉。`getpremium`、`s` 和 `telegrampassport` 仍留着。
- `t.me`、`telegram.me`、`telegram.dog` 以及一层 `www.` 上，`webproxy`、末尾斜杠、后面的短名或数字，都从 `text` 抽主机名。大写 `WebProxy` 同样读。
- `webproxy.t.me` 没有路径时读。后面是数字时读。后面是短名时不读。
- 再多一段路径不读。
- `tg://resolve?domain=webproxy` 仍读。`tg://webproxy` 仍只认 `server` 和空 `server` 时的 `host`，不读 `text`。
- 路径正好是 `/webproxy` 时仍从 `server` 抽主机名。`server` 为空时仍改读 `host`。短名路径上的 `server` 不读。
- 这个主机名走现有的裸 IP、短链、邀请和 denylist 判断。只拆一层。`text` 不进入正文，也不参与关键词。
- 用户名、应用名和 `secret` 不进证据。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 继续把 `webproxy` 放进保留名 | `t.me/webproxy/短名?text=` 会漏掉。两边都把它当成用户名。 |
| 没有短名的小写命令不读 | Android 没有网页代理路径分支，裸命令仍写聊天草稿。 |
| 短名路径上的 `server` 也读 | 那不是网页代理命令。桌面端把它收成应用名。 |
| `tg://webproxy` 的 `text` 也读 | 网页代理命令不写聊天草稿。 |
| 子域上的短名也读 | `webproxy.t.me/短名` 对不上桌面端子域改写。 |
| 同一轮拿掉 `getpremium` | 桌面端和 Android 都整段吃掉这条命令，不写聊天草稿。 |

## 后果

- `t.me/webproxy/slug228`、`t.me/webproxy`、`t.me/webproxy/`、`t.me/webproxy/5`、`t.me/WebProxy/slug.228`、`webproxy.t.me`、`webproxy.t.me/数字` 和 `tg://resolve?domain=webproxy` 的 `text` 是裸 IP、默认短链或邀请时删除。证据仍只有主机名。
- `t.me/webproxy?server=` 仍按网页代理删除。`server` 为空时仍读 `host`。`secret` 不进证据。`t.me/webproxy/短名?server=` 不读 `server`。
- `tg://webproxy` 的 `text` 仍不读。
- `t.me/webproxy/短名/再一段` 和 `webproxy.t.me/短名` 留着。
- `t.me/getpremium/短名` 仍不读 `text`。
