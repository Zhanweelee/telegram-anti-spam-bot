# ADR 0243：联系人令牌不读 text，用户名仍读

- 状态：已接受
- 日期：2026-11-03

## 背景

Android `LaunchActivity` 在路径以小写 `contact/` 开头时导入联系人，不把 `text` 写进输入框。命令大小写不同时，链接继续按用户名解析，`text` 仍写进输入框。桌面端把 `contact/` 后面直到查询或片段为止的整段收成 `tg://contact`，并保留查询参数。联系人处理只读 `token` 和 `free`，不读 `text`。令牌可以为空；空令牌只提示链接无效，不写草稿。令牌里可以再包含斜杠。

`t.me/contact?text=` 和 `contact.t.me?text=` 收成 `tg://resolve`，普通用户仍写草稿。`contact.t.me` 后面有路径时两边都不写草稿。`tg://resolve?domain=contact` 仍是用户名。

## 决策

- `t.me`、`telegram.me`、`telegram.dog` 以及一层 `www.` 上，第一段正好是小写 `contact`，并且后面还有路径或路径以斜杠结束时，不从 `text` 抽主机名。
- `contact.t.me` 后面有路径时同样不读。没有路径时仍读。
- 命令不是小写 `contact` 时仍读。
- `t.me/contact` 和 `tg://resolve?domain=contact` 仍读。`t.me/contact/` 不读。
- 这个主机名走现有的裸 IP、短链、邀请和 denylist 判断。只拆一层。`text` 不进入正文，也不参与关键词。
- 用户名和令牌不进证据。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 继续把 `contact` 放进保留名 | `t.me/contact?text=` 会漏掉。两边都把它当成用户名。 |
| 只跳过一段有限字符集 | 桌面端令牌是查询前的整段。连字符、点号和再加一段都打开联系人。 |
| 末尾斜杠仍按用户名读 | `contact/` 和 `contact/令牌/` 两边都打开联系人，不写草稿。 |
| 命令不区分大小写 | Android 只认小写 `contact/`。`Contact/令牌` 仍写草稿。 |
| 子域上的数字仍按帖子读 | `contact.t.me/数字` 收成联系人令牌，不写草稿。 |

## 后果

- `t.me/contact`、`contact.t.me`、`tg://resolve?domain=contact` 和 `t.me/Contact/令牌` 的 `text` 是裸 IP、默认短链或邀请时删除。证据仍只有主机名。
- `t.me/contact/`、`t.me/contact/token210`、`contact/令牌/`、`contact/令牌/再一段` 和 `contact.t.me/数字` 留着。
- 用户名和令牌不进证据。
