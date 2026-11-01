# ADR 0018：插件清单与签名

- 状态：已接受
- 日期：2026-11-01

## 背景

P3-02 要求清单包含 id、版本、schema 和完整性摘要。未签名的包不能被公共 bot 加载。自部署可以显式打开未签名插件。core 不能知道自己跑在哪种部署模式，也不能为了摘要去依赖平台 SDK。

## 决策

- 清单是 strict object：`id`、`version`、`kind`、`schema`、`integrity`，可选 `signature`。`integrity` 和 `signature` 都是 64 位小写十六进制。带 `text` 等原文键的对象直接拒绝。
- canonical payload 是固定键序的 JSON：`id`、`kind`、`schema`、`version`。`integrity` 是这段 JSON 的 SHA-256。`signature` 是同一段 JSON 的 HMAC-SHA256。
- `admitPlugin` 只做比较。调用方传入已经算好的摘要，以及签名是否有效。core 不计算哈希。
- 摘要不一致时拒绝。签名存在但无效时拒绝，即使允许未签名也一样。签名缺失时，内置插件可以通过；外部插件只有 `allowUnsigned` 为 true 才可以通过。
- `allowUnsigned` 由 Worker 决定。`DEPLOYMENT_MODE=cloud` 时永远是 false。自部署只有环境变量 `ALLOW_UNSIGNED_PLUGINS` 精确等于 `true` 才是 true。这个变量不写进提交的 `wrangler.jsonc`。
- 内置清单放在 Worker 源码里，和检测器、动作的 id、版本一起核对。外部清单不能把自己标成内置。调用方传入的 `source` 才算数，流水线会把外部槽位改写成 `external`。
- 哈希和 HMAC 放在 `adapters-cloudflare`，用 Web Crypto。不新增依赖。示例密钥只出现在例子里，不作为生产密钥。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 在 core 里调用 `crypto.subtle` | core 要保持零平台 API。摘要由适配器算好再传进来。 |
| 用 Ed25519，把公钥放进仓库 | Web Crypto 的 Ed25519 在免费计划 Workers 上还要再查兼容日期。HMAC 已经够把密钥留在 Workers Secrets 里。以后要换公钥体系再写 ADR。 |
| 未签名时整次请求失败 | 一个坏清单不该挡住其余内置检测器。被拒绝的插件不进入流水线，并记 `plugin_rejected`。 |

## 后果

- 公共导出增加 `admitPlugin`、`canonicalPluginPayload` 和清单类型。适配器导出 `sha256HexUtf8`、`hmacSha256Hex`、`signaturesMatch`。
- 持有 HMAC 密钥的人可以自己签名。密钥必须放在 Workers Secrets，不能进仓库。
- 新的内置检测器要补一条清单，否则 Worker 不会加载它。
