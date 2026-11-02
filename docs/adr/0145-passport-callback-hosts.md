# ADR 0145：Passport 的 callback_url 只留主机名

- 状态：已接受
- 日期：2026-11-02

## 背景

ADR 0137 和 ADR 0139 不读 Passport 上的 `text`。桌面端取消这份表单时另有一条会打开的地址。

`ShowPassportForm` 收下 `callback_url`。表单取消或遇到若干服务错误时，`cancelSure` 用 `UrlClickHandler::Open` 打开它，并附上 `tg_passport=cancel|success|error`。`tg://passport` 不区分大小写。`tg://resolve?domain=telegrampassport` 里的 `domain` 值必须正好是小写 `telegrampassport`。`t.me/telegrampassport`、`telegram.me/telegrampassport`、`telegram.dog/telegrampassport` 以及一层 `www.` 会先收成这条 resolve；第一段必须是小写 `telegrampassport`。后面可以空着，也可以是桌面端用户名正则允许的一段、`s/` 加数字或 `live`、`a/` 或 `c/` 加数字、两段数字。`telegrampassport.t.me` 只在标签正好是小写、后面没有路径或只有一段数字时改写成同一条链接。不要求 `bot_id`。Android 在 `bot_id` 为 0 时直接返回，桌面端仍会打开回调。

## 决策

- 上面这些 Passport 链接从 `callback_url` 抽出主机名。参数名不区分大小写，取第一次出现的值。
- 这个主机名走现有的裸 IP、短链、邀请和 denylist 判断。只拆一层。
- `callback_url` 不进入正文，也不参与关键词。路径、`nonce`、公钥、`scope`、`bot_id` 和 `payload` 不进证据。
- `text` 仍不读。`domain` 或第一段不是正好小写 `telegrampassport` 时不读。三段以上对不上桌面端用户名正则的路径不读。`telegram.me` 上的 `telegrampassport` 子域、`www.telegrampassport.t.me`、其它网站和 `tg://secureid` 不读。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 继续不读 `callback_url` | 关掉窗口就会在浏览器里打开这段地址。 |
| 和 Android 一样要求 `bot_id` | 桌面端没有合法表单时也会打开回调。 |
| 同时读 `text` | Passport 不会把 `text` 放进私聊输入框。 |
| 子域标签不区分大小写 | 改写后的 `domain` 保留原来的大小写，比较是精确相等。 |

## 后果

- `https://t.me/telegrampassport?callback_url=`、`tg://passport?callback_url=` 和 `https://telegrampassport.t.me?callback_url=` 里的裸 IP、默认短链或邀请按现有链接规则删除。证据仍只有主机名。
- `example.com`、大小写不对的 `TelegramPassport`、对不上的多段路径和只有 `text` 的 Passport 链接留着。
- 再套一层 Passport 链接仍放行。`nonce` 和路径不进证据。
- 附加段和数字路径后来由 ADR 0147 去掉 16 和 128 的上限。`callback_url` 仍只留主机名。
