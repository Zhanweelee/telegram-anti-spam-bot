# ADR 0142：Android 的 t.me 前缀邀请

- 状态：已接受
- 日期：2026-11-02

## 背景

ADR 0141 把小写 `t.me/folder/` 记成邀请。Android 的 `LaunchActivity` 在打开 `http` 或 `https` 之前，用 `PREFIX_T_ME_PATTERN` 看主机名。主机是单层 `名字.t.me` 时，先收成 `https://t.me/名字` 再加上原来的路径和查询，然后走同一套路径。

因此 `https://folder.t.me/邀请码` 变成 `https://t.me/folder/邀请码`，`addlist.t.me` 和 `joinchat.t.me` 同样变成已有的邀请路径。邀请码留在子域后面时，现有规则只看见 `folder.t.me` 这台主机，公开用户名子域不会被删。

桌面端 `TryConvertUrlToLocal` 也会把 `名字.t.me` 收成 `t.me/名字`，但只留下 `tg://resolve?domain=` 和 Premium。`folder.t.me/邀请码` 的路径不是纯数字，正则对不上，桌面端保持原链接。Android 会打开这份邀请。

## 决策

- 主机去掉末尾点并收成小写后，恰好是 `folder.t.me`、`addlist.t.me` 或 `joinchat.t.me`，路径去掉末尾斜杠后是 `/` 加 1 到 128 位字母、数字、`_` 或 `-`，记成邀请。证据是 `invite:` 加这台主机名。
- 没有第二段、或多于一段时不记。`telegram.me`、`telegram.dog` 和 `www.folder.t.me` 不走这条约。普通用户名子域仍按 ADR 0139 处理。
- 不读这条链接上的 `text` 或 `url`。`share.t.me` 收成 `t.me/share/其它`，桌面端不读，仍不解开。
- 邀请码不进事件。不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 继续只认路径上的 `/folder/` | Android 点 `folder.t.me/邀请码` 会打开同一张文件夹邀请。`addlist.t.me` 和 `joinchat.t.me` 也一样。 |
| 任何 `名字.t.me` 都按收写后的路径判断 | 桌面端丢掉不是用户名解析的结果。`share.t.me` 会把 ADR 0133 已放过的 `t.me/share/其它` 重新打开。 |
| 连 `名字.t.me.其它域名` 一起认 | Android 的正则没有要求主机在 `.t.me` 结束。这会把无关域名记成邀请。 |

## 后果

- `https://folder.t.me/…`、`https://addlist.t.me/…` 和 `https://joinchat.t.me/…` 按现有邀请规则删除。证据仍是 `invite:` 加主机名。
- `https://folder.t.me`、`https://folder.t.me/…/more`、`https://folder.telegram.me/…`、`https://www.folder.t.me/…` 和 `https://durov.t.me/…` 留着。
- `folder.t.me?text=` 后来由 ADR 0252 按用户名读取。`folder.t.me/码` 仍是邀请，`text` 仍不读。
- `addlist.t.me?text=` 后来由 ADR 0253 按用户名读取。`addlist.t.me/码` 仍是邀请，`text` 仍不读。
- `JoinChat` 和 `AddList` 后来由 ADR 0143 不区分大小写。`Folder` 仍只认小写。
- `t.me/%20`、`telegram.me/%20` 和 `telegram.dog/%20` 后来由 ADR 0144 记成邀请。末尾斜杠、紧挨着的 `#` 和子域仍不记。
- 邀请码不进证据。公开的 `t.me/名字` 仍保留。
- `m.t.me/` 后来由 ADR 0156 记成业务聊天链接。`share.t.me` 仍不解开。
