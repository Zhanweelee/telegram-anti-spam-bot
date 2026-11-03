# ADR 0245：创建机器人不读 text，用户名仍读

- 状态：已接受
- 日期：2026-11-03

## 背景

Android `LinkManager.handleHttp` 不区分大小写。路径第一段是 `newbot` 且至少还有一段时，打开创建机器人，只用 `name` 查询，不把 `text` 写进输入框。没有第二段时它直接返回，链接不再落到用户名。桌面端把 `newbot/` 后面一到两段、每段符合 `[A-Za-z0-9._]+` 的路径收成 `tg://newbot`，并保留查询。这个命令没有专门的本地处理，未知深链只取命令名，不读 `text`。连字符不在这个字符集里，桌面端把它收成应用名，普通用户仍写草稿。

`t.me/newbot?text=`、末尾只有斜杠，以及 `newbot.t.me?text=` 收成 `tg://resolve`，普通用户仍写草稿。`newbot.t.me/数字` 两边都不写草稿。

## 决策

- `t.me`、`telegram.me`、`telegram.dog` 以及一层 `www.` 上，第一段不区分大小写是 `newbot`，后面还有一段或两段、且每段匹配 `[A-Za-z0-9._]+` 时，不从 `text` 抽主机名。
- `newbot.t.me` 后面一到两段、且每段匹配同一字符集时同样不读。没有路径时仍读。
- 连字符仍读。没有第二段时仍读。
- `t.me/newbot`、`t.me/newbot/` 和 `tg://resolve?domain=newbot` 仍读。
- 这个主机名走现有的裸 IP、短链、邀请和 denylist 判断。只拆一层。`text` 不进入正文，也不参与关键词。
- 用户名不进证据。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 继续把 `newbot` 放进保留名 | `t.me/newbot?text=` 会漏掉。桌面端把它当成用户名。 |
| 没有第二段也不读 | Android 把 `t.me/newbot` 吃掉。桌面端仍写草稿。 |
| 连字符也不读 | 桌面端创建机器人的字符集不含连字符。`manager-now` 仍写草稿。 |
| 命令区分大小写 | Android `LinkManager` 不区分大小写。`NewBot/短名` 两边都打开创建机器人。 |
| 全数字的第二段仍按帖子读 | 数字在创建机器人的字符集里。两边都不写草稿。 |

## 后果

- `t.me/newbot`、`t.me/newbot/`、`newbot.t.me`、`tg://resolve?domain=newbot` 和 `t.me/newbot/manager-now` 的 `text` 是裸 IP、默认短链或邀请时删除。证据仍只有主机名。
- `t.me/newbot/manager212`、`NewBot/短名`、`newbot/短名/再一段`、`newbot/manager.now` 和 `newbot.t.me/数字` 留着。
- 用户名不进证据。
