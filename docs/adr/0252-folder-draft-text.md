# ADR 0252：folder 用户名仍读 text，邀请码不读

- 状态：已接受
- 日期：2026-11-03

## 背景

桌面端没有单独的 `folder/` 规则。`folder`、`Folder/短名` 和 `folder/带点的短名` 都落到用户名式子，普通用户仍写草稿。末尾只有一条斜杠时也落在这个式子里。超过 128 位的第二段同样写成应用名。

Android 只在路径以小写 `folder/` 开头时打开文件夹邀请，不写聊天草稿。裸的 `folder` 仍按用户名读取 `text`。`Folder/短名` 对不上这道小写斜杠，也按用户名写草稿。

小写 `folder/` 后面 1 到 128 位字母、数字、`_` 或 `-` 已是邀请。ADR 0141 写明这条路径不读 `text`。带点的短名对不上邀请码，桌面端仍写草稿。

## 决策

- 把 `folder` 从保留用户名里拿掉。
- `t.me`、`telegram.me`、`telegram.dog` 以及一层 `www.` 上，`folder`、末尾斜杠、大写 `Folder` 后的短名、带点的短名，以及超过 128 位的第二段，都从 `text` 抽主机名。
- `folder.t.me` 没有路径时同样读。
- 小写 `folder/` 或 `folder.t.me/` 后面是邀请码时不读 `text`。邀请仍按 ADR 0141 和 ADR 0142 删除。
- 再多一段路径不读。`folder.t.me/短名` 不读。
- `tg://resolve?domain=folder` 仍读。`tg://folder` 仍不读。
- 这个主机名走现有的裸 IP、短链、邀请和 denylist 判断。只拆一层。`text` 不进入正文，也不参与关键词。
- 用户名、应用名和邀请码不进证据。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 继续把 `folder` 放进保留名 | `t.me/folder?text=` 会漏掉。两边都把它当成用户名。 |
| 邀请码路径也读 `text` | ADR 0141 已写明这条路径不读 `text`。邀请本身已经删除。 |
| 带点的短名不读 | Android 打开文件夹。桌面端仍收成应用名并写草稿。 |
| 连 `folder.t.me/短名` 一起读 | 桌面端子域改写丢掉这段非数字路径。Android 收成邀请路径。 |

## 后果

- `t.me/folder`、`t.me/folder/`、`folder.t.me`、`tg://resolve?domain=folder`、`t.me/Folder/短名`、`t.me/folder/slug.219` 和超过 128 位的第二段，`text` 是裸 IP、默认短链或邀请时删除。证据仍只有主机名。
- `t.me/folder/slug219?text=` 和 `folder.t.me/数字?text=` 仍只记邀请。`text` 里的短链不读。
- `t.me/folder/短名/再一段` 和 `folder.t.me/短名` 留着。
- 用户名、应用名和邀请码不进证据。
