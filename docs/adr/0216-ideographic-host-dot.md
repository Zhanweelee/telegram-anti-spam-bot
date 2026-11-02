# ADR 0216：写完的主机名和后面的域名之间的句号收成一个点

- 状态：已接受
- 日期：2026-11-03

## 背景

Android 把句号 `。` 算进标签，不把它当成 ASCII 点。`bit.ly。evil.com/…` 和 `www.bit.ly。evil.com/…` 各是一条主机名，地址解析器给出的主机名是 `bit.ly.evil.com` 和 `www.bit.ly.evil.com`。`203.0.113.10。evil.com/…` 同样是一条，不是那条裸 IP。连续两个句号也连成一条。

主机名扫描在句号处停住，于是又读出前面的 `bit.ly` 或 `203.0.113.10`。带 `http://` 的同一串已经由地址解析器连成一条，所以不会误删。

`example.com。bit.ly/…` 连起来仍以 `.bit.ly` 结尾，仍是短链。`203.0.113.10。bit.ly/…` 也是。`bit.ly。/…` 在斜杠前停住，Android 只打开 `bit.ly`。`bit。ly/…` 没有写成完整主机名，Android 不打开它。百分号编码的句号仍不收成点。

## 决策

- 只改主机名扫描。公开的 `foldCyrillicLookalikes`、`foldFullwidthLatin` 和关键词比较不改。
- 写完的裸主机名或点分 IPv4 后面，一段句号 `。` 在后面还有域名时收成一个 ASCII 点。
- 斜杠、路径、问号、字符串结尾，以及 `http://` 或 `https://` 紧跟在句号后面时，句号留着。
- 句号是主机名里唯一的点时留着。`bit。ly` 不收成 `bit.ly`。
- 停住扫描也做这一步，避免粘连扫描收成一个点之后又从原文读出短链。
- 每段仍走现有的短链、裸 IP、邀请和 denylist 判断。只拆一层。最多 8 个。证据只留主机名。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 任何句号都收成点 | `bit。ly` 会变成短链。Android 并不打开它。ADR 0099 已经拒绝。 |
| 把句号换成 `x` | `example.com。bit.ly` 会漏掉。ADR 0205 已经拒绝。 |
| 每个句号都收成一个点 | `bit.ly。。evil.com` 会变成 `bit.ly..evil.com`。空标签又让扫描停在 `bit.ly`。 |
| 只改检测器分词 | 文件名、投票和礼物文本仍走 `foldHostScan`，短链还会被拆出来。 |

## 后果

- `bit.ly。evil.com/…`、`www.bit.ly。evil.com/…`、`bit.ly。。evil.com/…` 和 `203.0.113.10。evil.com/…` 留着。
- `example.com。bit.ly/…` 仍按短链删除。证据是 `example.com.bit.ly`。
- `203.0.113.10。bit.ly/…` 按短链删除。证据是 `203.0.113.10.bit.ly`，不是那条裸 IP。
- `bit.ly。/…` 和 `http://bit.ly。/…` 仍按 `bit.ly` 删除。`bit。ly/…` 留着。
- 带协议的 `http://bit.ly。evil.com/…` 仍留着。路径不进证据。
