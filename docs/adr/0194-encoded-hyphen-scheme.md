# ADR 0194：编码连字符紧挨网址时不再收成连字符

- 状态：已接受
- 日期：2026-11-02

## 背景

Android 不会在匹配前把 `%2D` 或 `%252D` 收成连字符。`example.com%2Dhttp://bit.ly/…`、`www.example.com%2Dhttp://bit.ly/…`、`%2Dhttp://bit.ly/…` 和 `example.com%252Dhttp://bit.ly/…` 都不会打开后面的短链。`example.com%2Dhttps://t.me/+…` 也不会打开邀请。`http://example.com%2Dhttp://bit.ly/…` 只打开前面的主机名。`example.com/%2Dhttp://bit.ly/…` 整段仍是前面的主机名。第三层 `%25252D` 仍不打开后面的短链。

真正的连字符仍然会拆开：`example.com-http://bit.ly/…` 会打开后面的短链。换行、空格、制表符或斜杠隔在 `%2D` 和网址之间时，后面的短链也会打开。`%252D` 换行后再写网址同样会打开。`bit%2Dly` 收成 `bit-ly`，仍不是短链。`https://bit.ly%2Dhttp://t.co/…` 仍停在 `bit.ly`。

粘连扫描如果先去掉换行，再把 `%2D` 或 `%252D` 收成连字符，`example.com%2Dhttp://bit.ly` 会变成 `example.com-http://bit.ly`，短链被多出来的边界打开。

## 决策

- 去掉换行之前，把紧挨在 `http://` 或 `https://` 前面的 `%2D` 和 `%252D` 换成 `!x`。`!` 让前面的主机名结束，`x` 让 `http` 不能另起一段。
- 换行、空格、制表符或斜杠隔开的 `%2D` 和 `%252D` 仍收成连字符。其它位置的 `%2D` 和 `%252D` 仍收成连字符。第三层仍保留。
- 每段仍走现有的短链、裸 IP、邀请和 denylist 判断。只拆一层。最多 8 个。证据只留主机名。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| `%2D` 一律不再收成连字符 | `bit%2Dly` 的比较会和现在不同，邀请码里的连字符也会漏掉。 |
| 去掉换行之后再判断 | `example.com%2D` 换行再写网址，会和粘在一起的 `%2Dhttp` 变成同一串，换行那条短链会漏掉。 |
| 直接删掉这段 `%2D` | `%2Dhttp://bit.ly` 会变成一条短链。Android 并不打开它。 |

## 后果

- `example.com%2Dhttp://bit.ly/…`、`www.example.com%2Dhttp://bit.ly/…`、`%2Dhttp://bit.ly/…`、`example.com%252Dhttp://bit.ly/…` 和 `http://example.com%2Dhttp://bit.ly/…` 留着。`example.com%2Dhttps://t.me/+…` 不记成邀请。`example.com/%2Dhttp://bit.ly/…` 留着。
- `example.com-http://bit.ly/…`、换行或斜杠隔开的 `%2D`，以及换行隔开的 `%252D`，仍按短链删除。路径不进证据。
- `bit%2Dly` 仍留下。`https://bit.ly%2Dhttp://t.co/…` 仍按短链删除。证据是 `bit.ly`。
- `203.0.113.161%2Dhttp://bit.ly/…` 和 `203.0.113.161%252Dhttp://bit.ly/…` 仍按裸 IP 删除。证据是这个地址，不是后面的短链。
