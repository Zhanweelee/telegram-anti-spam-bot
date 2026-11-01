# ADR 0022：编辑后的消息走同一条流水线

- 状态：已接受
- 日期：2026-11-01

## 背景

Webhook 原先忽略 `edited_message`。先发一句正常的话，再改成广告，关键词和链接规则都看不到。Telegram 只有在 `allowed_updates` 包含 `edited_message` 时才会把编辑送过来。

core 不能出现 Telegram 的更新类型。编辑和普通消息的差别要落在内部 `Event` 上。

## 决策

- `edited_message` 归一化成 `kind: "message"`，并设置 `edited: true`。缺 chat、发送者或消息 id 时仍然忽略。
- 普通 `message` 不带这个字段。schema 只接受字面量 `true`，不接受 `false`。
- 编辑走现有的预过滤、检测器、聚合和动作。命中关键词时删除的是这条消息的 id。正文只留在当次请求的内存里，日志和审计仍不落原文。
- 编辑计入洪泛和重复窗口。短时间连续改消息和连续发消息用同一套阈值。
- `my_chat_member` 继续忽略。
- 部署文档里的 `allowed_updates` 加上 `edited_message`。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 编辑只跑关键词，不计入洪泛 | 连续改消息是一种刷屏。另做一套阈值要先有数据，现在用同一套更简单。 |
| 新增 `kind: "edit"` | 规则的 `when.eventKind` 和检测器都要再认一种事件。编辑后群里看到的仍是一条消息。 |
| 把编辑前的正文存下来对比 | 那是原文。ADR 0003 不允许默认落盘。 |

## 后果

- 已经设过 webhook 的部署要重新 `setWebhook`，把 `edited_message` 加进 `allowed_updates`。否则这项不会生效。
- 五次编辑会和五条新消息一样触发洪泛删除。
- `chats.json` 整份替换默认规则的群，编辑也只跑那一份规则。
