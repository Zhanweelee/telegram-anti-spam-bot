# ADR 0263：查询里的加号是空格

- 状态：已接受
- 日期：2026-11-03

## 背景

Android `Uri.getQueryParameter` 和桌面端 `qthelp::url_decode` 都先把查询值里的 `+` 换成空格，再做百分号解码。`%2B` 仍是加号。

`t.me/durov?text=https://example.com/a+http://bit.ly/…` 在消息里是一整段链接。点开后草稿是 `https://example.com/a http://bit.ly/…`，后面的短链会再被高亮。`tg://msg_url?url=`、`tg://msg?url=` 和 Passport 的 `callback_url` 同样先解码再打开。

正文里的 `https://example.com/a+http://bit.ly/…` 仍是一段路径。加号留在路径里，后面的网址不会单独打开。`%2B` 写进草稿后也仍是加号，路径继续粘住后面的网址。

`tg://msg_url?url=https://t.me/+…` 的原始路径里仍能看见 `t.me/+`。这条仍按邀请读取。

## 决策

- `text`、分享和私聊预填的 `url`、以及 `callback_url` 里，字面 `+` 先换成空格，再做百分号解码。
- 解码后的草稿、分享和回调按空格拆开，每段只留主机名。
- `%2B` 仍是加号。编码后的加号不把后面的网址拆开。
- 正文路径里的加号仍留在这一段里。
- 原始文本里看得见的 `t.me/+` 仍是邀请。
- 这个主机名走现有的裸 IP、短链、邀请和 denylist 判断。只拆一层。查询值不进入正文，也不参与关键词。
- 路径不进证据。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 查询里的 `+` 仍留成加号 | 草稿和分享会把加号当空格，后面的短链会打开。 |
| 正文路径里的加号也拆开 | Android 把路径里的加号留在同一段链接里。 |
| `%2B` 也换成空格 | 两边都把 `%2B` 解成加号。 |

## 后果

- `t.me/用户名?text=https://example.com/a+http://bit.ly/…`、`tg://msg_url?url=`、`tg://msg?url=` 和 `callback_url` 里同样的加号，短链会删除。证据仍只有主机名。
- `https://example.com/a+http://bit.ly/…` 留着。
- 查询值用 `%2B` 编码时留着。
- `tg://msg_url?url=https://t.me/+…` 仍按邀请删除。
- 正文里的 `%2B` 仍按 ADR 0197 处理。这条只改查询值。
- 查询里非法的 UTF-8 百分号后来仍留下主机名。见 ADR 0264。
