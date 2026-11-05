# ADR 0573：后加和删掉的投票选项上的自定义表情也走同一条规则

- 状态：已接受
- 日期：2026-11-05

## 背景

投票允许补选项时，新选项以 `poll_option_added` 到达。删掉选项时，`poll_option_deleted` 仍带上那段选项文字。官方说选项文字目前只允许自定义表情。原投票上的选项已经会让 `asCustomEmoji` 为 true。这两条服务消息仍留下。

原投票在 `poll_message` 里，是另一条消息。选项编号不在看得见的字里。

## 决策

- `poll_option_added.option_text_entities` 和 `poll_option_deleted.option_text_entities` 里，`type` 正好是 `custom_emoji`，并且 `custom_emoji_id` 去掉空白后非空时，事件同样带 `asCustomEmoji: true`。
- 空白、布尔值和缺编号仍不带这个标记。嵌套的 `poll_message` 不读。选项上的 `text_mention` 仍不带 `asTextMention`。
- 编号和选项编号不进事件，也不进证据。选项看得见的字仍留在原来的字段。正文和 `textSha256` 不变。
- 仍用检测器 `custom_emoji`。证据仍是 `entity:custom_emoji`。不新增规则，不新增命令。菜单仍是 99 条。
- 规则仍默认关闭。打开之后，这种新选项和被删选项也删除。付费帖仍不删除。
- 不改 ADR 0026 的基础检测器名单。`custom_emoji` 仍不在里面。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 另开一条规则 | 这是同一处隐藏的表情编号。分开开关会让群管开漏一处。 |
| 连原投票一起扫 | `poll_message` 是另一条消息。原投票发出时已经扫过。 |
| 把选项上的按标识提及也标上 | 选项文字官方只允许自定义表情。ADR 0567 已经把选项上的点名留下。 |
| 把编号写进证据 | 编号不进事件。 |

## 后果

- 规则关闭时，后加和删掉的选项上的自定义表情留下。看得见的字仍参与关键词。编号仍不进事件。
- 打开 `custom_emoji` 后，这种新选项和被删选项会删除。选项编号仍不进事件。
- 付费帖仍留下。空白编号不带这个标记。原投票上的表情不因为嵌套再标一次。选项上的按标识提及仍不带 `asTextMention`。
- 自部署没有额度，打开后就会删除。云模式超过当月次数后，还要把 `custom_emoji` 写进 `QUOTA_BASIC`，否则超额时这条规则会停。
- `chats.json` 整份替换的群要自己加上 `custom_emoji`，否则 `/rule` 会拒绝。
- 30 天保留期没有改。
