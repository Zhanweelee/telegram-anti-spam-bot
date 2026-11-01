# ADR 0009：入群按钮验证

- 状态：已接受
- 日期：2026-11-01

## 背景

P1-01 要求新成员在通过验证前不能发言。超时和通过都要留下不含原文的审计。检测器失败不能把人困在群里。core 仍然不能出现 Telegram 类型。delete、mute、ban 的 HTTP 见 ADR 0020。

## 决策

- `Event` 增加 `kind: "challenge"`、可选的 `membership: "join"`，以及 `challenge.nonce`（16 位十六进制）。nonce 不是消息正文。
- `CaptchaStore` 按 tenant、chat、actor 保存挑战。`beginChallenge` 先写入，再 `restrictActor`。限制抛错就删除挑战并继续抛出。
- `resolveChallenge` 在 nonce 匹配且未过期时 `releaseActor`、删除挑战、写入 `captcha_passed`。已过期则删除挑战并写入 `captcha_expired`，不调用 `releaseActor`。nonce 不对时记 `captcha_mismatch`，日志只有 `eventId` 和 `chatId`。
- `join` 检测器只在 `membership === "join"` 时返回 score 1。默认规则 `new_member` 的动作是 `captcha`，阈值 1。管理员仍走预过滤，不验证。
- 平台适配层把「从群外成为 member 或 restricted，且不是 bot」标成 join。按钮 `callback_data` 为 `c:` 加 nonce 时收成 challenge。其它回调忽略，但在配置了 token 时仍应答，清掉转圈。
- 有 `TELEGRAM_BOT_TOKEN` 时，`restrictActor` / `releaseActor` 调用 `restrictChatMember`，按钮用一次 `sendMessage`。没有 token 时限制直接失败，动作回滚挑战。按钮发送失败时解除限制并删除挑战。
- delete、mute、ban 的 HTTP 不在这一项里，见 ADR 0020。
- 挑战放在 isolate 内存。账号只保留一个 Cron，`*/15 * * * *`，调用 `expireChallenges`。它不解除 Telegram 限制，`until_date` 自己到期。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 只在内存里记录限制，不发按钮 | 真实群里的成员不会被限制，也点不了按钮。验收对不上。 |
| 在动作里引入 grammY，直接使用 Telegram 类型 | core 和动作会认识平台类型，违反 ADR 0001 和 ADR 0004。 |
| 把挑战放进 D1 或 KV | 每次入群都写一次，和免费额度的写预算相反。内存足够支撑这一项；跨 isolate 的持久验证以后再单独立项。 |

## 后果

- `chats.json` 整份替换默认规则。覆盖过的群不会自动带上 `new_member`。
- 没配 `DB` 时，isolate 重启会丢掉未完成的挑战。若限制已经发到 Telegram，成员要等到 `until_date`。配了 `DB` 之后的跨 isolate 挑战见 ADR 0051。
- 问答验证还没有做。按钮是这一项的唯一方式。
- 超时审计和通过审计都不含原文，也不含 nonce。
