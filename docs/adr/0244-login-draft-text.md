# ADR 0244：登录用户名仍读 text，登录码路径也读

- 状态：已接受
- 日期：2026-11-03

## 背景

Android `LaunchActivity` 在路径以小写 `login/` 开头、且后面能解析成非零整数时弹出登录码，不把 `text` 写进输入框。解析不成整数时，这条分支同样被吃掉，不回到用户名。桌面端的 `t.me` 转换没有单独的 `login/` 规则。`login`、`login/短名` 和 `login/数字` 都落到用户名式子，普通用户仍写草稿。末尾斜杠也落在这个式子里。

`tg://login?code=` 是另一条登录码链接，这次不读它的查询。

## 决策

- 把 `login` 从保留用户名里拿掉。
- `t.me`、`telegram.me`、`telegram.dog` 以及一层 `www.` 上，`login`、后面一段应用名、后面一段数字，以及末尾斜杠，都从 `text` 抽主机名。
- `login.t.me` 没有路径或后面是数字时同样读。后面是短名时不读。
- 再多一段路径不读。
- `tg://resolve?domain=login` 仍读。
- 这个主机名走现有的裸 IP、短链、邀请和 denylist 判断。只拆一层。`text` 不进入正文，也不参与关键词。
- 用户名和登录码不进证据。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 继续把 `login` 放进保留名 | `t.me/login?text=` 会漏掉。两边都把它当成用户名。 |
| 非零数字的第二段不读 | Android 弹出登录码。桌面端仍把 `login/数字` 收成用户帖子并写草稿。 |
| 应用名不读 | Android 吃掉 `login/短名`。桌面端仍写成 `appname` 并写草稿。 |
| 子域上的短名也读 | `login.t.me/短名` 对不上桌面端子域改写，Android 也不写草稿。 |

## 后果

- `t.me/login`、`t.me/login/`、`login.t.me`、`tg://resolve?domain=login`、`t.me/Login/短名`、`t.me/login/code211`、`t.me/login/5` 和 `login.t.me/数字` 的 `text` 是裸 IP、默认短链或邀请时删除。证据仍只有主机名。
- `t.me/login/短名/再一段` 和 `login.t.me/短名` 留着。
- 用户名和登录码不进证据。
