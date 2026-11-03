# ADR 0233：tg resolve 上的动态不读 text，网页查询仍读

- 状态：已接受
- 日期：2026-11-03

## 背景

`tg://resolve` 的 `story`、`album`、`collection` 是非零整数时，Android 和桌面端都打开动态、相册或礼物收集，不把 `text` 写进输入框。`0`、`live` 和带其它字符的值在 Android 上仍写草稿。查询名 `Story` 也对不上 Android 的参数名。

网页 `https://t.me/用户名?story=` 在 Android 里读动态编号的那一行是注释。这条仍把 `text` 写进输入框。桌面端会把它收成 `tg://resolve` 再打开动态。

路径 `t.me/用户名/s/数字`、`/a/数字` 和 `/c/数字` 本来就不是草稿。

## 决策

- 只在 `tg:` 的 resolve 上，查询名正好是 `story`、`album` 或 `collection`，且整个值是非零的 32 位整数时，不从 `text` 抽主机名。
- `https://t.me/用户名?story=`、`story=0`、`story=live` 和 `Story` 仍读。
- 这个主机名走现有的裸 IP、短链、邀请和 denylist 判断。只拆一层。`text` 不进入正文，也不参与关键词。
- 用户名和编号不进证据。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 网页上的 `story` 也不读 | Android 不读这个查询，仍把 `text` 写进输入框。 |
| `story=live` 也不读 | Android 把 `live` 解析成 0，仍写草稿。 |
| 带空格或后缀的数字也不读 | 桌面端整段解析失败时仍写草稿。 |

## 后果

- `tg://resolve?domain=用户名&story=5`、`album=3`、`collection=2` 和 `tg:resolve` 留着。电话号码上的非零 `story` 同样留着。
- `https://t.me/用户名?story=5`、`story=0`、`story=live` 和 `Story=5` 的 `text` 是裸 IP、默认短链或邀请时删除。证据仍只有主机名。
- 用户名和编号不进证据。
