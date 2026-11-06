# ADR 0692：建议帖的发送者是聊天时不读占位名字

- 状态：已接受
- 日期：2026-11-06

## 背景

建议帖通过、余额不足、拒绝、付款到账或退款时，Android 画的是频道名和保存下来的话题用户。频道名来自这条消息所在对话。话题用户来自 `saved_peer_id`。这几行不用消息自己的 `fromObject`。

Bot API 把通过放在 `suggested_post_approved`，失败放在 `suggested_post_approval_failed`，付款放在 `suggested_post_paid`，退款放在 `suggested_post_refunded`，拒绝放在 `suggested_post_declined`。发送者是聊天时，`sender_chat` 是那个聊天，`from` 是占位用户。见 `telegram-bot-api` 的 `messageSenderChat`。

ADR 0600 和 ADR 0601 仍从 `from` 的可见名字留主机名。占位用户的名字不在这几行里。这几行也不画 `sender_chat` 的标题。编号和本群相同时，通用代发规则本来就不读标题。话题用户仍按 ADR 0650、ADR 0651 和 ADR 0652。

## 决策

- 已经会标成 `postNotice` 或 `asPostDeclined` 的提示上，`sender_chat` 是对象时，不从 `from` 留主机名，也不从 `sender_chat.title` 留主机名。频道、群和超级群都一样。编号和本群相同也跳过。
- 没有 `sender_chat` 时，仍从 `from` 的可见名字留主机名。名的长度大于 0 时不读姓。空白也算有名。
- 编号不同的聊天标题仍由通用代发规则读取。不从 `chat.title` 另读。
- 付款失败、退款、有价通过和拒绝上画出的话题用户仍按原来的全名。
- 空对象、负数、其它币种、其它原因和布尔值仍不读发送者。拒绝的空对象仍算拒绝。
- 不新增检测器，不新增命令。菜单仍是 99 条。不改 ADR 0026 的基础检测器名单。`post_notice` 和 `post_declined` 仍默认关闭。短链仍走已有的 `links`。8 个主机名的上限不变。不调用 `approveSuggestedPost` 或 `declineSuggestedPost`。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 继续读 `from` | 占位用户的名字不在这几行里。短链会删掉一条没有这个名字的提示。 |
| 改读 `sender_chat.title` | Android 这几行不画消息发送者。标题上的短链并没有作为发送者出现。 |
| 本群群名也读 | 建议帖从一开始就不读本群群名。 |
| 新命令 | 菜单只剩一个空位。现有 `links` 已经能删除短链。 |

## 后果

- 聊天处理建议帖时，不再因为占位名字或本群标题留下主机名。话题用户的名字仍按原来的规则。
- 别的聊天发到这个群时，标题仍由通用代发规则留下主机名。
- 用户仍只读名。关掉管理员豁免也不会因为本群标题删除这条提示。
- `example.com` 和公开的 `t.me/名字` 留下。付费帖仍不删除。
- 30 天保留期没有改。
