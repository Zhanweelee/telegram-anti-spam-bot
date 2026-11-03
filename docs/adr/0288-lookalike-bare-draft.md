# ADR 0288：点状字符拼成的草稿主机名不再盖住后面的网址

- 状态：已接受
- 日期：2026-11-03

## 背景

Android 不把 `·`、`•`、`‧`、`∙`、`⋅`、`・`、`．`、`﹒` 和 `｡` 当成点。`bit．ly．com/http://t.co/…`、`bit·ly·com/http://t.co/…`、`safe．com/http://bit.ly/…` 和 `www.example．com/http://bit.ly/…` 都不是前面那段域名，只会打开后面的网址。`bit．ly．com/https://t.me/+…` 会另外打开邀请。

带协议的 `http://bit．ly．com/http://t.co/…` 仍是一条链接。`b·it.ly` 也是一条链接，主机名不是 `bit.ly`。单独充当分隔符的 `bit．ly` 仍要收成短链。换行拆开的 `bit．` 加 `ly` 也仍要收成短链。`bit．ly` 后面紧挨换行再接字母时，不再单独命中。

看得见的正文已经这样切。隐藏的分享 `text` 先把点状字符收成点，`bit．ly．com/http://t.co` 变成 `bit.ly.com`，路径盖住后面的短链。见 ADR 0189。

## 决策

- 分享 `text`、分享 `url`、私聊预填 `tg://msg` 的 `text` 和用户名草稿的 `text`，没有协议、又用点状字符当点的主机名，不盖住后面的网址。
- 带协议的同一段仍留在一起。`b·it.ly` 不记成 `bit.ly`。
- 单独充当分隔符的 `bit．ly` 仍收成短链。点状字符旁边的换行仍交给粘连扫描吃掉。
- 证据只留主机名。路径和邀请码不进证据。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 草稿继续把这些点状字符收成点再抽网址 | `bit．ly．com/http://t.co` 会收成 `bit.ly.com`，路径盖住后面的短链。 |
| 点状字符一律不再收成点 | `bit．ly` 会漏掉。 |
| 换行一律改成空格 | `bit．` 加换行再接 `ly` 接不上，短链会漏掉。`bit．ly` 后面的换行又会把短链单独留下。 |

## 后果

- `t.me/share/url?text=bit．ly．com/http://t.co/…`、`safe．com/http://bit.ly/…` 和 `www.example．com/http://bit.ly/…` 删除。分享 `url` 同样删除。证据仍只有主机名。
- `bit．ly．com/https://t.me/+…` 按邀请删除。路径和邀请码不进证据。
- `http://bit．ly．com/http://t.co/…` 和 `b·it.ly/…` 留着。`bit．ly` 和换行拆开的 `bit．` 加 `ly` 仍按短链删除。
