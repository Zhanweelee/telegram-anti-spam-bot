# ADR 0690：加选项或删选项的发送者是聊天时不读占位名字

- 状态：已接受
- 日期：2026-11-06

## 背景

有人给投票加上选项，或删掉一个选项时，Android 的 `TL_messageActionPollAppendAnswer` 和 `TL_messageActionPollDeleteAnswer` 用 `DialogObject.getShortName(getUser(from_id))` 画操作的人。`getUser` 只查用户。发送者是聊天时查不到，短名是空字符串。这行不画聊天标题。

Bot API 把新选项放在 `poll_option_added`，被删选项放在 `poll_option_deleted`。发送者是聊天时，`sender_chat` 是那个聊天，`from` 是占位用户。见 `telegram-bot-api` 的 `messageSenderChat`。

ADR 0659 仍从 `from` 的短名留主机名。占位用户的名字不在这行里。这行也不画 `sender_chat` 的标题。编号和本群相同时，通用代发规则本来就不读标题。

## 决策

- 已经会标成 `pollNotice` 的 `added` 或 `deleted` 时，`sender_chat` 是对象就不再从 `from` 留主机名，也不从 `sender_chat.title` 留主机名。频道、群和超级群都一样。编号和本群相同也跳过。
- 没有 `sender_chat` 时，仍从 `from` 会画出来的短名留主机名。名为空时改用姓。空白名挡住姓。从下标 2 起的第一个空格后面不读。
- 编号不同的聊天标题仍由通用代发规则读取。不从 `chat.title` 另读。
- 选项文字仍按原来的正文。用户名和选项编号仍不读。
- 空对象、空字符串和布尔值仍不读发送者。
- 不新增检测器，不新增命令。菜单仍是 99 条。不改 ADR 0026 的基础检测器名单。`poll_notice` 仍默认关闭。短链仍走已有的 `links`。8 个主机名的上限不变。不调用 `stopPoll`。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 继续读 `from` | 占位用户的名字不在这行里。短链会删掉一条没有这个名字的提示。 |
| 改读 `sender_chat.title` | Android 只向用户表查发送者。标题上的短链并没有出现在这行里。 |
| 本群群名也读 | 选项增删从一开始就不读本群群名。 |
| 新命令 | 菜单只剩一个空位。现有 `links` 已经能删除短链。 |

## 后果

- 聊天加上或删掉选项时，不再因为占位名字或本群标题留下主机名。选项文字仍按正文。
- 别的聊天发到这个群时，标题仍由通用代发规则留下主机名。
- 用户仍按短名。关掉管理员豁免也不会因为本群标题删除这条提示。
- `example.com` 和公开的 `t.me/名字` 留下。付费帖仍不删除。
- 30 天保留期没有改。
