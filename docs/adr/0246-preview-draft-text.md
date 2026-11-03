# ADR 0246：礼物预览用户名仍读 text，预览短名也读

- 状态：已接受
- 日期：2026-11-03

## 背景

Android `LaunchActivity` 在路径以小写 `stargift_preview/` 开头时打开礼物预览，不把 `text` 写进输入框。`LinkManager` 不处理这个命令。桌面端的 `t.me` 转换没有单独的 `stargift_preview/` 规则。`stargift_preview`、`stargift_preview/短名` 和 `stargift_preview/数字` 都落到用户名式子，普通用户仍写草稿。末尾斜杠也落在这个式子里。

`tg://stargift_preview` 不是这次要读的查询。

## 决策

- 把 `stargift_preview` 从保留用户名里拿掉。
- `t.me`、`telegram.me`、`telegram.dog` 以及一层 `www.` 上，`stargift_preview`、后面一段应用名、后面一段数字，以及末尾斜杠，都从 `text` 抽主机名。
- `stargift_preview.t.me` 没有路径或后面是数字时同样读。后面是短名时不读。
- 再多一段路径不读。
- `tg://resolve?domain=stargift_preview` 仍读。
- 这个主机名走现有的裸 IP、短链、邀请和 denylist 判断。只拆一层。`text` 不进入正文，也不参与关键词。
- 用户名和预览短名不进证据。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 继续把 `stargift_preview` 放进保留名 | `t.me/stargift_preview?text=` 会漏掉。两边都把它当成用户名。 |
| 预览短名不读 | Android 打开礼物预览。桌面端仍把 `stargift_preview/短名` 收成应用名并写草稿。 |
| 数字的第二段不读 | Android 把整段当成预览短名。桌面端仍收成用户帖子并写草稿。 |
| 子域上的短名也读 | `stargift_preview.t.me/短名` 对不上桌面端子域改写，Android 也不写草稿。 |

## 后果

- `t.me/stargift_preview`、`t.me/stargift_preview/`、`stargift_preview.t.me`、`tg://resolve?domain=stargift_preview`、`t.me/StarGift_Preview/短名`、`t.me/stargift_preview/slug213`、`t.me/stargift_preview/5` 和 `stargift_preview.t.me/数字` 的 `text` 是裸 IP、默认短链或邀请时删除。证据仍只有主机名。
- `t.me/stargift_preview/短名/再一段` 和 `stargift_preview.t.me/短名` 留着。
- 用户名和预览短名不进证据。
