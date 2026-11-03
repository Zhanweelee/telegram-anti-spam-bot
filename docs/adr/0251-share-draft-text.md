# ADR 0251：share 用户名仍读 text，应用名也读

- 状态：已接受
- 日期：2026-11-03

## 背景

桌面端只把 `share/url?` 收成 `tg://msg_url`。`share`、`share/短名` 和 `share/数字` 都落到用户名式子，普通用户仍写草稿。末尾斜杠也落在这个式子里。Android 只在路径以小写 `share/` 开头时打开分享，并把 `text` 放进分享内容。裸的 `share` 仍按用户名读取 `text`。`Share/短名` 对不上这道小写斜杠，也按用户名写草稿。

`t.me/share` 和 `t.me/share/url` 仍是分享链接。`t.me/share/短名?url=` 不是这两种写法，查询里的 `url` 不读。`share.t.me/url` 仍按 ADR 0149 读取。`share.t.me/短名` 仍不读。`tg://share` 仍按分享链接读取。

## 决策

- 把 `share` 从保留用户名里拿掉。
- `t.me`、`telegram.me`、`telegram.dog` 以及一层 `www.` 上，`share`、后面一段应用名、后面一段数字，以及末尾斜杠，都从 `text` 抽主机名。
- `share.t.me` 没有路径或后面是数字时同样读。后面是短名时不读。
- 再多一段路径不读。
- `tg://resolve?domain=share` 仍读。
- 应用名路径上的 `url` 仍不读。`t.me/share` 和 `t.me/share/url` 仍走分享链接。
- 这个主机名走现有的裸 IP、短链、邀请和 denylist 判断。只拆一层。`text` 不进入正文，也不参与关键词。
- 用户名和应用名不进证据。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 继续把 `share` 放进保留名 | `t.me/share/短名?text=` 会漏掉。桌面端把它当成应用名。 |
| `share/短名` 不读 | Android 把 `text` 放进分享。桌面端仍收成应用名并写草稿。 |
| 连 `t.me/share/短名?url=` 一起读 | ADR 0133 只认 `/share` 和 `/share/url`。 |
| 连 `share.t.me/短名` 一起读 | 桌面端子域改写丢掉这段非数字路径。ADR 0149 仍不读它。 |

## 后果

- `t.me/share`、`t.me/share/`、`share.t.me`、`tg://resolve?domain=share`、`t.me/Share/短名`、`t.me/share/slug218`、`t.me/share/5` 和 `share.t.me/数字` 的 `text` 是裸 IP、默认短链或邀请时删除。证据仍只有主机名。
- `t.me/share/短名/再一段` 和 `share.t.me/短名` 留着。
- `t.me/share/短名?url=` 仍按外层主机名判断。`t.me/share/url` 仍读 `url`。
- 用户名和应用名不进证据。
