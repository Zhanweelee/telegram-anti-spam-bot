# ADR 0156：业务聊天链接记成邀请

- 状态：已接受
- 日期：2026-11-02

## 背景

ADR 0142 只把 `folder.t.me`、`addlist.t.me` 和 `joinchat.t.me` 收成邀请。桌面端 `TryConvertUrlToLocal` 另有一条：`t.me/m/短码`、`telegram.me/m/短码` 和 `telegram.dog/m/短码` 收成 `tg://message?slug=`。`LocalUrlHandlers` 里的 `message?slug=` 交给 `ResolveChatLink`，打开对方的聊天，并把解析到的句子放进输入框。

Android 的 `LaunchActivity` 在路径以 `m/` 开头时同样取出短码，调用 `account.resolveBusinessChatLink`，再 `setResolvedChatLink`。主机是单层 `m.t.me` 时，先收成 `t.me/m` 再走这条路径。短码留在路径里时，现有规则只看见 `t.me` 或 `m.t.me`，公开用户名不会被删。

`m/` 不区分大小写，因为桌面端这条正则忽略大小写。短码可以含 `.`，和桌面端字符集一致。末尾斜杠、第二段路径和 `m.telegram.me` 对不上这条收写。查询里的 `text` 不会写进输入框。

## 决策

- `t.me`、`telegram.me`、`telegram.dog` 去掉可选的 `www.` 之后，路径是 `/m/` 加 1 到 128 位字母、数字、`.`、`_` 或 `-`，记成邀请。大小写不限。证据是 `invite:` 加这台主机名。
- 主机恰好是 `m.t.me`，路径是 `/` 加同样的一段，也记成邀请。证据是 `invite:m.t.me`。
- `tg://message?slug=` 的短码符合同一段字符时，记成 `invite:t.me`。`slug` 不区分大小写。
- 没有第二段、或多于一段、或末尾还有斜杠时不记。不读 `text`。短码不进事件。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 继续只认加群和文件夹邀请 | 桌面端和 Android 点 `t.me/m/短码` 都会打开聊天并放上对方的句子。 |
| 任何 `名字.t.me` 都按收写后的路径判断 | 桌面端丢掉不是用户名解析的结果。`share.t.me` 会把已经放过的分享路径重新打开。 |
| 末尾斜杠也记 | 桌面端的正则要求短码后面是查询或结尾。多出来的斜杠不是同一条链接。 |
| 连 `text` 一起读 | 这条路径在收成 `tg://message` 时丢掉查询。输入框里的句子来自解析结果，不来自链接上的 `text`。 |

## 后果

- `https://t.me/m/…`、`telegram.me/m/…`、`telegram.dog/m/…`、`https://m.t.me/…` 和 `tg://message?slug=` 按现有邀请规则删除。证据仍是 `invite:` 加主机名。
- `https://t.me/m`、`https://t.me/m/…/`、`https://t.me/m/…/more`、`https://example.com/m/…` 和 `https://m.telegram.me/…` 留着。
- 短码不进证据。公开的 `t.me/名字` 仍保留。
