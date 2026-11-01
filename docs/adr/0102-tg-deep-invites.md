# ADR 0102：tg:// 邀请记成 t.me

- 状态：已接受
- 日期：2026-11-02

## 背景

ADR 0030 只认 `https://t.me/+`、`/joinchat/` 和 `/addlist/`。垃圾消息改用 `tg://join?invite=` 或 `tg://addlist?slug=`。这两条和网页邀请是同一类入口。`tg://resolve?domain=` 对应公开用户名，不能一并删除。

邀请码不能进入证据或事件。

## 决策

- `tg://join?invite=` 和没有斜线的 `tg:join?invite=`，以及 `tg://addlist?slug=`，在比较时记成邀请主机名 `t.me`。
- 参数值必须是 1 到 128 位字母、数字、`_` 或 `-`。空值、斜线和其他命令不记。
- `tg://resolve` 以及其他 `tg:` 命令仍不记成邀请，也不记成主机名。
- 证据是 `invite:t.me`。邀请码不进证据。
- 自定义 `inviteHosts` 不含 `t.me` 时，这条深链不命中。
- 隐藏的 `text_link`、按钮 `url` 和旁边的纯文本走同一条判断，只把 `t.me` 放进 `invites`。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 把所有 `tg:` 链接都删掉 | `tg://resolve?domain=` 是公开用户名，和 `t.me/durov` 一样该留下。 |
| 证据写成 `invite:tg` | 邀请名单里没有这个名字。关掉 `t.me` 时这条深链仍会命中。 |
| 把邀请码放进事件再匹配 | 邀请码是密钥，和原文默认不落盘冲突。 |

## 后果

- 正文、隐藏链接、按钮地址和作者签名里的 `tg://join?invite=…` 走现有邀请删除。
- `tg://addlist?slug=…` 同样记成 `invite:t.me`。
- `tg://resolve?domain=durov` 仍放行。
- 邀请码不出现在证据里。重复计数仍按原文哈希。
- 代理和 socks 的 `server` 后来由 ADR 0129 按普通主机名处理。`secret`、端口、用户名和密码仍不进证据。
