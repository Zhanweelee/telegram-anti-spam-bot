# ADR 0231：群通话路径不读 text，用户名 call 仍读

- 状态：已接受
- 日期：2026-11-03

## 背景

Android 在路径以小写 `call/` 开头时打开群通话，不把 `text` 写进输入框。`call.t.me/后面` 会先收成 `t.me/call/后面`，同样是通话。

没有这道斜杠时，`call` 仍是公开用户名。`https://t.me/call?text=`、`https://call.t.me?text=` 和 `tg://resolve?domain=call&text=` 会把 `text` 放进私聊输入框。大写 `Call/短码` 对不上 `call/`，仍按用户名和应用名写草稿。

保留名把 `call` 整段排除之后，通话路径不会误删，用户名上的短链也会漏掉。

## 决策

- `t.me`、`telegram.me`、`telegram.dog` 以及一层 `www.` 上，路径以小写 `/call/` 开头时，不从 `text` 抽主机名。
- `call.t.me` 后面还有路径时同样不读。空路径仍按用户名读取。
- `t.me/call`、`tg://resolve?domain=call` 和 `t.me/Call/短码` 仍从 `text` 抽主机名。
- 这个主机名走现有的裸 IP、短链、邀请和 denylist 判断。只拆一层。`text` 不进入正文，也不参与关键词。
- 用户名、通话短码和路径不进证据。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 继续把 `call` 放进保留名 | `t.me/call?text=` 会漏掉。Android 仍把没有斜杠的 `call` 当成用户名。 |
| 连大写 `Call/` 一起不读 | Android 只认小写 `call/`。大写路径仍写草稿。 |
| 子域 `call.t.me/数字` 按帖子读 | Android 先收成 `t.me/call/数字`，打开的是通话。 |

## 后果

- `t.me/call?text=`、`call.t.me?text=` 和 `tg://resolve?domain=call&text=` 的 `text` 是裸 IP、默认短链或邀请时，现有链接规则删除这条消息。证据仍只有主机名。
- `t.me/call/短码`、`t.me/call/`、`t.me/call/123`、`www.telegram.dog/call/短码` 和 `call.t.me/短码` 留着。
- `t.me/Call/短码` 仍按应用名读取。
- 其它应用名路径仍读。路径和短码不进证据。
