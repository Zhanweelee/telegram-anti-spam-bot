# TASB

Telegram 反垃圾 bot。同一套核心，两种部署：自己放到 Cloudflare Workers，或接入维护者的公共 bot。

检测流水线是：

`Event → 预过滤 → Detector → 聚合 → Decision → Action`

核心不认识 Telegram，也不认识 Cloudflare。自部署和云服务的差别只留在适配层。

## 30 秒

| 你想做的事 | 去哪里 |
| --- | --- |
| 看架构边界 | [docs/architecture.md](docs/architecture.md) |
| 看现在该做什么 | [ROADMAP.md](ROADMAP.md) |
| 给 Agent / 贡献者的规矩 | [AGENTS.md](AGENTS.md) |
| 免费额度对设计的约束 | [docs/limits.md](docs/limits.md) |
| 跑一条最小检测 | [examples/minimal-pipeline](examples/minimal-pipeline) |

当前是 Round 0：流水线、关键词检测器和删除动作已经能在内存里跑通。Telegram webhook 和生产部署在 P0，还没有接上。

## 10 分钟跑通

需要 Node.js 22 和 pnpm 10。

```sh
pnpm install
pnpm check
```

`pnpm check` 会做依赖边界检查、类型检查、lint、全部测试、core 覆盖率（门槛 90%）和关键词评测。

只看最小例子：

```sh
pnpm --filter @tasb/example-minimal-pipeline test
pnpm eval
```

本地看 Worker 健康检查（还不会连 Telegram）：

```sh
pnpm --filter @tasb/worker dev
```

然后请求 `/health`。`deploymentMode` 来自 Wrangler 变量，默认 `self-host`。

## 仓库地图

```text
packages/core                 领域逻辑。零 I/O，零平台 SDK
packages/detectors-keyword    内置关键词检测器
packages/actions              内置动作（目前是 delete）
packages/adapters-memory      测试用存储和处罚端口
packages/adapters-cloudflare  Cloudflare 绑定适配层（骨架）
packages/platform-telegram    Telegram 适配层（骨架）
packages/sdk                  插件作者的测试帮手
apps/worker                   Workers 入口。self-host / cloud 共用
apps/cloud                    云服务租户模块。计费尚未实现
examples/minimal-pipeline     内存端到端例子
evals                         评测集与回归
docs                          架构、ADR、额度
```

## 许可

许可证尚未选定。在维护者确认之前，不要把本仓库当作已经采用 MIT 或其他许可证。
