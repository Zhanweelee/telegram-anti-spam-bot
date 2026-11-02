# ADR 0206：IDNA 单字母收成对应拉丁字母

- 状态：已接受
- 日期：2026-11-02

## 背景

Android 把信息源符号 `ℹ`、圈号 `ⓘ`、罗马数字 `Ⅰ` 和同类字符留在主机名标签里。地址解析把它们收成一个 ASCII 字母。`bℹt.ly/…` 的主机名是 `bit.ly`。`http://bⓘt.ly/…` 和 `http://bⅠt.ly/…` 也是。

主机名扫描会删掉夹在中间的非 ASCII 拉丁字母，或把其它标签字收成 `x`。`bℹt.ly` 变成 `bxt.ly`，`bⅠt.ly` 变成 `bt.ly`，短链漏掉。

`ℹbit.ly/…` 前面没有 ASCII。删掉 `ℹ` 以后又读出 `bit.ly`。地址解析打开的是 `ibit.ly`。长 s `bſit.ly/…` 打开的是 `bsit.ly`。开尔文符号收成 `k`。

`example.comℹhttp://bit.ly/…` 会另外打开后面的网址。把这个字收成 `i` 会挡住协议。`example.comⓘhttp://t.co/…` 也是两条链接。

`example.comℹbit.ly/…` 和 `bit.lyℹevil.com/…` 各是一条主机名，不以 `.bit.ly` 结尾。全角字母已经收成半角。西里尔 `т` 不收成 `t`。

## 决策

- 只改主机名扫描，以及结构化 URL 取主机名之前的同一层折叠。公开的 `foldFullwidthLatin`、`foldCyrillicLookalikes` 和 `foldHostInterrupters` 仍不收这些字。关键词比较不走这一层。
- IDNA 映射恰好是一个 ASCII 字母、且不是全角字母的 165 个字符，收成这个小写字母。
- 后面紧跟 `http://` 或 `https://` 时不收。停住扫描也做这一步，并且同样放过后面的协议。
- 每段仍走现有的短链、裸 IP、邀请和 denylist 判断。只拆一层。最多 8 个。证据只留主机名。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 只在两个 ASCII 中间才收 | `ℹbit.ly` 仍会被删成短链。地址解析打开的是 `ibit.ly`。 |
| 连后面的协议一起收成字母 | `example.comℹhttp://bit.ly` 会漏掉。`i` 是单词字符，协议接不出来。 |
| 改公开的全角或西里尔折叠 | 关键词比较会把这些符号收成字母。`т` 仍不该收成 `t`。 |

## 后果

- `bℹt.ly/…`、`http://bⓘt.ly/…` 和 `http://bⅠt.ly/…` 按短链删除。
- `ℹbit.ly/…` 和 `bſit.ly/…` 留着。
- `example.comℹhttp://bit.ly/…` 和 `example.comⓘhttp://t.co/…` 仍按短链删除。
- `example.comℹbit.ly/…` 和 `bit.lyℹevil.com/…` 留着。
- `bтit.ly` 和 `点击bit.ly` 仍按短链删除。路径不进证据。
