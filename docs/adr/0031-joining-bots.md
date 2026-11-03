# ADR 0031：从群外加入的 bot 直接封禁

- 状态：已接受
- 日期：2026-11-01

## 背景

别人可以把另一个 bot 拉进群。入群验证会跳过 `is_bot`，验证按钮也点不了。这个 bot 会留在群里。

本 bot 自己的进出走 `my_chat_member`，不是这条路径。

## 决策

- 只有「从群外加入」的 bot 带 `actor.bot: true`。旧状态是 `left`、`kicked` 或缺失，新状态是 `member`、`restricted` 或 `administrator`。已经在群里的升降级不带这个标记，也不封禁。
- 不写用户名、昵称或群名。不设 `membership: join`，所以人类用的验证规则不会套到 bot 上。
- 这种入群不因为 Telegram 状态是管理员就豁免。只有 bot 的 id 写在配置的管理员名单里时，`isAdmin` 才为真。
- 检测器 id 是 `bot`，放在 `@tasb/detector-bot`。默认规则 `bot_join` 对 `chat_member` 启用，命中后 `ban`。证据是 `bot:join`。
- 不改 ADR 0026 的基础检测器名单。`bot` 不在默认 `QUOTA_BASIC` 里。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 平台层看到 bot 就直接封禁 | 群规则关不掉，流水线也看不到这次决策。 |
| 和人类共用 `join` 检测器 | 封禁规则会连人类一起封，验证规则也会套到 bot 上。 |
| 把 `bot` 加进默认基础检测器 | 那是 ADR 0026 已经定下的名单。要改得另外确认。 |

## 后果

- 自部署默认不走额度，`bot_join` 一直有效。
- 云模式超过当月次数后，这条规则会停，直到 `QUOTA_BASIC` 写上 `bot`。
- `chats.json` 整份替换的群要自己加上 `bot_join`。
- 本 bot 被设为管理员时仍只记接入，不会封禁自己。
- 旧状态是 `restricted` 且 `is_member` 为 false 时，也算从群外回来。见 ADR 0357。
