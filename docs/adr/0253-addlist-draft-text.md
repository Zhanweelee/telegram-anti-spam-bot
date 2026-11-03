# ADR 0253：addlist 用户名仍读 text，短名不读

- 状态：已接受
- 日期：2026-11-03

## 背景

桌面端把小写 `addlist/短名` 收成 `tg://addlist?slug=`，查询里的 `text` 不进草稿。字符集是 `[A-Za-z0-9._-]`，没有长度上限。末尾斜杠对不上这道式子，会落到用户名式子并写草稿。大小写不同的 `AddList/短名` 也由这道式子丢掉 `text`。没有短名时，`addlist` 和 `addlist/` 仍按用户名写草稿。

Android 只在路径以小写 `addlist/` 开头时打开聊天列表，不写聊天草稿。裸的 `addlist` 和 `AddList/短名` 仍按用户名读取 `text`。

小写 `addlist/` 后面 1 到 128 位字母、数字、`_` 或 `-` 已是邀请。带点的短名和超过 128 位的短名不是邀请，两边也都丢掉 `text`。

## 决策

- 把 `addlist` 从保留用户名里拿掉。
- `t.me`、`telegram.me`、`telegram.dog` 以及一层 `www.` 上，`addlist`、末尾只有一条斜杠、末尾斜杠后面的查询，以及大写 `AddList` 后的短名，都从 `text` 抽主机名。
- `addlist.t.me` 没有路径时同样读。
- 小写 `addlist/` 后面一段符合 `[A-Za-z0-9._-]` 且路径不以斜杠结尾时不读 `text`。`addlist.t.me/` 后面同样一段也不读。
- 邀请仍按 ADR 0030 和 ADR 0143 删除。
- 再多一段路径不读。`addlist.t.me/短名` 不读。
- `tg://resolve?domain=addlist` 仍读。`tg://addlist` 仍按邀请读取 `slug`，不读 `text`。
- 这个主机名走现有的裸 IP、短链、邀请和 denylist 判断。只拆一层。`text` 不进入正文，也不参与关键词。
- 用户名、应用名和邀请码不进证据。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 继续把 `addlist` 放进保留名 | `t.me/addlist?text=` 会漏掉。两边都把它当成用户名。 |
| 小写短名也读 `text` | 桌面端收成 `tg://addlist`。Android 打开聊天列表。两边都不写聊天草稿。 |
| 大写 `AddList/短名` 不读 | Android 的 `startsWith("addlist/")` 区分大小写，仍按用户名写草稿。 |
| 末尾斜杠不读 | 桌面端的短名式子要求查询紧挨短名，斜杠会落回用户名草稿。 |

## 后果

- `t.me/addlist`、`t.me/addlist/`、`addlist.t.me`、`tg://resolve?domain=addlist`、`t.me/AddList/slug.220` 和 `t.me/addlist/slug220/` 的 `text` 是裸 IP、默认短链或邀请时删除。证据仍只有主机名。
- `t.me/addlist/slug220?text=`、`t.me/addlist/slug.220?text=` 和超过 128 位的小写短名仍不读 `text`。邀请码本身仍删除。
- `addlist.t.me/数字?text=` 仍只记邀请。
- `t.me/addlist/短名/再一段` 和 `addlist.t.me/短名` 留着。
- 用户名、应用名和邀请码不进证据。
