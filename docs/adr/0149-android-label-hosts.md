# ADR 0149：Android 子域标签只留主机名

- 状态：已接受
- 日期：2026-11-02

## 背景

Android 把 `标签.t.me/后面` 收成 `t.me/标签/后面`。`s.t.me/用户名` 因此变成 `t.me/s/用户名`，前面的 `s` 被拿掉，`text` 写进用户草稿。`share.t.me/url` 和 `msg.t.me/url` 变成已经会打开分享的 `t.me/share/url` 和 `t.me/msg/url`。

外层主机名不是短链。短链、裸 IP 和邀请可以只写在查询里。桌面端不会做这层改写。Android 会。

`share.t.me` 本身仍按用户名打开，不是分享。`share.t.me/other` 也不是 `share/url`。

## 决策

- `s.t.me` 上只有一段公开用户名时，从 `text` 抽出主机名。
- `share.t.me/url` 和 `msg.t.me/url` 按现有分享链接，从 `url` 和 `text` 抽出主机名。
- 这个主机名走现有的裸 IP、短链、邀请和 denylist 判断。只拆一层。
- 用户名和路径不进证据。`text` 不进入正文，也不参与关键词。
- 保留名、`s.telegram.me`、`share.t.me`、`share.t.me/other` 和其它标签不读。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 只认 `t.me/s/用户名` | Android 会先把子域标签接到路径前面。 |
| 任何 `标签.t.me` 都改写 | 普通 `用户名.t.me` 不是这三枚标签。 |
| `share.t.me/other` 也读 | 分享只认路径正好是 `url`。 |

## 后果

- `s.t.me/用户名` 的 `text`，以及 `share.t.me/url` 和 `msg.t.me/url` 的 `url`，是裸 IP、短链或邀请时，现有链接规则删除这条消息。证据仍只有主机名。
- 保留名、别的官方域名和其它路径留着。
- 再套一层仍放行。用户名不进证据。
- `t.me/s/用户名/下一段` 和 `s.t.me/用户名/下一段` 后来由 ADR 0150 读取 `text`。大写 `S` 和 `www` 仍不读。
