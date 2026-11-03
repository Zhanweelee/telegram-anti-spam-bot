# ADR 0235：账单短码不读 text，用户名仍读

- 状态：已接受
- 日期：2026-11-03

## 背景

Android `LinkManager` 在路径第一段是 `invoice` 且第二段非空时打开付款单，不把 `text` 写进输入框。第二段为空时这个函数返回，链接继续按用户名解析，`text` 仍写进输入框。桌面端只把 `invoice/` 后面符合 `[A-Za-z0-9_-]+` 的一段收成 `tg://invoice`，查询里的 `text` 不会留下。带点的第二段对不上这个字符集，桌面端把它收成应用名，普通用户仍写草稿。

`t.me/invoice?text=`、末尾只有斜杠，以及 `invoice.t.me?text=` 收成 `tg://resolve`，普通用户仍写草稿。`invoice.t.me/数字` 两边都收成账单短码。大小写不敏感。`tg://resolve?domain=invoice` 仍是用户名。

## 决策

- `t.me`、`telegram.me`、`telegram.dog` 以及一层 `www.` 上，第一段不区分大小写是 `invoice`，且正好还有一段、这段匹配 `[A-Za-z0-9_-]+` 时，不从 `text` 抽主机名。
- `invoice.t.me` 后面正好一段、且这段匹配同一字符集时同样不读。没有路径时仍读。
- 带点的第二段仍按应用名读取。
- `t.me/invoice`、`t.me/invoice/` 和 `tg://resolve?domain=invoice` 仍读。
- 这个主机名走现有的裸 IP、短链、邀请和 denylist 判断。只拆一层。`text` 不进入正文，也不参与关键词。
- 用户名和短码不进证据。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 继续把 `invoice` 放进保留名 | `t.me/invoice?text=` 会漏掉。两边都把它当成用户名。 |
| 任何非空第二段都不读 | `invoice/pay.now` 在桌面端是应用名，仍写草稿。 |
| 全数字的第二段仍按帖子读 | 两边都把它收成账单短码。 |
| 末尾斜杠也不读 | 没有后一段时两边仍写草稿。 |

## 后果

- `t.me/invoice`、`t.me/invoice/`、`invoice.t.me`、`tg://resolve?domain=invoice` 和 `t.me/invoice/pay.now` 的 `text` 是裸 IP、默认短链或邀请时删除。证据仍只有主机名。
- `t.me/invoice/pay202`、`Invoice/pay_now`、`www.telegram.dog/invoice/pay-now` 和 `invoice.t.me/数字` 留着。
- 用户名和短码不进证据。
