# ADR 0289：形近字母紧挨协议时草稿仍打开后面的网址

- 状态：已接受
- 日期：2026-11-03

## 背景

Android 不把七个西里尔形近字母、乌克兰语 `і` 和全角拉丁字母当成单词字符。`bАhttp://bit.ly/…` 会在这个字母前结束，再打开后面的网址。`example.comАhttp://bit.ly/…`、`www.example.comＡhttp://bit.ly/…` 和 `203.0.113.157Аhttp://bit.ly/…` 同样另开。`example.comАhttps://t.me/+…` 会另外打开邀请。

带协议的 `http://example.comАhttp://bit.ly/…` 仍是一条链接。斜杠后面的全角字母也留在路径里。`bАbit.ly` 是一条链接，主机名不是 `bit.ly`。`bіt.ly` 和全角的 `ｂｉｔ.ly` 仍要收成短链。

看得见的正文已经把紧挨协议的字母留下。隐藏的分享 `text` 先把 `А` 收成 `A`，`bАhttp://bit.ly` 变成 `bAhttp://bit.ly`，短链粘进标签。见 ADR 0190。

## 决策

- 分享 `text`、分享 `url`、私聊预填 `tg://msg` 的 `text` 和用户名草稿的 `text`，形近字母紧挨 `http://` 或 `https://` 时另开后面的网址。
- 带协议的同一段仍留在一起。夹在标签里的形近字母仍收成 ASCII。
- `bіt.ly` 和全角的 `ｂｉｔ.ly` 仍收成短链。`bАbit.ly` 不记成 `bit.ly`。
- 证据只留主机名。路径和邀请码不进证据。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 草稿继续把协议前面的字母收成 ASCII | `bАhttp://bit.ly` 会把 `http` 粘进标签，漏掉短链。 |
| 这些字母一律不再收成 ASCII | `bіt.ly` 和全角的 `ｂｉｔ.ly` 会漏掉。 |
| 夹在标签里的形近字母也不收 | `bАbit.ly` 会从中间拆出 `bit.ly`。 |

## 后果

- `t.me/share/url?text=bАhttp://bit.ly/…` 删除。分享 `url` 同样删除。证据仍只有主机名。
- `example.comАhttps://t.me/+…` 按邀请删除。路径和邀请码不进证据。
- `http://example.comАhttp://bit.ly/…` 和 `http://example.com/Ａhttp://bit.ly/…` 留着。`bАbit.ly` 留着。`bіt.ly` 和全角的 `ｂｉｔ.ly` 仍按短链删除。
- 组合附加符号紧挨在裸主机名和网址之间时，隐藏草稿仍会单独打开后面的短链。见 ADR 0290。
