# ADR 0546：小程序按钮文字也走关键词和默认正则

- 状态：已接受
- 日期：2026-11-05

## 背景

ADR 0318 在已有别的正文时，只从小程序回传的 `button_text` 里抽出主机名。这段文字是用户看见的按钮。被别的正文挤开时，「免费领取」和「加微x」仍整段留在外面。短链会删，关键词看不见。

Bot API 写明恶意客户端可以在 `button_text` 里放任意内容，没有写长度。正文回退本来就截到 4096。`data` 是回传载荷，可以带密钥，仍不进事件。

## 决策

- 已有别的正文时，`web_app_data.button_text` 去掉两端空白后仍有字，且自己不是正文时，另留前 4096 字。这段自己就是正文时不设这个字段。
- 字段名是 `webAppButtonText`。正文和 `textSha256` 仍按 ADR 0318，没有更前面的正文时这段成为正文。
- 第 4097 字起不进事件。主机名仍从整段按钮文字抽取，包括被截掉的尾巴。
- `data` 不进这个字段。路径和邀请码仍只通过主机名留下。
- 关键词和 `regex` 同时看正文、`senderTag`、`buttonText`、`authorSignature`、`mirrorSignature`、`pollOption`、`checklistTask`、`mediaName`、`performer`、`gameText`、`invoiceText`、`venueAddress`、`pollExplanation`、`pollQuestion`、`prizeText`、`checklistTitle`、`gameTitle`、`invoiceTitle`、`venueTitle`、`webAppButtonText` 和 `profile`。证据仍是原来的摘要。按钮原文不进证据，也不进日志。审计仍只留 `textSha256`。
- `regex` 命中时带上 `places`。`webAppButtonText` 加入这份名单。`web_app_button_regex` 只在 `places` 含有这个字段时算命中。检测器没有 `places` 时仍按分数。
- 规则条件增加 `webAppButtonText: true`。消息上有这个字段时为真。
- 规则默认打开。条件是这个字段，检测器是现有的 `regex`，命中后 `delete`。
- 「免费领取」和「加微信」仍走已经打开的关键词规则。
- `regex_hint` 仍默认关闭。正文里的「加微x」不会因为旁边有干净的按钮文字就被删掉。
- 不改 ADR 0026 的基础检测器名单。`keyword` 和 `regex` 已经在里面，超额后这条仍会跑。
- `chats.json` 整份替换的群不会自动带上这条规则。
- 不新增命令。菜单仍是 99 条。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 默认打开 `regex_hint` | 普通消息会被同一份模式删除。这次要读的是被别的正文挤开的按钮文字。 |
| 把按钮文字拼进已有正文 | 会改变 `textSha256`。ADR 0318 已经拒绝。 |
| 和内联按钮共用 `buttonText` | 内联按钮上限是 256，而且来自键盘。关掉其中一种时，另一种还要留着。 |
| 按键盘按钮常见的 64 字截断 | 官方没有写这个上限，并明确恶意客户端可以放任意内容。截到 64 会漏掉后面的关键词。 |
| 连 `data` 一起收进字段 | 载荷可以是密钥。主机名已经够用。 |

## 后果

- 小程序按钮文字含「免费领取」或「加微信」时按关键词删除。含 `t.me/+`、「加微x」或「加微X」时按 `web_app_button_regex` 删除。证据不含按钮原文。
- 按钮文字干净时消息留下。它自己就是正文时，「加微x」仍要打开 `regex_hint`。
- 第 4097 字起不进事件。主机名仍从整段抽取。写在按钮文字里的路径会留在这个字段，不进审计。
- `data` 仍不进事件。
- 关掉 `web_app_button_regex` 后，这种按钮文字回到只看关键词和短链。内联按钮不受影响。
- 整份替换规则的群要自己加上这条，才会删除按钮文字上的「加微x」。
- 30 天保留期没有改。
- `places` 后来由 ADR 0547 加上 `quoteText`。手动引用的规则只认自己的字段。
