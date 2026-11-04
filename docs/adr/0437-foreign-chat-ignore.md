# ADR 0437：共用编号的商业和访客会话先忽略

- 状态：已接受
- 日期：2026-11-04

## 背景

Telegram 的商业连接和访客会话可以和某个 bot 对话共用同一个 `chat.id`。Bot API 把它们写成独立会话：`business_connection_id` 或 `guest_query_id` 出现在普通 `message` 或 `edited_message` 上时，这条消息不属于那个编号对应的群。按 `chat.id` 删除或封禁会打到另一段对话。

独立的更新键 `business_message`、`edited_business_message`、`deleted_business_messages`、`guest_message` 和 `stopped_message_generation` 本来就不会进入归一化。缺口是普通 `message` 和 `edited_message` 仍会读正文并按 `chat.id` 送去审核。

## 决策

- `message` 或 `edited_message` 上，`business_connection_id` 或 `guest_query_id` 是长度大于 0 的字符串时，在读取正文、主机名和摘要之前返回忽略。
- 空字符串不忽略。不是字符串的值不忽略，也不写进事件。
- 只含空白的字符串长度大于 0，同样忽略。不先 trim。
- 上面那些独立更新键继续忽略。连接编号、访客查询编号、草稿编号和正文都不进事件，也不进日志。
- 不新增命令。不调用 `getBusinessConnection`。不开始审核 `channel_post`。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 仍按 `chat.id` 删除或封禁 | Telegram 写明这是另一段对话。同一个编号会处罚错对象。 |
| 把连接编号存进事件 | 编号和正文一样不能落盘。审核用不上它。 |
| 每条消息调用 `getChatMember` 来区分 | 免费计划的子请求不该花在每条消息上。见 ADR 0027。 |

## 后果

- 一条真正的群消息如果带上非空字符串编号，会被跳过。这是放行，避免打错对话。
- 空字符串仍按普通消息审核。数字等非字符串值不复制进事件，消息仍审核。
- 30 天保留期不动。
