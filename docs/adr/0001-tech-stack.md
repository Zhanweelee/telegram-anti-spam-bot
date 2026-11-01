# ADR 0001：技术选型

- 状态：已接受
- 日期：2026-11-01

## 背景

Round 0 要选定语言、仓库形态、运行时和工具链。选型必须能部署到 Cloudflare Workers 免费套餐，并且让 core 在 Node 里单测。

## 决策

- TypeScript `strict`，固定在 5.9。再加 `noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`verbatimModuleSyntax`。
- pnpm workspace。包作用域 `@tasb/*`。
- 校验用 zod 4。core 允许依赖 zod，不允许依赖平台 SDK。
- 测试用 Vitest 5。core 覆盖率门槛 90%。
- Lint 和格式化只用 Biome 2，不并行引入 ESLint。
- Worker 入口用 Hono。Telegram 出站先用 `fetch`，不引入 grammY。
- 发版记录用 Changesets。包目前是 `private`。
- 规则的规范形式是 JSON。YAML 以后再加，并且要单独的依赖 ADR。
- 定时兼容性检查用 Dependabot，加上每周 GitHub Actions。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| TypeScript 7 | 最新主版本。Workers 类型和 Vitest 对 5.9 的组合已经跑通；升到 7 留给每周依赖更新，而不是堵在脚手架上。 |
| grammY | 命令路由变复杂之后再评估。Round 0 没有命令，多一个运行时依赖没有收益。 |
| ESLint + Prettier | 与 Biome 重复。一套工具就够。 |
| 现在就解析 YAML | 需要新的解析依赖。JSON + zod 已经能表达规则和 fixtures。 |

## 后果

- 插件作者用 zod schema 描述配置，而不是手写校验。
- Telegram 适配层自己负责 HTTP 和 secret token，错误类型不得漏进 core。
- 升级 TypeScript 主版本、或加入 grammY / YAML 解析器，都要新的 ADR。
