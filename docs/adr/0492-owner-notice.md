# ADR 0492：群主变更按群删除

- 状态：已接受
- 日期：2026-11-05

## 背景

群主换人时，`chat_owner_changed.new_owner` 是新群主。群主离开时，`chat_owner_left` 可以带下一位，也可以不带。新群主的可见名字已经按 ADR 0120 成为正文。名字干净时这行会留下。没有下一位时正文是空的，关键词看不到。把它并进 `service_notice` 会让只想删入群和退群的群把换群主也删掉。

## 决策

- `chat_owner_changed.new_owner` 是用户对象时，事件带 `ownerNotice: "changed"`。不写用户编号。新群主的名字仍按 ADR 0120 成为正文。
- `chat_owner_left` 是对象时带 `left`。没有 `new_owner` 也带。同时出现时先认换人。空的换人对象、`new_owner` 不是对象，以及布尔值不带这个标记。
- 已有正文时正文不变。发送者姓名仍不进事件。
- 检测器在 `@tasb/detector-owner`，id 是 `owner_notice`。`message.ownerNotice` 是换人或离开时返回 score 1。证据是 `owner:changed` 或 `owner:left`。
- 默认规则关闭。私聊 `/rule <chatId> owner_notice on` 之后删除这两种提示，`off` 回到留下。
- 不调用转让群主的方法。群主身份不变。付费帖仍不删除。
- 不新增命令。菜单仍是 99 条。
- 不改 ADR 0026 的基础检测器名单。`owner_notice` 不在里面。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 默认打开 | 普通换群主会被删掉。群要自己打开。 |
| 并进 `service_notice` | 只想删入群和退群的群会把换群主也删掉。 |
| 把用户编号写进证据 | 编号不是广告。名字仍留在正文里。 |
| 新命令 `/owner` | 菜单还剩 1 个位置，留给以后的操作命令。 |

## 后果

- 规则关闭时，换人和离开都留下。名字干净时关键词仍看不见这行，除非名字里本身有关键词或短链。
- 名字里的默认正则后来由 ADR 0533 删除这行。关掉 `owner_notice` 不会关掉它。
- 打开 `owner_notice` 后，这个群里的换人和离开提示会删除。入群和退群仍只看 `service_notice`。付费帖仍留下。
- 自部署没有额度，打开后就会删除。云模式超过当月次数后，还要把 `owner_notice` 写进 `QUOTA_BASIC`，否则超额时这条规则会停。
- `chats.json` 整份替换的群要自己加上 `owner_notice`，否则 `/rule` 会拒绝。
- 30 天保留期没有改。
