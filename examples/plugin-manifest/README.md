# 插件清单

外部插件要有完整性摘要。签名是同一段 canonical JSON 的 HMAC-SHA256。

`src/run.ts` 的 `admitExample` 调用 `admitPlugin`。未签名的清单只有 `allowUnsigned: true` 时放行。签过名的清单在不允许未签名插件时仍然放行。

```sh
pnpm --filter @tasb/example-plugin-manifest test
```
