# AGENTS.md

这份文件是人和 Agent 改这个仓库时的章程。做任何任务之前先读它、`ROADMAP.md`、最近的 ADR 和 `CHANGELOG.md`。

## 使命

把 TASB 做成 Telegram 生态里可自我迭代的开源反垃圾 bot：

1. **Self-host**：fork 后部署到 Cloudflare Workers，尽量只用免费套餐，大约 10 分钟跑通，不养服务器。
2. **Cloud**：公共 bot。群里授予管理员即可接入。每个群有免费额度。群主在私聊里管理规则、白名单、日志和额度。
3. **一份核心**。自部署和云服务的差别只在部署适配层和租户/计费模块。core 不知道自己跑在哪种模式。

工程品味对标 yetone/magpie：边界清楚、接口小、文档和例子跟得上代码。

## 非目标

- 不做通用聊天机器人，不做群娱乐。
- 第一版不做 Web 管理后台。管理走私聊和配置文件。包结构要能以后加后台，但现在不加。
- 不引入必须常驻的服务器、数据库或队列消费者。

## 架构原则

六边形 / Ports & Adapters。

| 层 | 职责 |
| --- | --- |
| `packages/core` | 检测、规则、决策。纯函数。零 I/O。零平台 SDK |
| ports | Storage、Moderation、Clock、Logger，以及以后的 Queue、Cache、LLM、Notifier |
| adapters | `adapters-memory`、`adapters-cloudflare`。以后可以有 postgres，但要 ADR |
| platforms | `platform-telegram` 把平台更新归一化成内部 `Event` |

依赖只能向 core 收拢：

```text
apps → platform / adapters / detectors / actions → core → zod
apps/cloud 不被 core 依赖
```

`pnpm boundaries` 会失败于违规 import。细节见 [docs/architecture.md](docs/architecture.md)。

其他必须遵守的原则：

- 一切可替换的能力都是插件：Detector、Action、RuleSource、Notifier、Storage。统一 id、semver、capabilities、zod schema。
- 流水线每步可观察、可 dry-run。检测器失败默认 fail-open。
- 规则是带 schema 的 JSON，必须能用 fixture 测。
- 数据从第一天带 `tenantId` 和 `chatId`。Self-host 是单租户且不计费。
- 热路径先考虑 [docs/limits.md](docs/limits.md) 里的免费额度。LLM 是最后一级，并且可跳过。
- Webhook 校验 secret。消息原文默认不落盘。密钥走 Workers Secrets。

违反原则可以，但要先写 ADR，说明背景、决策、备选和后果。

## 目录

```text
packages/core                 领域类型与流水线
packages/detectors-keyword    关键词检测器
packages/detectors-join       入群检测器
packages/detectors-rate       洪泛与重复
packages/detectors-link       链接与域名信誉
packages/detectors-blocklist  跨群黑名单。默认关闭
packages/actions              内置动作
packages/adapters-memory      内存 Storage / Moderation
packages/adapters-cloudflare  D1 审计与 KV 白名单
packages/platform-telegram    Telegram webhook 校验与 Update → Event
packages/sdk                  Node 侧测试帮手（sha256、构造事件）
apps/worker                   Hono 入口
apps/cloud                    云租户模块。禁止在这里擅自写计费
examples/minimal-pipeline     端到端例子
evals                         评测集。检测器变更必须跑
docs/adr                      ADR
docs/limits.md                免费额度
.cursor/rules                 按 glob 触发的规则
```

## 常用命令

```sh
pnpm install
pnpm check          # boundaries + typecheck + lint + test + core coverage
pnpm test
pnpm test:coverage  # 只跑 core，门槛 90%
pnpm eval           # 关键词 precision / recall，低于基线则失败
pnpm --filter @tasb/worker dev
pnpm smoke          # 需要 WEBHOOK_SECRET，检查 /health 和一次 webhook 200
pnpm --filter @tasb/example-minimal-pipeline test
```

本地需要 Node 22。测试不需要 Cloudflare 账号。部署步骤在 `docs/deploy.md`。免费套餐即可。D1 和 KV 可以后配；没配时审计和白名单留在内存里。

## 代码规范

- 命名：函数和变量 camelCase，类型 PascalCase，包目录 kebab-case，插件 id 是 `^[a-z][a-z0-9_-]{0,63}$`。
- 数据默认不可变。输入用 `readonly`。不要就地修改事件或规则。
- 纯函数优先。I/O 留在适配层。core 里需要的时间通过 `Clock` 注入。
- 错误：配置和 schema 错误抛出。检测器、动作、存储在流水线里捕获，记固定的 code，不记异常 message。
- 日志：`message` 加原始类型字段。禁止原文、token、webhook secret。
- 公共类型从包的 `src/index.ts` 导出。外部不要深路径 import。

## Definition of Done

每个任务都要：

- 类型检查、lint、测试通过。core 覆盖率 ≥ 90%。新检测器带 fixtures，并跑 evals。precision 或 recall 下降则不要合入。
- 改了公共接口：更新 docs、例子、以及一个 Changeset。
- 改了架构或新增依赖：ADR。依赖要看体积、维护状态、能否在 Workers 里跑。
- README 仍然是「30 秒看懂、10 分钟跑通」。

## Iteration Loop

每一轮只做一个垂直切片：

1. 读 `AGENTS.md`、`ROADMAP.md`、最近 ADR、`CHANGELOG.md`。
2. 选 ROADMAP 里最高优先级的未完成项。
3. 先写计划：影响面、接口、测试、风险。然后动手。
4. 测试与实现同步：单测，能接运行时时再加集成测试，检测器变更跑 evals。
5. 对照架构原则和 DoD 自检。
6. 更新文档、例子、ADR、ROADMAP、CHANGELOG / Changeset。
7. 在 ROADMAP 的 Retro 追加一条：做了什么、学到什么、下一步。
8. 提交信息用 Conventional Commits。

## 禁止

- 在 core 里 import 平台 SDK、grammY、Hono、Wrangler、其他 `@tasb/*` 包。
- 提交密钥、`.env`、真实 bot token。
- 把消息原文写入存储、日志、评测基线或错误字符串。
- 跳过测试或降低覆盖率门槛来让 CI 变绿。
- 没有 ADR 就改公共接口、加依赖、或让 core 感知部署模式。
- 在 `apps/cloud` 里实现扣费、定价或支付。

## 必须停下来问人

遇到下面任何一项，停止实现，把问题和可选方案写出来：

- 计费、付费、Telegram Stars、免费额度的具体数字
- 改变数据保留策略（初始 30 天写在 ADR 0003，改它也要问）
- 破坏性迁移或删数据
- 新增要付费的第三方服务
- 许可证、隐私政策文本、其他法律合规选择

## 新增一个 Detector

1. 建 `packages/detectors-<name>`，只依赖 `@tasb/core` 和 `zod`。
2. 用 `defineDetector` 声明 id、`x.y.z` 版本、capabilities、zod config。
3. `detect` 返回 `DetectorHit | null`。score 在 0 到 1。证据摘要不要复制消息原文。
4. 在 `fixtures/` 放 JSON，并用测试跑完。
5. 在 `evals/cases` 加标注样本，更新 `evals/baselines`。recall 或 precision 下降就停。
6. 在 `scripts/check-boundaries.mjs` 登记允许的 import。
7. 更新 `docs`、例子（如果用户会直接用到）、Changeset、ROADMAP。
8. 放进 Worker 时，在 `builtinManifests` 写上同 id、同版本的清单。完整性是 canonical payload 的 sha256。外部清单还要签名。见 ADR 0018。

## 新增一个 Action

1. 放在 `packages/actions`，或在动作足够大时拆包。
2. 用 `defineAction`。只通过 `ModerationPort` 或其他 core 端口触达外部。
3. 支持 dry-run：返回 `skipped`，不要调用端口。缺字段时返回 `failed` 和固定 detail，不要抛给流水线。
4. 用 fixture 覆盖执行、跳过、失败。
5. 若新动作改变 `DecisionAction` 或端口方法，先写 ADR。

## 新增一个 Platform

1. 建 `packages/platform-<name>`，只依赖 `@tasb/core`。哈希用 Web Crypto，不要 import `node:crypto`。
2. 把平台更新归一化成 `Event`。core 的测试和源码都不出现平台类型。
3. 校验 webhook secret。失败、密钥未配置、或正文不是合法更新时，不要调用流水线。
4. HTTP 响应和日志里不要出现消息原文、token、secret。解析异常的 `message` 会回显正文，不要把它写进日志。
5. 用 fixture 覆盖一条正常更新、一条缺文本的更新、一条特权用户更新。
6. 在 `scripts/check-boundaries.mjs` 登记允许的 import。

## 新增一个 Adapter

1. 建 `packages/adapters-<runtime>`，实现 core 的端口，不要把平台类型导出给 core。
2. 提供与 `adapters-memory` 同行为的测试：租户隔离、审计 schema 拒绝原文。实现 `PolicyStore` 时从 `@tasb/core/testing` 调用 `bindPolicyStoreContract`。实现 `Storage` 时调用 `bindStorageContract`。实现 `BlocklistStore` 时调用 `bindBlocklistStoreContract`。实现 `ReviewQueue` 时调用 `bindReviewQueueContract`。
3. 对照 `docs/limits.md` 写明读放大、写放大和失败时的行为。
4. Workers 绑定只出现在该包和 `apps/worker`。
5. 新的 npm 依赖需要 ADR。

## 术语

| 术语 | 含义 | 不要换成 |
| --- | --- | --- |
| Event | 平台无关的内部事件 | Update、Message |
| Detector | 打分插件 | Filter、Checker、Plugin（太宽） |
| Hit | 一次非空检测结果 | Match、Alert |
| Action | 执行处罚或记录的插件 | Handler、Command |
| Decision | 聚合后的最终动作 | Verdict、Result |
| Rule | 一条带阈值和动作的声明式规则 | Policy（Policy 专指预过滤） |
| RuleSet | 版本化的规则集合 | Config |
| Prefilter | 白名单和管理员豁免 | Allow rule |
| Tenant | 计费和数据隔离单位 | Account、User |
| Chat | 一个群或私聊 | Group、Room |
| Audit | 不含原文的决策记录 | Log（Log 是运行日志） |
| Evidence | 短摘要，不是原文片段 | Snippet、Quote |
| Dry-run | 算出决策但不执行动作、不写审计 | Shadow |
| Fail-open | 检测器失败时放过消息 | Fail-safe（含糊） |
| Deployment mode | 只存在于 worker 的 `self-host` 或 `cloud` | Environment |
| Direct | 与 bot 的私聊，事件字段 `direct` | Private（平台词）、DM |
| Blocklist | 租户内共享的 actor id 或内容哈希。每个群单独 opt-in，默认关闭 | Ban list、原文黑名单 |
| Locale | 命令回复的语言，`zh` 或 `en`。缺省中文 | Language、i18n code |
| Review sample | 一条待审核的误判或确认。只有哈希和特征，不含原文 | Feedback、原文样本 |
| Feedback case | 从审核样本导出的评测条目。确认是 spam，误判是 ham。只有哈希和特征 | 原文样本 |
| LlmClassifier | 最后一级分类端口。返回标签和分数。core 不发请求 | Model、Prompt |
| Metric report | 从日志汇总的拦截率、动作、检测器错误和存储失败。标签只有 id | Dashboard、昵称维度 |
| Plugin manifest | 插件的 id、版本、schema 和完整性摘要。外部包还要签名 | Package.json、原文配置 |
| Rule pack | 一份可订阅的 RuleSet。默认关闭。刷新失败时保留上一份通过 schema 的规则 | 远程配置、原文规则 |
| Notifier | 上报端口。通知只有标识、分数和 reason | 原文推送、证据摘录 |
| Edited | 消息发出后又被修改。事件字段 `edited` | Update 类型名、原文副本 |
