# ADR 0030：Telegram 邀请只保留主机名

- 状态：已接受
- 日期：2026-11-01

## 背景

垃圾消息常用 `t.me/+`、`t.me/joinchat/` 和 `t.me/addlist/` 拉人。公开的 `t.me/名字` 是正常频道链接，不能一并删掉。

邀请码和 ADR 0029 里的路径一样，不能进入事件。检测器在隐藏链接上只能看见主机名，所以分类必须发生在丢掉路径之前。

## 决策

- 默认邀请主机名是 `t.me`、`telegram.me`、`telegram.dog`，含子域。检测器配置 `inviteHosts` 可以换成别的列表；空列表表示关闭这类判断。
- 路径去掉末尾斜杠后，只认这三种：`/+`、`/joinchat/`、`/addlist/`，后面是 1 到 128 位字母、数字、`_` 或 `-`。其它路径，包括公开用户名，保留。
- 可见正文由链接检测器分类。隐藏的 `text_link` 由平台分类，主机名放进 `message.invites`，邀请码丢掉。证据是 `invite:` 加主机名。
- 仍走规则 `links`，动作是 delete。没有新检测器，也没有新依赖。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 把 `t.me` 放进域名黑名单 | 公开频道链接会被删掉。 |
| 保存邀请码或完整路径 | 邀请码是密钥，和原文默认不落盘冲突。 |
| 单独做一条规则 | 动作和开关已经在 `links` 上。再开一条要每个群各配一次。 |

## 后果

- 隐藏的非 Telegram 邀请主机名不会进 `invites`。它们仍以主机名进入 `hosts`，短链、裸 IP 和黑名单照旧。
- 自定义 `inviteHosts` 只影响检测器能看见的正文。平台对隐藏链接只认上面三个 Telegram 主机名。
- `chats.json` 整份替换、因而没有 `links` 的群不会删除邀请。
- `tg://join?invite=` 和 `tg://addlist?slug=` 后来由 ADR 0102 记成 `t.me`。`tg://resolve` 仍当公开用户名。
- 全是数字的 `t.me/+`、`telegram.me/+` 和 `telegram.dog/+` 后来由 ADR 0138 改成电话链接，不再记成邀请。带字母的加号路径仍是邀请。
- `t.me/folder/`、`telegram.me/folder/` 和 `telegram.dog/folder/` 后来由 ADR 0141 记成邀请。大写 `Folder`、没有第二段和 `tg://folder` 仍不记。
- `folder.t.me/`、`addlist.t.me/` 和 `joinchat.t.me/` 后来由 ADR 0142 记成邀请。没有第二段、其它主机和普通用户名子域仍不记。
