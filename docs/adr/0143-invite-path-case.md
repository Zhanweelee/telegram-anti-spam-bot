# ADR 0143：joinchat 和 addlist 不区分大小写

- 状态：已接受
- 日期：2026-11-02

## 背景

ADR 0030 把 `t.me/joinchat/` 和 `t.me/addlist/` 记成邀请，比较时路径区分大小写。

桌面端 `TryConvertUrlToLocal` 用忽略大小写的正则认 `joinchat/` 和 `addlist/`。`https://t.me/JoinChat/邀请码` 和 `https://t.me/ADDLIST/邀请码` 会收成 `tg://join` 或 `tg://addlist`。Android 的 `startsWith` 区分大小写，只认小写。桌面端会打开这两条链接。

`folder/` 仍只认小写。Android 的 `startsWith("folder/")` 区分大小写，桌面端不改写 `folder/`。

## 决策

- `t.me`、`telegram.me`、`telegram.dog` 及其子域上，路径去掉末尾斜杠后是 `/joinchat/` 或 `/addlist/` 加 1 到 128 位字母、数字、`_` 或 `-` 时，这两段目录名不区分大小写，记成邀请。
- `/folder/` 仍必须是小写。`+` 路径的规则不变。
- 没有第二段、或多于一段时不记。其它网站不记。
- 邀请码不进事件。不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 继续只认小写 | 桌面端点 `t.me/JoinChat/邀请码` 会加入该群。 |
| 连 `Folder` 一起忽略大小写 | Android 只认小写 `folder/`。桌面端不把 `Folder` 收成邀请。 |
| 邀请码里允许 `.` | 桌面端字符类含点。现有邀请码仍是字母、数字、`_` 和 `-`。 |

## 后果

- `https://t.me/JoinChat/…`、`https://telegram.me/ADDLIST/…` 和带子域、末尾斜杠的同样写法按现有邀请规则删除。证据仍是 `invite:` 加主机名。
- `https://t.me/JOINCHAT`、`https://t.me/JoinChat/…/more`、`https://example.com/JoinChat/…` 和 `https://t.me/Folder/…` 留着。
- `t.me/%20`、`telegram.me/%20` 和 `telegram.dog/%20` 后来由 ADR 0144 记成邀请。末尾斜杠、紧挨着的 `#` 和子域仍不记。
- 邀请码不进证据。公开的 `t.me/名字` 仍保留。
