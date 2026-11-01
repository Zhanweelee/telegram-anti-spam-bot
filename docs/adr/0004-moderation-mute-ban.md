# ADR 0004：mute 与 ban

- 状态：已接受
- 日期：2026-11-01

## 背景

P0-04 要在删除之外支持禁言和封禁。处罚必须走端口，core 和动作不能认识 Telegram 的方法名。严重度已经是 ban > mute > delete，这一项不能把它改掉。

## 决策

- `ModerationPort` 增加 `muteActor` 和 `banActor`。
- mute 的目标带 `durationSeconds`。动作配置给出时长，上限 366 天。永久限制用 ban，而不是把时长设成零。
- ban 的目标只有 tenant、chat、actor。ban 不隐含 delete。规则如果两者都要，就同时写下 `ban` 和 `delete`。决策动作仍取最重的那个。
- 缺少 actor id 时动作返回 `failed` / `missing_actor`，不调用端口。dry-run 返回 `skipped` / `dry_run`，不调用端口。
- 这一项不发 Telegram HTTP。内存适配器只记录调用。以后的平台适配器把 duration 加成 `until_date`。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 一个 `restrict` 方法加上模式枚举 | mute 和 ban 的目标字段不同。拆开以后加权限字段不用改 ban。 |
| 端口直接收绝对时间 `untilIso` | 动作里没有时钟，时区容易算错。时长是配置，绝对时间留给发 HTTP 的适配器。 |
| 动作里直接 `fetch` Telegram | 平台类型会漏进动作包，也绕开 dry-run 和内存测试。 |

## 后果

- 所有 `ModerationPort` 的实现都要实现这两个方法。测试用的空实现可以什么都不做。
- Worker 注册 mute 时使用 3600 秒。要改时长就改动作配置，不是改规则 JSON。
- 真正调用 `restrictChatMember` / `banChatMember` 要另一次适配，并且仍遵守 `docs/limits.md` 的子请求预算。P1-01 只给验证用了 `restrictChatMember` 和解除限制，见 ADR 0009。mute 和 ban 仍然不发 HTTP。
