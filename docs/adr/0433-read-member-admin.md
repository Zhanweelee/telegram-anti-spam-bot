# ADR 0433：私聊可以查看一个人的管理员权限

- 状态：已接受
- 日期：2026-11-04

## 背景

`/admins` 一次列出全群管理员。名单超过 3500 个字符时，后面的人会被略去。管理员从 `/logs` 拿到的是一个人的编号，要的是这个人有没有管理权限，以及这个 bot 能不能改。

`getChatMember` 在状态是 `administrator` 时带上各项 `can_*`，也带上必填的 `can_be_edited`。创建者的对象写明拥有全部管理权限，但没有逐项 `can_*`，也没有 `can_be_edited`。`/admins` 不写 `can_be_edited`，自定义头衔也不进回复。

## 决策

- 私聊命令 `/canadmin <chatId> <actorId>`。两个 id 都要匹配 `^-?\d{1,20}$`。多出来的参数不发出请求。群聊里的同样文本不执行。
- 配置中的管理员可以查看任意群。接入目录里的人只能查看自己的群。
- 命令调用 `ModerationPort.readMemberAdmin`。配了 token 时，Telegram 适配器调用 `getChatMember`，参数只有 `chat_id` 和 `user_id`。
- 返回的 `user.id` 必须是安全整数，并且和请求的成员号一致。名字、用户名和自定义头衔不进入回复，也不进入日志。
- 状态是 `member`、`restricted`、`left` 或 `kicked` 时，回复管理员无。不读取这些状态上偶然出现的权限字段。
- 状态是 `creator` 时，回复创建者。权限列表为空。不写能不能改。`is_anonymous` 必须是布尔值。为 true 时写匿名。
- 状态是 `administrator` 时，只写出值为 true 的权限。显式 false 不写。频道或群才有的权限缺了也不写。这些字段如果出现了但不是布尔值，整份回复是「参数无效」。文档里必填的布尔值缺了或不是布尔值时，整份回复也是「参数无效」，不写出已经读到的项。`can_be_edited` 为 true 写可改 on，为 false 写可改 off。
- 没有 token、没有这个方法，或调用失败时回复「参数无效」。日志只写 `operator_rejected`，带上 eventId、chatId 和命令名。不写异常文本、token、名字或自定义头衔。
- 不调用 `promoteChatMember`。不修改 `/admins` 的截断，也不给创建者补权限词。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 把 `can_be_edited` 加进 `/admins` 的每一行 | 名单已经按 3500 个字符截断。多一个词会让更多人被略去。一个人的查询不需要重写整份名单。 |
| 给创建者补上全部打开的权限 | 对象里没有这些字段。角色本身已经表示拥有全部权限。`/admins` 也保持空列表。 |
| 没有 token 时回复不是管理员 | 人可能是创建者。管理员会按一份编出来的身份做决定。 |

## 后果

- 看一个人的管理员权限是一次 `getChatMember`。`/admins` 仍是另一次请求，截断规则不变。
- 30 天保留期不动。
