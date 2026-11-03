# ADR 0262：大写 S 仍读 text，小写预览仍不读

- 状态：已接受
- 日期：2026-11-03

## 背景

桌面端比较预览时用的是原来的 `domain`。只有正好小写 `s` 且 `appname` 非空时，才把用户名换成 `appname`。`domain=S` 不会换成预览，仍解析用户名 `S` 并写草稿。

`t.me/S` 的捕获也保留大写。它收成 `tg://resolve?domain=S`，不是预览。Android 只在第一段正好是小写 `s` 时拿掉这一段。大写 `S` 留在用户名里，`text` 进入输入框。

小写 `t.me/s` 和 `tg://resolve?domain=s` 没有 `appname` 时，Android 拿掉 `s` 之后没有用户名。这条仍按 ADR 0148 不读 `text`。

## 决策

- 保留名只挡住正好小写的 `s`。大写 `S` 按公开用户名处理。
- `t.me`、`telegram.me`、`telegram.dog` 以及一层 `www.` 上，`S`、末尾斜杠和后面的应用名，都从 `text` 抽主机名。
- `tg://resolve?domain=S` 仍读。`domain` 正好是小写 `s` 且没有公开用户名 `appname` 时不读。
- 再多一段路径不读。`t.me/S/用户名/再一段` 留着。
- `t.me/s/用户名` 和 `tg://resolve?domain=s&appname=` 仍按预览读取。
- 这个主机名走现有的裸 IP、短链、邀请和 denylist 判断。只拆一层。`text` 不进入正文，也不参与关键词。
- 用户名和应用名不进证据。
- `getpremium` 和 `telegrampassport` 仍不读 `text`。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 连小写 `s` 一起从保留名拿掉 | `tg://resolve?domain=s&text=` 没有 `appname` 时不写这条预览草稿。 |
| 大写 `S` 也当成预览 | 桌面端只在 `domain` 正好是小写 `s` 时改写。 |
| 三段路径也读 | 用户名后的第三段两边都不收成应用名。 |

## 后果

- `t.me/S`、`t.me/S/`、`t.me/S/slug.229`、`www.telegram.dog/S` 和 `tg://resolve?domain=S` 的 `text` 是裸 IP、默认短链或邀请时删除。证据仍只有主机名。
- `t.me/s?text=` 和 `tg://resolve?domain=s&text=` 仍不读。
- `t.me/S/短名/再一段` 和 `t.me/S/durov/shop` 留着。
- 主机名会先收成小写，所以 `S.t.me` 仍是预览标签 `s.t.me`。
