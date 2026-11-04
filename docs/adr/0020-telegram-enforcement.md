# ADR 0020：有 token 时，删除、禁言和封禁各发一次请求

- 状态：已接受
- 日期：2026-11-01

## 背景

ADR 0004 把 mute 和 ban 留在端口上，并写明当时不发 Telegram HTTP。ADR 0009 只给入群验证接了 `restrictChatMember`。结果是：配了 `TELEGRAM_BOT_TOKEN` 的自部署 bot 能限制新成员，但关键词命中后的删除、禁言和封禁仍然只记在内存里。群里的垃圾消息还在。

`docs/limits.md` 写明免费计划每次请求大约 50 次外部子请求。一次处罚应该只占一次。

## 决策

- `createTelegramModerator` 在 token 非空时：
  - `deleteMessage` 调用 `deleteMessage`，只带 `chat_id` 和 `message_id`。只给一个用户看见的消息后来由 ADR 0125 改调 `deleteEphemeralMessage`。
  - `muteActor` 调用 `restrictChatMember`。权限与入群禁言相同，`until_date` 是当前 unix 秒加上 `durationSeconds`。
  - `banActor` 调用 `banChatMember`，`revoke_messages` 固定为 false。不顺带调用 `deleteMessage`。
- token 为空或只有空白时，这三个方法抛出 `delete_unavailable`、`mute_unavailable`、`ban_unavailable`，并且不调用 `fetch`。Worker 在没有 token 时仍使用内存适配器，所以本地测试和未配置的部署不会打到 Telegram。
- HTTP 失败或网络错误抛出 `delete_failed`、`mute_failed`、`ban_failed`。错误对象不带响应正文，也不带 token。流水线捕获后记 `action_failed`，决策保持不变。
- dry-run 在 core 里就跳过动作，不会进入这个适配器。
- core、动作包和检测器仍然不出现 Telegram 的方法名。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 没有 token 时也让 Telegram 适配器静默成功 | 调用方会以为消息已经删掉。Worker 继续用内存适配器记录「本来会处罚」。 |
| ban 时把 `revoke_messages` 设为 true | 会删掉该成员的历史消息。ADR 0004 要求 ban 不隐含 delete。 |
| 失败时把 Telegram 的 `description` 写进日志 | 描述里可能有群标题或其它不该落盘的内容。固定错误码够用。 |

## 后果

- 一条规则如果同时写下 `ban` 和 `delete`，流水线会发两次请求。这是原来的动作列表，不是这一项新加的扇出。
- 子请求预算仍按 `docs/limits.md`。默认路径不会为了处罚再去拉信誉或模型。
- isolate 内存里的处罚记录只在没有 token 时使用。配了 token 之后，以 Telegram 的响应为准。
- 私聊 `/unban` 见 ADR 0362。没有 token 时不把解除封禁记成已经成功。私聊 `/ban` 见 ADR 0364，私聊 `/mute` 见 ADR 0365，私聊 `/delete` 见 ADR 0367，私聊 `/deletes` 见 ADR 0374，私聊 `/decline` 见 ADR 0368，私聊 `/approve` 见 ADR 0369，私聊 `/bansender` 见 ADR 0370，私聊 `/unbansender` 见 ADR 0371，私聊 `/lock` 见 ADR 0372，私聊 `/unlock` 见 ADR 0373，私聊 `/perms` 见 ADR 0375，私聊 `/clearreact` 见 ADR 0376，私聊 `/revoke` 见 ADR 0377，私聊 `/unpin` 见 ADR 0378，私聊 `/admins` 见 ADR 0379，私聊 `/untopic` 见 ADR 0380，私聊 `/closetopic` 见 ADR 0381，私聊 `/opentopic` 见 ADR 0382，私聊 `/hidegeneral` 见 ADR 0383，私聊 `/showgeneral` 见 ADR 0384，私聊 `/deltopic` 见 ADR 0385，私聊 `/count` 见 ADR 0386，私聊 `/pin` 见 ADR 0387，私聊 `/unpinmsg` 见 ADR 0388，私聊 `/unreact` 见 ADR 0389，私聊 `/delphoto` 见 ADR 0390，私聊 `/leave` 见 ADR 0391，私聊 `/tag` 见 ADR 0392，私聊 `/delstickers` 见 ADR 0393，私聊 `/boosts` 见 ADR 0394，私聊 `/react` 见 ADR 0395，私聊 `/title` 见 ADR 0396，私聊 `/desc` 见 ADR 0397，私聊 `/newtopic` 见 ADR 0398，私聊 `/rentopic` 见 ADR 0399，私聊 `/rengeneral` 见 ADR 0400，私聊 `/stickers` 见 ADR 0401，私聊 `/admintitle` 见 ADR 0402，私聊 `/declinepost` 见 ADR 0403，私聊 `/delephemeral` 见 ADR 0404，私聊 `/myrights` 见 ADR 0405，私聊 `/botrights` 见 ADR 0406，私聊 `/setcommands` 见 ADR 0407，私聊 `/commands` 见 ADR 0408，私聊 `/delcommands` 见 ADR 0409，私聊 `/menubutton` 见 ADR 0410，私聊 `/button` 见 ADR 0411，私聊 `/botname` 见 ADR 0412，私聊 `/myname` 见 ADR 0413，私聊 `/botdesc` 见 ADR 0414，私聊 `/mydesc` 见 ADR 0415，私聊 `/botshort` 见 ADR 0416，私聊 `/myshort` 见 ADR 0417，私聊 `/who` 见 ADR 0418，私聊 `/hook` 见 ADR 0419。这些命令同样不把内存记录回复成已经生效。
