# ADR 0146：用户名后一段应用名的 text 只留主机名

- 状态：已接受
- 日期：2026-11-02

## 背景

ADR 0139 不读 `t.me/用户名/app` 上的 `text`。当时把这段路径都当成小程序。

桌面端 `TryConvertUrlToLocal` 把用户名后的第二段收成 `appname`。`ResolveUsernameOrPhone` 在 `appname` 非空时把解析类型设成 Bot App。`showPeerByLinkResolved` 只在对方是 bot 时提前返回。对方是普通用户时仍调用 `SetChatLinkDraft`。Android 也只在 `user.bot` 时打开小程序；用户仍写入 `start_text`。

链接看不出名字属于用户还是 bot。`t.me`、`telegram.me`、`telegram.dog` 以及一层 `www.` 上，用户名后再加一段应用名时，点开可能把 `text` 放进私聊输入框。

`用户名.t.me/应用名` 桌面端不改写。Android 会收成 `t.me/用户名/应用名`。以桌面端为准，子域上的这段不读。一段 1 到 16 位数字仍是帖子。三段路径、保留名和其它网站不读。讨论串仍不读。

`名字.t.me/应用名` 只有一段路径。ADR 0137 曾把任意子域上的单段公开用户名当成草稿。桌面端不会把它改写成用户名解析，这段不再读。

## 决策

- `t.me`、`telegram.me`、`telegram.dog` 以及一层 `www.` 上，路径是一个公开用户名再加一段 `[A-Za-z0-9._-]{1,128}`，且这段不是 1 到 16 位数字时，从 `text` 抽出主机名。
- 单段公开用户名仍只在这些精确主机上读取。`名字.t.me` 的空路径和一段数字仍按 ADR 0139 读取。其它子域上的单段路径不读。
- `tg://resolve` 在 `domain` 是公开用户名时仍从 `text` 抽出主机名。`appname` 不改变这条判断。
- 这个主机名走现有的裸 IP、短链、邀请和 denylist 判断。只拆一层。`text` 不进入正文，也不参与关键词。
- 用户名、应用名和路径不进证据。
- `用户名.t.me/应用名`、三条及以上的路径、保留名、讨论串和其它网站不读。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 继续不读这段 `text` | 名字解析成普通用户时，客户端会把 `text` 放进输入框。 |
| 先解析是不是 bot 再决定读不读 | 热路径不能为了这条链接打 Telegram。 |
| 子域 `用户名.t.me/应用名` 也读 | 桌面端不把这段改写成带 `appname` 的 resolve。 |
| 讨论串也读 | 桌面端在写草稿之前就返回。 |

## 后果

- `t.me/用户名/shop`、`telegram.dog/用户名/Shop` 和 `tg://resolve?domain=用户名&appname=shop` 的 `text` 是裸 IP、默认短链或邀请时，现有链接规则删除这条消息。证据仍只有主机名。
- 真正的 bot 小程序如果带了同样的 `text`，也会被删。客户端对 bot 不写这段草稿。
- `用户名.t.me/shop`、`t.me/用户名/shop/more`、`t.me/用户名/12/34`、`t.me/proxy/shop` 和其它网站留着。
- 小写 `t.me/call/短码` 后来由 ADR 0231 不读 `text`。`t.me/call` 仍读。
- `t.me/addstyle/短码` 后来由 ADR 0234 不读 `text`。`t.me/addstyle` 仍读。
- `t.me/invoice/短码` 后来由 ADR 0235 不读 `text`。字符集之外的第二段和 `t.me/invoice` 仍读。
- `t.me/addemoji/短名` 后来由 ADR 0236 不读 `text`。连字符、末尾斜杠、大小写不同的命令和 `t.me/addemoji` 仍读。
- `t.me/addstickers/短名` 后来由 ADR 0237 不读 `text`。连字符、末尾斜杠、大小写不同的命令和 `t.me/addstickers` 仍读。
- `t.me/addtheme/短名` 后来由 ADR 0238 不读 `text`。连字符、末尾斜杠、大小写不同的命令和 `t.me/addtheme` 仍读。
- `t.me/setlanguage/短名` 后来由 ADR 0239 不读 `text`。末尾斜杠、大小写不同的命令和 `t.me/setlanguage` 仍读。
- `t.me/nft/短名` 后来由 ADR 0240 不读 `text`。末尾斜杠、大小写不同的命令和 `t.me/nft` 仍读。
- `t.me/auction/短名` 后来由 ADR 0241 不读 `text`。末尾斜杠、大小写不同的命令和 `t.me/auction` 仍读。
- `t.me/bg/短名` 后来由 ADR 0242 不读 `text`。末尾斜杠、大小写不同的命令和 `t.me/bg` 仍读。
- `t.me/contact/令牌` 后来由 ADR 0243 不读 `text`。大小写不同的命令和 `t.me/contact` 仍读。末尾斜杠也不读。
- 应用名路径上的 `profile` 仍读。没有应用名、且资料页没有被其它参数改掉时，后来由 ADR 0232 不读。
- 再套一层预填链接仍放行。用户名和应用名不进证据。
- 应用名后来由 ADR 0147 去掉 128 的上限。全数字的第二段仍是帖子，位数也不再停在 16。
