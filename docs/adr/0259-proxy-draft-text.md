# ADR 0259：proxy 用户名仍读 text，代理命令仍读 server

- 状态：已接受
- 日期：2026-11-03

## 背景

桌面端把 `proxy` 或 `proxy/` 后面紧跟的查询收成 `tg://proxy`。代理设置只读取 `server`，不把 `text` 放进输入框。`proxy/短名` 和 `proxy/数字` 对不上这道式子，落到用户名式子并写草稿。

Android 没有单独的 `proxy/` 路径。裸的 `t.me/proxy`、末尾斜杠、短名和数字都按用户名读取 `text`。对方是用户时，这段字进入输入框。

`proxy.t.me` 没有路径时，桌面端改写后的结果是 `tg://proxy`，不是 `tg://resolve`，于是留在原来的地址。Android 仍按用户名写草稿。后面是数字时，两边都改写成帖子。后面是短名时对不上这道改写。

`t.me/proxy`、`t.me/socks` 和 `tg://proxy` 上的 `server` 已由 ADR 0129 只留主机名。短名路径不是代理命令。

## 决策

- 把 `proxy` 从保留用户名里拿掉。`socks`、`webproxy`、`getpremium`、`s` 和 `telegrampassport` 仍留着。
- `t.me`、`telegram.me`、`telegram.dog` 以及一层 `www.` 上，`proxy`、末尾斜杠、后面的短名或数字，都从 `text` 抽主机名。大写 `Proxy` 同样读。
- `proxy.t.me` 没有路径时读。后面是数字时读。后面是短名时不读。
- 再多一段路径不读。
- `tg://resolve?domain=proxy` 仍读。`tg://proxy` 仍只认 `server`，不读 `text`。
- 路径正好是 `/proxy` 时仍从 `server` 抽主机名。短名路径上的 `server` 不读。
- 这个主机名走现有的裸 IP、短链、邀请和 denylist 判断。只拆一层。`text` 不进入正文，也不参与关键词。
- 用户名、应用名、`secret`、端口、用户名和密码不进证据。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 继续把 `proxy` 放进保留名 | `t.me/proxy/短名?text=` 会漏掉。两边都把它当成用户名。 |
| 没有短名的小写命令不读 | Android 没有代理路径分支，裸命令仍写聊天草稿。 |
| 短名路径上的 `server` 也读 | 那不是代理命令。桌面端把它收成应用名。 |
| `tg://proxy` 的 `text` 也读 | 代理命令不写聊天草稿。 |
| 子域上的短名也读 | `proxy.t.me/短名` 对不上桌面端子域改写。 |
| 同一轮拿掉 `socks` 和 `webproxy` | 三条命令分开核对。 |

## 后果

- `t.me/proxy/slug226`、`t.me/proxy`、`t.me/proxy/`、`t.me/proxy/5`、`t.me/Proxy/slug.226`、`proxy.t.me`、`proxy.t.me/数字` 和 `tg://resolve?domain=proxy` 的 `text` 是裸 IP、默认短链或邀请时删除。证据仍只有主机名。
- `t.me/proxy?server=` 仍按代理命令删除。`secret` 不进证据。`t.me/proxy/短名?server=` 不读 `server`。
- `tg://proxy` 的 `text` 仍不读。
- `t.me/proxy/短名/再一段` 和 `proxy.t.me/短名` 留着。
- `s.t.me/proxy` 和 `tg://resolve?domain=s&appname=proxy` 不再因保留名跳过。
- `t.me/socks/短名` 仍不读 `text`。
