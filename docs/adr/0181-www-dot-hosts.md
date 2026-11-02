# ADR 0181：没有协议的 www. 在点号处结束

- 状态：已接受
- 日期：2026-11-02

## 背景

Android 没有协议时，`www.` 走严格域名。点号不属于这一段主机名。`www.example.com./http://bit.ly/…`、`www.example.com.?http://bit.ly/…` 和 `www.example.com.:80/http://bit.ly/…` 都会先停在 `www.example.com`，再打开后面的短链。

带协议的放松主机名会把点号留在当前网址里。`http://www.example.com./http://bit.ly/…` 仍是一条链接。问号或斜杠直接接在 `www.` 后面时也仍是一条链接。

## 决策

- 没有协议的 `www.` 使用和裸域名一样的尾巴：一到五位端口，以及以 `/` 或 `?` 开头的路径。点号不留在这一段。
- 带协议的网址仍在点号后面是端口、`/` 或 `?` 时把这个点留在当前这一段。
- 每段仍走现有的短链、裸 IP、邀请和 denylist 判断。只拆一层。最多 8 个。证据只留主机名。同一条原因只记第一次命中的主机名。
- 点号挡住的邀请路径不改记成邀请。没有这个点时，`www.t.me/+…` 仍按邀请读取。带协议的 `https://t.me./+…` 仍按邀请读取。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 带协议的点号也切开 | `http://www.example.com./http://bit.ly` 仍是一个网址。 |
| 问号也从 `www.` 上拿掉 | `www.example.com?http://bit.ly` 仍是一个网址。 |

## 后果

- `www.example.com./http://bit.ly/…`、`www.example.com.?http://bit.ly/…` 和 `www.example.com.:80/http://bit.ly/…` 按后面的短链删除。证据仍只有主机名。
- `www.example.com?http://bit.ly/…` 和 `http://www.example.com./http://bit.ly/…` 留着。
- `www.bit.ly./…` 仍按短链删除。路径不进证据。
- `www.t.me./+…` 不记成邀请。`www.t.me/+…` 和 `https://t.me./+…` 仍按邀请删除。
