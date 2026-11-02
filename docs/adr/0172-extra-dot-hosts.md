# ADR 0172：点号接不上标签时再打开的主机名也留下

- 状态：已接受
- 日期：2026-11-02

## 背景

Android `LinkifyPort.WEB_URL` 的放松主机名里，点号只有在后面是标签字符时才开始下一个标签。再来一个点，或点号后面是连字符，当前匹配就停在前一个标签。后面如果还有网址，会再打开一次。

`http://example.com..http://bit.ly/…` 因此会打开 `bit.ly`。整段当成一个主机名时，短链被粘进后面的点。`http://example.com.-bit.ly/…` 打开的是 `bit.ly`，不是从连字符开始的标签。

点号后面还有标签时仍是同一个主机名，所以 `http://example.com.http://…` 不会单独打开后面的短链。点号后面是 `/`、`?` 或端口时，这个点留在当前网址里。下划线是单词字符，会挡住紧跟在后面的协议。

`@` 后面是点号时接不上用户信息。主机名是 `@` 前面的那一个。

## 决策

- 带协议的主机名由不能以连字符或下划线开头的标签组成，点号只连接下一个这样的标签。
- 点号后面是端口、`/` 或 `?` 时，这个点和后面的路径留在当前这一段。
- `@` 只有在结尾，或后面是 `/`、`?`、`_`、ASCII 字母数字、或一到五位且不再跟着单词字符的端口时，才算用户信息。
- 每段仍走现有的裸 IP、短链、邀请和 denylist 判断。只拆一层。最多 8 个。证据只留主机名。
- 切开之后单独的邀请地址仍按邀请读取。被这个点挡住的路径不改记成邀请。点号后面直接是 `/+…` 的邀请仍按原来的规则读取。
- 已经写在 `text_link`、按钮或其它结构化字段里的地址整段打开。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 整段只留第一个主机名 | 接不上的点号后面，短链和裸 IP 点得开。 |
| 点号后面的斜杠也切开 | `example.com./http://bit.ly` 仍是一个网址。 |
| 单个点号后面的标签也切开 | `example.com.http` 仍是一个主机名。 |

## 后果

- `http://example.com..http://bit.ly/…`、`http://example.com.-http://t.co/…`、`http://example.com.-bit.ly/…` 和 `http://news.example..http://203.0.113.139/…` 按现有短链或裸 IP 规则删除。证据仍只有主机名。
- `http://example.com.http://bit.ly/…`、`http://example.com./http://bit.ly/…`、`http://example.com.?http://bit.ly/…`、`http://example.com-http://bit.ly/…` 和 `http://example.com._http://bit.ly/…` 留着。
- `http://bit.ly./…` 和 `http://user:pass@bit.ly./…` 仍按短链删除。`http://bit.ly@/…` 留着。
- `https://t.me../+…` 不记成邀请。`https://t.me./+…` 仍按邀请删除。`http://example.com..https://t.me/+…` 按邀请删除。路径不进证据。
