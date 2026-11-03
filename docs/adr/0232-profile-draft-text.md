# ADR 0232：资料页不读 text，改掉资料页的参数仍读

- 状态：已接受
- 日期：2026-11-03

## 背景

Android 只在查询名正好是 `profile`，且值转成小写后不是 `false` 或 `0` 时打开资料页。这时不把 `text` 写进输入框。`profile=0`、`profile=false` 和查询名 `Profile` 仍写草稿。

桌面端只要出现这个查询名，就先把解析类型设成资料页，并且不写草稿。非空的 `start`、出现的 `startgroup`、`startchannel` 或 `direct`、非空的 `boost`、符合 `[A-Za-z0-9._]+` 的 `game`、非空的 `appname`，以及路径上的应用名，都会改掉资料页。对方是普通用户时，这些链接仍写入草稿。`domain=s` 的预览会清掉 `appname`，资料页保留。

两边都不写草稿的链接，现在仍会从 `text` 抽出短链。

## 决策

- 查询名正好是 `profile`，值不是 `0` 或 `false`（不区分大小写）时，不从 `text` 抽主机名。
- 下面这些参数不区分大小写，出现时仍读：非空 `start`，任意 `startgroup`、`startchannel`、`direct`，非空 `boost`，符合 `[A-Za-z0-9._]+` 的 `game`，以及 `domain` 不是 `s` 时的非空 `appname`。
- `t.me`、`telegram.me`、`telegram.dog` 以及一层 `www.` 上，公开用户名后再加一段应用名时，即使带了 `profile` 仍读。
- `profile=0`、`profile=false` 和查询名 `Profile` 仍读。
- 这个主机名走现有的裸 IP、短链、邀请和 denylist 判断。只拆一层。`text` 不进入正文，也不参与关键词。
- 用户名和路径不进证据。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 只要出现 `profile` 就不读 | `profile=0` 和 `Profile` 在 Android 上仍写草稿。 |
| `start` 和 `game` 也一律不读 | 桌面端对普通用户仍写草稿。 |
| 先解析是不是用户再决定 | 热路径不能为了这条链接打 Telegram。 |

## 后果

- `t.me/用户名?profile=1`、`t.me/用户名?profile`、`t.me/用户名/数字?profile=1`、`用户名.t.me?profile=1`、`t.me/s/用户名?profile=1` 和 `tg://resolve?domain=用户名&profile=1` 留着。证据里没有 `text` 的主机名。
- `profile=0`、`profile=false`、`Profile=1`、`profile=1&start=…`、合法的 `game` 和应用名路径仍删除。证据仍只有主机名。
- 空的 `game` 和空的 `boost` 不改资料页，仍留着。用户名和路径不进证据。
