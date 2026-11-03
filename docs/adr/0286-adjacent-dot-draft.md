# ADR 0286：ASCII 点后面的点状字符仍留在草稿里

- 状态：已接受
- 日期：2026-11-03

## 背景

Android 把 `·`、`•`、`‧`、`∙`、`⋅`、`・`、`．`、`﹒` 和 `｡` 当作标签字符，不当作点。`http://example.com.．http://bit.ly/…`、`http://example.com.．/http://bit.ly/…` 和 `http://example.com.·?http://bit.ly/…` 都是一条链接，不会再打开短链。

没有协议的 `example.com.．http://bit.ly/…` 和 `www.example.com.．http://bit.ly/…` 仍会在多出来的点前结束，后面的短链照样打开。真正的 `..` 也仍拆开。单独充当分隔符的 `bit．ly` 仍要收成短链。

看得见的正文已经这样切。隐藏的分享 `text` 把 `http://example.com.．http://bit.ly/…` 在这个点状字符处拆开，短链被另抽出来。见 ADR 0186。

## 决策

- 分享 `text`、分享 `url`、私聊预填 `tg://msg` 的 `text` 和用户名草稿的 `text`，带协议的主机名在 ASCII `.` 后面遇到这些点状字符时不另开后面的网址。
- 没有协议的裸域名和 `www.` 仍在这个点状字符前结束，后面的网址另开。
- 前面不是 ASCII `.` 的点状字符仍收成点。真正的 `..` 仍拆开。
- 证据只留主机名。路径和邀请码不进证据。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 草稿继续在点状字符处结束带协议的主机名 | `http://example.com.．http://bit.ly` 会删掉 Android 留在同一条链接里的短链。 |
| 点状字符一律不再收成点 | `bit．ly` 会漏掉。 |
| 没有协议的 `www.` 也把点状字符留在这一段 | `www.example.com.．http://bit.ly` 会漏掉 Android 打开的短链。 |

## 后果

- `t.me/share/url?text=http://example.com.．http://bit.ly/…`、斜杠后面的同一段，以及问号前面的间隔号 `·`，都留着。`http://example.com.．/https://t.me/+…` 不记成邀请。
- `example.com.．http://bit.ly/…` 和 `www.example.com.．http://bit.ly/…` 删除。分享 `url` 同样删除。证据仍只有主机名。
- `bit．ly`、`example.com．/http://bit.ly/…` 和 `http://example.com..http://bit.ly/…` 仍按短链删除。
