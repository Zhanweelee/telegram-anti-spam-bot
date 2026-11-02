# ADR 0202：编码点状间隔号不再贴出下一条主机名

- 状态：已接受
- 日期：2026-11-02

## 背景

Android 不会在匹配前把百分号编码的点状间隔号收成点。`%C2%B7bit.ly/…` 打开的是 `B7bit.ly`。`%E2%80%A2bit.ly/…`、`%E2%80%A7bit.ly/…`、`%E2%88%99bit.ly/…`、`%E2%8B%85bit.ly/…`、`%E3%83%BBbit.ly/…`、`%EF%BC%8Ebit.ly/…`、`%EF%B9%92bit.ly/…` 和 `%EF%BD%A1bit.ly/…` 也是把最后一对十六进制留在主机名开头。

`see%C2%B7bit.ly/…`、`example.com%C2%B7bit.ly/…` 和 `www%C2%B7bit.ly/…` 打开的是 `B7bit.ly`，不是 `see.bit.ly`。`%C2%B7http://bit.ly/…`、`http://%C2%B7bit.ly/…` 和 `%C2%B7203.0.113.169/…` 不会打开短链或这个地址。`%C2%B7bit.ly/http://…` 把后面的网址吞进同一条匹配。

`%C2%B7www.bit.ly/…` 打开的是 `B7www.bit.ly`。这个主机名仍以 `.bit.ly` 结尾。`%C2%B7.bit.ly/…` 打开的是 `B7.bit.ly`。`http://bit.ly%C2%B7evil.com/…` 仍先打开 `bit.ly`。

`bit%C2%B7ly` 仍要收成短链。字面 `·bit.ly` 和 `bit·ly` 也仍要收成短链。第二层 `%25C2%25B7` 和句号 `。` 的编码仍保留。公开的 `foldEncodedMiddleDot` 仍把每一层点状间隔号收成对应字符。

主机名扫描如果先把贴在前面的 `%C2%B7` 收成点，`%C2%B7bit.ly` 会变成 `bit.ly`，`%C2%B7203.0.113.169` 会变成一条裸 IP，`%C2%B7http://bit.ly` 会变成 `http://bit.ly`。

## 决策

- 只改主机名扫描。公开的 `foldEncodedMiddleDot` 仍收成对应字符。
- 主机名扫描里，编码点状间隔号后面已经是主机名、`.` 加主机名，或 `http://` / `https://` 时留下。大小写都算。
- 主机名含裸域名和点分 IPv4。标签中间、后面接不上主机名时仍收成点。`bit%C2%B7ly` 仍收成 `bit.ly`。
- 字面点状间隔号仍收成点。第二层和句号 `。` 的编码仍保留。
- 每段仍走现有的短链、裸 IP、邀请和 denylist 判断。只拆一层。最多 8 个。证据只留主机名。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 主机名扫描里的编码点状间隔号一律留下 | `bit%C2%B7ly` 会漏掉。 |
| 公开的 `foldEncodedMiddleDot` 一起改 | 关键词、正则和结构化网址仍要收成对应字符。 |
| 只留 `%C2%B7` | 其余八个点状间隔号的编码仍会贴出短链。 |

## 后果

- `%C2%B7bit.ly/…` 和同一组其余编码留着。`see%C2%B7bit.ly/…`、`www%C2%B7bit.ly/…` 和 `example.com%C2%B7bit.ly/…` 留着。
- `%C2%B7http://bit.ly/…`、`http://%C2%B7bit.ly/…` 和 `%C2%B7203.0.113.169/…` 留着。`%C2%B7bit.ly/http://…` 留着。
- `bit%C2%B7ly`、字面 `·bit.ly` 和 `bit·ly` 仍按短链删除。
- `%C2%B7www.bit.ly/…` 和 `%C2%B7.bit.ly/…` 仍按短链删除。证据是 `b7www.bit.ly` 和 `b7.bit.ly`。
- `http://bit.ly%C2%B7…` 仍按 `bit.ly` 删除。第二层 `%25C2%25B7` 仍留下。路径不进证据。
- 百分号编码的 ASCII 点贴在已经写完的主机名前面时，收成 Android 留下的两位十六进制。见 ADR 0203。
