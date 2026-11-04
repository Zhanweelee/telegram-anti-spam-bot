# ADR 0429：文件夹邀请入群默认仍只验证

- 状态：已接受
- 日期：2026-11-04

## 背景

`chat_member` 更新可以带 `via_chat_folder_invite_link`。文档把它写成可选的 `True`：这个人是通过聊天文件夹邀请进群的。一次文件夹邀请能把人加进多个群。反垃圾要能认出这条路径，才不会把它和普通点链接进群看成同一件事。

进群用的 `invite_link` 仍不读。见 ADR 0117。

## 决策

- 只有从群外加入，并且 `via_chat_folder_invite_link` 正好是 `true` 时，事件带 `folderInvite: true`。从群外加入包括人类的 `membership: "join"`，以及 ADR 0031 里从群外进来的 bot。
- 字段缺失、是 `false`，或不是布尔值时，不带这个标记，也不丢掉整条入群。离群、晋升和解禁即使带了这个字段，也不标成文件夹邀请。
- 不读取 `invite_link`。名字、邀请码和链接不进事件，也不进证据。
- 检测器 id 是 `folder`，放在 `@tasb/detector-folder`。只在 `kind: chat_member` 且带这个标记时返回 score 1。证据是 `folder:invite`。
- 默认规则 `folder_join` 存在，但是关闭的。某个群把它打开之后才封禁。
- 不改 ADR 0026 的基础检测器名单。`folder` 不在默认 `QUOTA_BASIC` 里。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 默认封禁全部文件夹邀请 | 正常社群也用文件夹把相关的群放在一起。 |
| 并进 `bot` 检测器 | 人类也会从文件夹邀请进群。bot 仍走原来的 `bot_join`。 |
| 把邀请链接放进事件 | 进群链接是 `t.me`。ADR 0117 不读它。开关够用来区分路径。 |

## 后果

- 不改 `default.json` 开关的群，文件夹邀请的人仍走原来的入群验证。
- 打开 `folder_join` 后，自部署会封禁。云模式超过当月次数后，还要把 `folder` 写进 `QUOTA_BASIC`，否则超额时这条规则会停。
- `chats.json` 整份替换的群要自己加上这条规则，才会有这个开关。
- 30 天保留期不动。
