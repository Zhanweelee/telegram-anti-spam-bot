# ADR 0249：web 用户名仍读 text，应用名也读

- 状态：已接受
- 日期：2026-11-03

## 背景

桌面端的 `t.me` 转换没有单独的 `web/` 规则。`web`、`web/短名` 和 `web/数字` 都落到用户名式子，普通用户仍写草稿。末尾斜杠也落在这个式子里。Android `LaunchActivity` 同样把这段路径当成用户名，并读取 `text`。`LinkManager` 不处理 `web`。

`t.me/web?server=` 仍不是网页代理。代理只认 `/webproxy`。`server` 不因这次改动进入证据。

`tg://web` 不是这次要读的查询。

## 决策

- 把 `web` 从保留用户名里拿掉。`webproxy` 仍留在保留名里。
- `t.me`、`telegram.me`、`telegram.dog` 以及一层 `www.` 上，`web`、后面一段应用名、后面一段数字，以及末尾斜杠，都从 `text` 抽主机名。
- `web.t.me` 没有路径或后面是数字时同样读。后面是短名时不读。
- 再多一段路径不读。
- `tg://resolve?domain=web` 仍读。
- 这个主机名走现有的裸 IP、短链、邀请和 denylist 判断。只拆一层。`text` 不进入正文，也不参与关键词。
- `t.me/web` 上的 `server` 和 `host` 仍不按代理读取。
- 用户名和应用名不进证据。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 继续把 `web` 放进保留名 | `t.me/web?text=` 会漏掉。两边都把它当成用户名。 |
| 把 `t.me/web?server=` 当成网页代理 | ADR 0134 已把 `web` 和 `webproxy` 分开。 |
| 子域上的短名也读 | `web.t.me/短名` 对不上桌面端子域改写。 |

## 后果

- `t.me/web`、`t.me/web/`、`web.t.me`、`tg://resolve?domain=web`、`t.me/Web/短名`、`t.me/web/slug216`、`t.me/web/5` 和 `web.t.me/数字` 的 `text` 是裸 IP、默认短链或邀请时删除。证据仍只有主机名。
- `t.me/web/短名/再一段` 和 `web.t.me/短名` 留着。
- `t.me/web?server=` 仍按外层主机名判断。`text` 里的主机名另外读取。
- 用户名和应用名不进证据。
