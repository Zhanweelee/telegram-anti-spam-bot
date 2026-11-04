# ADR 0513：富文本引用链接按群删除

- 状态：已接受
- 日期：2026-11-05

## 背景

富文本里指向引用的链接可以和看得见的字不同。字段是 `reference_name`。这个字段不进事件，关键词看不见引用名字。看得见的字已经可以成为正文。

引用本身由 `rich_reference` 决定。日期时间的 Unix 时间、自定义表情编号和公式源码仍按既有决定留在事件外面。

## 决策

- `type` 正好是 `reference_link`，并且 `reference_name` 去掉空白后非空时，事件带 `asRichReferenceLink: true`。嵌套在别的块里也同样。
- 空白、布尔值和缺名字不带这个标记。引用不带这个标记。日期时间不带这个标记。
- 名字不进事件，也不进证据。看得见的字仍是正文。已有 `text` 或 `caption` 时正文不变，名字不并进去。
- 检测器在 `@tasb/detector-rich`，id 是 `rich_reference_link`。只在 `message.asRichReferenceLink` 为 true 时返回 score 1。证据是 `rich:reference_link`。
- 默认规则关闭。私聊 `/rule <chatId> rich_reference_link on` 之后删除这种正文，`off` 回到留下。
- 不并进 `rich_reference`。不调用读取或改写引用名字的方法。付费帖仍不删除。
- 不新增命令。菜单仍是 99 条。
- 不改 ADR 0026 的基础检测器名单。`rich_reference_link` 不在里面。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 并进引用 | 只想删引用的群会把指向引用的链接也删掉。 |
| 把名字接到正文后面 | 同一条消息的哈希会变，名字也会进事件。 |
| 把名字写进证据 | 名字不进事件。 |
| 默认打开 | 有的群用富文本排版。打开之前不改现有群。 |
| 新命令 `/cite` | 菜单还剩 1 个位置，留给以后的操作命令。 |

## 后果

- 规则关闭时，富文本引用链接留下。看得见的字仍参与关键词。名字仍不进事件。
- 打开 `rich_reference_link` 后，这个群里的这种链接会删除。打开 `rich_reference` 仍不删除它。付费帖仍留下。
- 自部署没有额度，打开后就会删除。云模式超过当月次数后，还要把 `rich_reference_link` 写进 `QUOTA_BASIC`，否则超额时这条规则会停。
- `chats.json` 整份替换的群要自己加上 `rich_reference_link`，否则 `/rule` 会拒绝。
- 30 天保留期没有改。
