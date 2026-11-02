# ADR 0140：Telegram 查询名不区分大小写

- 状态：已接受
- 日期：2026-11-02

## 背景

ADR 0135 和 ADR 0137 用 `URL.searchParams.get` 读取 `server`、`host`、`domain`、`phone`、`invite` 和 `slug`。这个接口区分大小写。

桌面端 `url_parse_params` 先把查询名收成小写，同名只留第一次出现的值。`SERVER=bit.ly` 和 `server=bit.ly` 是同一个代理地址。`DOMAIN=` 和 `INVITE=` 也一样。Android 的 `getQueryParameter` 区分大小写，桌面端是这条链接的读取依据。

`text` 和 `url` 已经按不区分大小写的方式解开。参数名写成大写时，草稿、代理和邀请走不到那一层，里面的短链、裸 IP 和邀请码就留在查询里。

## 决策

- 读取 `domain`、`phone`、`server`、`host`、`invite`、`slug` 时，查询名不区分大小写，取第一次出现的值。
- 值仍用 URL 解析后的结果。`+` 仍是空格。不改用解开 `text` 的那套解码。
- 空字符串仍算空。网页代理上长度为 0 的 `SERVER` 继续改读 `host`。SOCKS、MTProto 和只含空白的 `server` 不改读。
- 已有非空 `server` 时不读后面的 `host`。Passport 的 `domain` 仍不读 `text`。
- 不新增检测器。不改 ADR 0026 的基础检测器名单。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 只认小写参数名 | 桌面端把 `SERVER` 和 `server` 读成同一个地址。 |
| 所有同名值都读 | 桌面端同名只留第一次出现的值。 |
| 改用解开 `text` 的解码 | 那套解码会把 `+` 留成加号，和现有 URL 解析不一致。 |

## 后果

- `SERVER`、`HOST`、`DOMAIN`、`PHONE`、`INVITE` 和 `SLUG` 里的裸 IP、默认短链或邀请，现有链接规则删除这条消息。证据仍只有主机名。
- 先出现的 `SERVER=bit.ly` 盖过后面的 `server=example.com`。
- `example.com` 留着。只含空白的 `SERVER` 仍不改读 `HOST`。Passport 仍放行。
- 正文就是这条链接时，链接原文仍在 `message.text`。按钮和隐藏链接只留下主机名。
