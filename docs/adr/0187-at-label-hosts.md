# ADR 0187：`@` 后面的标签字符仍留在这一段

- 状态：已接受
- 日期：2026-11-02

## 背景

Android 的用户信息只到 `@`。`@` 后面如果是标签字符，这个字符和紧跟着的字母组成主机名。`http://example.com@例http://bit.ly/…`、`http://example.com@．http://bit.ly/…`、零宽空格和 U+FEFF 都是一条链接，高亮停在 `http` 后面的 `:` 前面，不会再打开短链。`http://bit.ly@例.com/…` 打开的主机名是 `例.com`。

点、`!` 和 `~` 不是标签字符。`http://example.com@!http://bit.ly/…` 和 `http://bit.ly@.evil.com/…` 会在这里结束，再打开后面的主机名。没有协议的 `example.com@例http://bit.ly/…` 也会再打开短链。`http://user:pass@bit.ly/…` 仍是短链。

## 决策

- 带协议时，`@` 后面如果能开始 Android 的标签，用户信息就停在这里。这个标签可以包含 U+FEFF。
- 紧跟在 `@` 后面的点状字符保留，不收成 ASCII `.`。别的位置仍收成点。
- 高亮范围同样在这种标签前保留 `@` 前面的用户信息，不再把短链从用户信息里拆出来。
- 点、`!`、`~` 和没有协议的正文仍按原来的边界拆开。
- 每段仍走现有的短链、裸 IP、邀请和 denylist 判断。只拆一层。最多 8 个。证据只留主机名。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| `@` 后面一律另起主机名 | `http://bit.ly@例.com` 会把用户信息里的短链删掉。Android 打开的是后面的主机名。 |
| 标签字符也在没有协议的正文里粘住 `@` | `example.com@例http://bit.ly` 会漏掉 Android 打开的短链。 |
| 点状字符在 `@` 后面也收成点 | `http://example.com@．http://bit.ly` 会拆成两条链接。 |

## 后果

- `http://example.com@例http://bit.ly/…`、`http://example.com@．http://bit.ly/…`、零宽空格、U+FEFF、希腊字母和句号 `。` 留着。`http://bit.ly@例.com/…` 留着。
- `http://example.com@!http://bit.ly/…`、`http://example.com@~http://bit.ly/…` 和没有协议的 `example.com@例http://bit.ly/…` 按后面的短链删除。证据仍只有主机名。
- `http://bit.ly@.evil.com/…`、`http://user:pass@bit.ly/…` 和 `bit．ly` 仍按短链删除。
