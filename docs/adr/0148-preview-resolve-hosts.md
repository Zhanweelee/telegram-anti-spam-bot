# ADR 0148：预览 resolve 的 appname 只留主机名

- 状态：已接受
- 日期：2026-11-02

## 背景

ADR 0137 读了 `t.me/s/用户名` 的 `text`。桌面端先把它收成 `tg://resolve?domain=s&appname=用户名`。

`ResolveUsernameOrPhone` 在 `domain` 正好是小写 `s` 且 `appname` 非空时，把用户名换成 `appname`，并清掉应用名。这不是小程序。对方是用户时仍调用 `SetChatLinkDraft`。直接发出的 `tg://resolve?domain=s&appname=` 走同一条路径。

`domain` 的值必须正好是小写 `s`。`appname` 不是公开用户名时不改写。参数名不区分大小写。

## 决策

- `tg://resolve` 和 `tg:resolve` 在 `domain` 正好是 `s`、`appname` 是公开用户名时，从 `text` 抽出主机名。
- 这个主机名走现有的裸 IP、短链、邀请和 denylist 判断。只拆一层。`text` 不进入正文，也不参与关键词。
- 用户名和 `appname` 不进证据。
- `domain` 不是正好 `s`、没有 `appname`、`appname` 带点或是保留名时不读。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 只读 `t.me/s/用户名` | 同一条改写后的 resolve 可以直接出现在消息里。 |
| `domain` 不区分大小写 | 比较用的是原来的值，`S` 不会换成 `appname`。 |
| 带点的 `appname` 也读 | 公开用户名不含点，解析不会打开对话。 |

## 后果

- `tg://resolve?domain=s&appname=用户名` 的 `text` 是裸 IP、短链或邀请时，现有链接规则删除这条消息。证据仍只有主机名。
- 没有 `appname`、带点的名字和保留名留着。
- 再套一层仍放行。用户名不进证据。
- `s.t.me/用户名` 后来由 ADR 0149 按同一条预览读取 `text`。
- 大写 `S` 后来由 ADR 0262 按用户名读取 `text`。小写 `s` 没有 `appname` 时仍不读。`domain` 正好是小写 `s` 时仍只在 `appname` 是公开用户名时改写。
