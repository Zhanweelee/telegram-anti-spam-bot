# ADR 0301：空权威后面的井号另开草稿主机名

- 状态：已接受
- 日期：2026-11-03

## 背景

Android 在 `#` 处结束前一段。`http://#bit.ly/…` 没有主机名，后面的 `bit.ly` 单独打开。`HTTP://#bit.ly/…` 和 `https://#bit.ly/…` 一样。`http://#203.0.113.11/…` 打开裸 IP。`http://#t.me/+…` 打开邀请。

已经有主机名时，`#` 同样结束这一段。`http://example.com#bit.ly/…` 和 `http://bit.ly#evil.com/…` 仍先留下前面的主机名。

`http://?bit.ly/…`、`https://?bit.ly/…` 和 `http:///?bit.ly/…` 是一条没有主机名的链接。问号里的短链、裸 IP 和邀请不再打开。`http:///bit.ly/…` 仍打开 `bit.ly`。见 ADR 0211。

隐藏的分享 `text` 把 `http://#bit.ly/…` 收成一条空主机名的网址。井号后面的短链不再另开。

## 决策

- 分享 `text`、私聊预填 `tg://msg` 的 `text` 和用户名草稿的 `text`，在 `http://` 或 `https://` 后面紧挨 `#` 时，井号前加一个空格。
- 已经有主机名时，井号仍按主机名标点结束这一段。问号紧挨在 `://` 后面时不另开。
- 不改带协议网址的整段匹配。闭合分享链接里的网址不走这道切开。
- 证据只留主机名。路径和邀请码不进证据。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 所有井号都改成空格 | 问号和路径里的井号也会被拆开，和已经按主机名标点切开的规则重复。 |
| 问号里的裸域名也另开 | `http://?bit.ly` 会删掉 Android 留成一条无主机名链接的消息。 |
| 改掉带协议网址的整段匹配 | 其它已经收进同一条的字符会跟着拆开。 |

## 后果

- `t.me/share/url?text=http://?bit.ly/…`、`https://?bit.ly/…`、`http:///?bit.ly/…`、`http://?203.0.113.10/…`、`http://?http://bit.ly/…`、`http://?t.me/+…`、`http://example.com?bit.ly/…` 和 `http://example.com/?bit.ly/…` 留着。
- `http://#bit.ly/…`、`HTTP://#bit.ly/…` 和 `https://#bit.ly/…` 按短链删除。证据是 `bit.ly`。`http://example.com#bit.ly/…` 和 `http://bit.ly#evil.com/…` 仍按短链删除。路径不进证据。
- `http://#203.0.113.11/…` 按裸 IP 删除。`http://#t.me/+…` 按邀请删除。邀请码不进证据。
- `http:///bit.ly/…`、`http://bit.ly?…`、空格后面的 `http://t.co/…` 和裸 `bit.ly/…` 仍删除。
- 没有主机名的一到五位端口仍可能把后面的短链留在这一条里。见 ADR 0212。
