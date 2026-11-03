# ADR 0234：文风短码不读 text，用户名仍读

- 状态：已接受
- 日期：2026-11-03

## 背景

Android `LinkManager` 在路径第一段是 `addstyle` 且后面还有一段时打开文风，不把 `text` 写进输入框。没有后一段时这个函数返回，链接继续按用户名解析，`text` 仍写进输入框。桌面端 `addstyle/短码` 收成 `tg://addstyle`，查询里的 `text` 不会留下。`t.me/addstyle?text=`、末尾只有斜杠，以及 `addstyle.t.me?text=` 收成 `tg://resolve`，普通用户仍写草稿。

`addstyle.t.me/数字` 两边都收成文风短码。大小写不敏感。`tg://resolve?domain=addstyle` 仍是用户名。

## 决策

- `t.me`、`telegram.me`、`telegram.dog` 以及一层 `www.` 上，第一段不区分大小写是 `addstyle` 且后面还有一段时，不从 `text` 抽主机名。
- `addstyle.t.me` 后面还有路径时同样不读。没有路径时仍读。
- `t.me/addstyle`、`t.me/addstyle/` 和 `tg://resolve?domain=addstyle` 仍读。
- 这个主机名走现有的裸 IP、短链、邀请和 denylist 判断。只拆一层。`text` 不进入正文，也不参与关键词。
- 用户名和短码不进证据。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 继续把 `addstyle` 放进保留名 | `t.me/addstyle?text=` 会漏掉。两边都把它当成用户名。 |
| 末尾斜杠也不读 | 没有后一段时两边仍写草稿。 |
| `addstyle.t.me/数字` 仍按帖子读 | 两边都把它收成文风短码。 |

## 后果

- `t.me/addstyle`、`t.me/addstyle/`、`addstyle.t.me` 和 `tg://resolve?domain=addstyle` 的 `text` 是裸 IP、默认短链或邀请时删除。证据仍只有主机名。
- `t.me/addstyle/短码`、`AddStyle/短码`、`www.telegram.dog/addstyle/短码` 和 `addstyle.t.me/数字` 留着。
- 用户名和短码不进证据。
