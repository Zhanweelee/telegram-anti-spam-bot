# ADR 0258：confirmphone 短名仍读 text，确认电话不读

- 状态：已接受
- 日期：2026-11-03

## 背景

桌面端把 `confirmphone` 或 `confirmphone/` 后面紧跟的查询收成 `tg://confirmphone`。`ConfirmPhone` 只读取 `phone` 和 `hash`，不把 `text` 放进输入框。`confirmphone/短名` 和 `confirmphone/数字` 对不上这道式子，落到用户名式子并写草稿。大小写不同的 `ConfirmPhone` 也对不上「查询紧挨命令」之外的短名式子。

Android 在路径以小写 `confirmphone` 开头时只取电话和校验值，不写聊天草稿。大写 `ConfirmPhone` 对不上这道前缀，仍按用户名读取 `text`。

`confirmphone.t.me` 没有路径时，桌面端改写后的结果不是 `tg://resolve`，于是留在原来的地址。后面是数字时改写成帖子。后面是短名时对不上这道改写。

## 决策

- 把 `confirmphone` 从保留用户名里拿掉。
- `t.me`、`telegram.me`、`telegram.dog` 以及一层 `www.` 上，大写 `ConfirmPhone`、小写 `confirmphone/` 后面的短名或数字，都从 `text` 抽主机名。
- 小写 `confirmphone` 没有下一段时不读 `text`。末尾只有一条斜杠同样不读。
- `confirmphone.t.me` 没有路径时不读。后面是数字时读。后面是短名时不读。
- 再多一段路径不读。
- `tg://resolve?domain=confirmphone` 仍读。`tg://confirmphone` 仍只认 `phone` 和 `hash`，不读 `text`。
- 这个主机名走现有的裸 IP、短链、邀请和 denylist 判断。只拆一层。`text` 不进入正文，也不参与关键词。
- 用户名、应用名、电话号码和校验值不进证据。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 继续把 `confirmphone` 放进保留名 | `t.me/confirmphone/短名?text=` 会漏掉。桌面端把它当成用户名。 |
| 小写短名不读 | Android 不写草稿，桌面端仍写。一边写草稿就读。 |
| 没有短名的小写命令也读 | 两边都收成确认电话，不写聊天草稿。 |
| 空的 `confirmphone.t.me` 也读 | 桌面端改写后不是用户名解析，Android 也打开确认电话。 |
| 子域上的短名也读 | `confirmphone.t.me/短名` 对不上桌面端子域改写。 |

## 后果

- `t.me/confirmphone/slug225`、`t.me/confirmphone/5`、`t.me/ConfirmPhone`、`t.me/ConfirmPhone/slug.225`、`confirmphone.t.me/数字` 和 `tg://resolve?domain=confirmphone` 的 `text` 是裸 IP、默认短链或邀请时删除。证据仍只有主机名。
- `t.me/confirmphone?text=`、`t.me/confirmphone/?text=` 和空的 `confirmphone.t.me` 仍不读 `text`。电话号码和校验值不进证据。
- `t.me/confirmphone/短名/再一段` 和 `confirmphone.t.me/短名` 留着。
- 用户名、应用名、电话号码和校验值不进证据。
