# ADR 0167：路径放不下的字符后面打开的主机名也留下

- 状态：已接受
- 日期：2026-11-02

## 背景

Android `LinkifyPort.WEB_URL` 的路径收得下字母、数字和一部分标点，收不下 `|`、`\`、`[`、`]`、`^`、`` ` ``、`{`、`}` 和控制字符。匹配在这里结束，后面如果还有网址，会再打开一次。

`http://example.com|http://bit.ly/…` 因此会打开 `bit.ly`。整段当成一个地址时，主机名只剩 `example.com`。反斜杠、方括号和没有协议的 `bit.ly` 也一样。`http://example.com/http://bit.ly` 的斜杠仍在路径里，只打开 `example.com`。

## 决策

- 抽网址时在这些字符上切开，后面的网址按自己的一段来抽主机名。
- 每段仍走现有的裸 IP、短链、邀请和 denylist 判断。只拆一层。最多 8 个。证据只留主机名。
- 切开之后单独的邀请地址仍按邀请读取。同一段里被字符挡住的路径不改记成邀请。
- 已经写在 `text_link`、按钮或其它结构化字段里的地址整段打开。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 整段只留第一个主机名 | 竖线后面的短链和裸 IP 点得开。 |
| 路径里的每个斜杠都再拆一次 | `example.com/http://bit.ly` 打开的是前面的网站。 |
| 被挡住的路径改记成邀请 | `t.me\|/+邀请码` 打开的是没有这段路径的主机名。 |

## 后果

- `http://example.com|http://bit.ly/…`、`http://example.com\http://t.co/…`、`http://example.com|bit.ly/…` 和 `http://news.example|http://203.0.113.134/…` 按现有短链或裸 IP 规则删除。证据仍只有主机名。
- `http://example.com|http://news.example/…` 留着。`https://t.me|/+…` 不记成邀请。
- `http://example.com|https://t.me/+…` 按邀请删除。路径不进证据。
- 没写完的百分号后面，Android 另外打开的主机名也留下。见 ADR 0168。
