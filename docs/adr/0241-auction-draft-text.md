# ADR 0241：拍卖短名不读 text，用户名仍读

- 状态：已接受
- 日期：2026-11-03

## 背景

Android `LaunchActivity` 在路径以小写 `auction/` 开头时打开拍卖，不把 `text` 写进输入框。命令大小写不同、或路径对不上这道斜杠时，链接继续按用户名解析，`text` 仍写进输入框。桌面端只把 `auction/` 后面符合 `[A-Za-z0-9._-]+`、并且紧接着查询或结尾的一段收成 `tg://stargift_auction`，查询里的 `text` 不会留下。短名后面的斜杠对不上这个式子，桌面端把它收成应用名或帖子，普通用户仍写草稿。连字符在这个字符集里，两边都打开拍卖。

`t.me/auction?text=`、末尾只有斜杠，以及 `auction.t.me?text=` 收成 `tg://resolve`，普通用户仍写草稿。`auction.t.me/数字` 两边都不写草稿。`tg://resolve?domain=auction` 仍是用户名。`stargift_auction` 仍是另一条命令，这次不改。

## 决策

- `t.me`、`telegram.me`、`telegram.dog` 以及一层 `www.` 上，第一段正好是小写 `auction`，路径不以斜杠结束，且正好还有一段、这段匹配 `[A-Za-z0-9._-]+` 时，不从 `text` 抽主机名。
- `auction.t.me` 后面正好一段、且这段匹配同一字符集时同样不读。没有路径时仍读。
- 末尾斜杠，以及命令不是小写 `auction` 时仍读。
- `t.me/auction`、`t.me/auction/` 和 `tg://resolve?domain=auction` 仍读。
- 这个主机名走现有的裸 IP、短链、邀请和 denylist 判断。只拆一层。`text` 不进入正文，也不参与关键词。
- 用户名和短名不进证据。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 继续把 `auction` 放进保留名 | `t.me/auction?text=` 会漏掉。两边都把它当成用户名。 |
| 连字符仍按应用名读 | 桌面端拍卖字符集包含连字符。`lot-now` 两边都打开拍卖。 |
| 命令不区分大小写 | Android 只认小写 `auction/`。`Auction/短名` 仍写草稿。 |
| 末尾再多一道斜杠也不读 | 桌面端把 `auction/短名/` 收成应用名或帖子，仍写草稿。 |
| 全数字的第二段仍按帖子读 | 没有多余斜杠时，两边都不把它写成帖子草稿。 |
| 一并放开 `stargift_auction` | 那是另一条命令。这次只处理 `auction`。 |

## 后果

- `t.me/auction`、`t.me/auction/`、`auction.t.me`、`tg://resolve?domain=auction`、`t.me/Auction/短名` 和 `t.me/auction/短名/` 的 `text` 是裸 IP、默认短链或邀请时删除。证据仍只有主机名。
- `t.me/auction/lot208`、`auction/lot-now`、`auction/lot.now` 和 `auction.t.me/数字` 留着。
- 用户名和短名不进证据。
- `t.me/stargift_auction` 后来由 ADR 0247 仍读 `text`。这次决定只处理 `auction`。
