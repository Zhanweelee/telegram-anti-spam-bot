# ADR 0435：私聊查看这个 bot 自己的管理员权限

- 状态：已接受
- 日期：2026-11-04

## 背景

`/who` 回报这个 bot 的编号。`/canadmin` 要再带上这个编号，才能看出它在某一群里是不是管理员。接入时最常见的失败是 bot 在群里，但没有删除或限制成员的权限。见 ADR 0027 和 ADR 0433。

`getMe` 返回当前 bot 的用户号。`getChatMember` 再用这个号读取它在目标群里的身份。`promoteChatMember` 会改权限，这一次只读。

## 决策

- 私聊命令 `/cani <chatId>`。群 id 要匹配 `^-?\d{1,20}$`。多出来的参数不发出请求。群聊里的同样文本不执行。
- 配置中的管理员可以查看任意群。接入目录里的人只能查看自己的群。
- 命令调用 `ModerationPort.readOwnAdmin`。配了 token 时先调用 `getMe`，参数是空对象。`id` 必须是正的安全整数，并且 `is_bot` 为 true。用户名和名字不读取。
- 通过之后再调用 `getChatMember`，参数只有 `chat_id` 和这个 bot 的 `user_id`。
- 返回的 `user.id` 必须是安全整数，并且和 `getMe` 的编号一致。名字和自定义头衔不进入回复，也不进入日志。
- 状态是 `creator` 时，回复写创建者，权限列表为空，不写能不能改。
- 状态是 `administrator` 时，只写出值为 true 的权限，并写 `can_be_edited` 的 on 或 off。文档里必填的布尔值缺了或不是布尔值时，整份回复是「参数无效」。
- 状态是 `member`、`restricted`、`left` 或 `kicked` 时，回复管理员无。不区分还在群里和已经离开。
- `getMe` 的编号不合格时，不调用 `getChatMember`。
- 没有处罚端口、没有 token，或调用失败时，回复「参数无效」。日志是 `operator_rejected`，不写异常文本，也不写 token。
- 没有 token 的 Worker 不编一份权限。内存适配器不知道这个 bot 的身份。
- 不调用 `promoteChatMember`。不改 `/canadmin`、`/who` 和 `/admins`。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 让操作者自己把 `/who` 的编号贴进 `/canadmin` | 接入失败时要记两个命令，最常见的权限问题仍然不直观。 |
| 从 bot token 里切出用户号 | token 的形状不是公开契约。`getMe` 才是这个 bot 的编号。 |
| 在 `my_chat_member` 里保存每一项权限 | ADR 0027 只记 `admin` 或 `gone`。权限会变，私聊查询读当前值。 |

## 后果

- 成功只表示读到了这个 bot 当前的身份。普通成员和已经离开都回复管理员无。
- 一次查询最多是两次 Telegram 子请求。管理员名单、黑名单和禁言都不变。
- `/canadmin` 仍要调用方给出成员号，请求体不变。
- 30 天保留期不动。
