# ADR 0141：Android 的 folder 路径记成邀请

- 状态：已接受
- 日期：2026-11-02

## 背景

ADR 0030 把 `t.me/addlist/` 记成邀请。Android 的 `LaunchActivity` 在路径以 `folder/` 开头时，把后面的一段交给 `checkChatlistInvite`，再弹出 `FolderBottomSheet`。这和 `addlist/` 是同一个文件夹邀请。

桌面端 `TryConvertUrlToLocal` 只改写 `addlist/`，没有 `folder/`。点开 `https://t.me/folder/邀请码` 时，Android 会导入这份聊天文件夹。邀请码留在路径里时，现有规则只看见 `t.me`。

## 决策

- `t.me`、`telegram.me`、`telegram.dog` 及其子域上，路径去掉末尾斜杠后是 `/folder/` 加 1 到 128 位字母、数字、`_` 或 `-`，记成邀请。主机名规则与 `addlist` 相同。
- `folder` 必须是小写。`/Folder/` 不记成邀请。没有第二段、或多于一段时不记。
- 不新增 `tg://folder`。Android 只在网页路径上读这个别名，深链仍是 `tg://addlist?slug=`。
- 邀请码不进事件。不读这条路径上的 `text`。`folder` 仍是保留名，不当成公开用户名。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 继续只认 `addlist` | Android 点 `t.me/folder/邀请码` 会打开同一张文件夹邀请。 |
| 连大写 `Folder` 一起认 | Android 的 `startsWith("folder/")` 区分大小写。 |
| 增加 `tg://folder` | Android 没有这条命令。桌面端也不读。 |

## 后果

- `https://t.me/folder/…`、`telegram.me/folder/…` 和 `telegram.dog/folder/…` 按现有邀请规则删除。证据仍是 `invite:` 加主机名。
- `https://t.me/Folder/…`、`https://t.me/folder`、`https://example.com/folder/…` 和 `tg://folder?slug=` 留着。
- 邀请码不进证据。公开的 `t.me/名字` 仍保留。
