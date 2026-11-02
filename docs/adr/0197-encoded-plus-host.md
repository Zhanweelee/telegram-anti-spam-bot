# ADR 0197：编码加号不再拼出裸主机名

- 状态：已接受
- 日期：2026-11-02

## 背景

Android 不会在匹配前把 `%2B` 收成加号。`%2Bbit.ly/…` 打开的是 `2bbit.ly`，不是 `bit.ly`。`example.com%2Bbit.ly/…`、`see %2Bbit.ly/…` 和 `http://example.com%2Bbit.ly/…` 同样不会打开 `bit.ly`。`example.com%2Bt.co/…` 打开的是 `2bt.co`。`%2Bt.me/+…` 打开的是 `2bt.me`。`example.com%2B203.0.113.164/…` 只打开前面的主机名。

`%2Bexample.com/bit.ly/…` 和 `%2Bexample.com/http://bit.ly/…` 各是一整段，主机名是 `2bexample.com`。路径里的短链不会再拆出来。

真正的加号仍然会拆开。`example.com+bit.ly/…` 会打开后面的短链。换行、空格、制表符或斜杠隔在 `%2B` 和主机名之间时，后面的短链也会打开。`t.me/%2B…` 和 `t.me%2F%2B…` 仍是邀请。

`%2Bwww.bit.ly/…` 打开的是 `2bwww.bit.ly`。这个主机名仍以 `.bit.ly` 结尾，Android 会打开它。

粘连扫描如果先把 `%2B` 收成加号，`%2Bbit.ly` 会变成 `+bit.ly`。短链被多出来的边界打开。路径如果被拆成新的一段，`%2Bexample.com/bit.ly` 也会多出一个短链。

## 决策

- 去掉换行之前，把紧挨在裸主机名或点分 IPv4 前面、而且不在路径里的 `%2B` 换掉。路径是前面已经有 `/` 或 `%2F`。
- 裸主机名保留标签和路径，最后一段换成 `arpa`，前面加 `!`。`!` 让前面的主机名结束。`arpa` 让短链后缀对不上，路径仍挂在这一段上。
- 点分 IPv4 换成 `!0.arpa`。路径仍挂在这一段上。
- 紧挨在 `http://` 或 `https://` 前面的 `%2B` 仍换成 `!x`。见 ADR 0193。
- 换行、空格、制表符或斜杠隔开的 `%2B` 仍收成加号。路径里的 `%2B` 仍收成加号。`%252B` 仍保留。
- 每段仍走现有的短链、裸 IP、邀请和 denylist 判断。只拆一层。最多 8 个。证据只留主机名。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| `%2B` 一律不再收成加号 | `t.me/%2B…` 会漏掉。 |
| 只换成 `!x`，主机名原样留下 | `www.bit.ly` 会变成 `xwww.bit.ly`，仍以 `.bit.ly` 结尾。 |
| 删掉 `%2B` 和后面的主机名 | `%2Bexample.com/bit.ly` 会剩下 `/bit.ly`，多出一个短链。 |

## 后果

- `%2Bbit.ly/…`、`example.com%2Bbit.ly/…`、`example.com%2Bt.co/…` 和 `%2Bt.me/+…` 留着。`example.com%2Bt.me/+…` 不记成邀请。
- `%2Bexample.com/bit.ly/…` 和 `%2Bexample.com/http://bit.ly/…` 留着。
- `example.com%2B203.0.113.164/…` 留着。`203.0.113.164%2Bbit.ly/…` 仍按裸 IP 删除。证据是这个地址，不是后面的短链。
- `example.com+bit.ly/…`、换行、空格、制表符或斜杠隔开的 `%2B`，以及 `t.me/%2B…`，仍按现有规则删除。路径和邀请码不进证据。
- `%2Bwww.bit.ly/…` 仍按短链删除。证据是 `2bwww.bit.ly`。
- 百分号编码的斜杠紧挨着裸主机名时不再收成斜杠。见 ADR 0198。
