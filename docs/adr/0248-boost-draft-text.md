# ADR 0248：助推频道不读 text，用户名仍读

- 状态：已接受
- 日期：2026-11-03

## 背景

Android `LaunchActivity` 在路径不区分大小写等于 `boost`，或以小写 `boost/` 开头时，把链接当成助推。有第二段时用它当频道用户名，有 `c` 查询时用它当频道 id。这条分支不读取 `text`。没有用户名、也没有 `c` 时，链接不会进入打开会话的分支。

桌面端只在捕获到的第一段正好是小写 `boost` 时改走助推。后面一段符合 `[A-Za-z0-9._]+` 时收成 `tg://boost?domain=`，不保留 `text`。查询里出现 `c=` 时收成 `tg://boost`，助推处理只认 domain 和频道 id。没有这段、也没有 `c=` 时，仍收成 `tg://resolve` 并保留 `text`。连字符不在助推字符集里，会落到应用名并写草稿。大小写不同的 `Boost` 对不上这个相等判断，也写草稿。

`boost.t.me/数字` 改写之后不是 `tg://resolve`，桌面端退回原链接，不写草稿。

## 决策

- 把 `boost` 从保留用户名里拿掉。
- `t.me`、`telegram.me`、`telegram.dog` 以及一层 `www.` 上，第一段正好是小写 `boost`，且后面一段匹配 `[A-Za-z0-9._]+` 时，不从 `text` 抽主机名。末尾斜杠同样不读。
- 同一条链接的查询里有 `c` 时也不读。
- `boost.t.me` 后面是数字时不读。没有路径时仍读。
- 连字符仍读。没有第二段、也没有 `c` 时仍读。命令大小写不同时仍读。
- `tg://resolve?domain=boost` 仍读。
- 这个主机名走现有的裸 IP、短链、邀请和 denylist 判断。只拆一层。`text` 不进入正文，也不参与关键词。
- 用户名和频道 id 不进证据。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 继续把 `boost` 放进保留名 | `t.me/boost?text=` 会漏掉。桌面端把它当成用户名。 |
| 没有第二段也不读 | Android 不打开会话。桌面端仍写草稿。 |
| 连字符也不读 | 桌面端助推字符集不含连字符。`name-now` 仍写草稿。 |
| 命令不区分大小写 | 桌面端用捕获原文做相等判断。`Boost/短名` 两边都写草稿。 |
| 子域上的数字仍按帖子读 | 改写结果不是 `tg://resolve`，两边都不写草稿。 |

## 后果

- `t.me/boost`、`t.me/boost/`、`boost.t.me`、`tg://resolve?domain=boost`、`t.me/Boost/短名` 和 `t.me/boost/name-now` 的 `text` 是裸 IP、默认短链或邀请时删除。证据仍只有主机名。
- `t.me/boost/name215`、`boost/name.now`、`boost/5`、`boost?c=215` 和 `boost.t.me/数字` 留着。
- 用户名和频道 id 不进证据。
