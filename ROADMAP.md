# ROADMAP

这里是唯一的任务来源。一轮只做最上面未完成的一项。完成时把状态改成 `done`，并在文末 Retro 记一笔。

状态：`done` | `todo`。

验收标准写在每一项下面。通用门槛见 `AGENTS.md` 的 Definition of Done。

## Round 0

### R0-01 AGENTS.md 与 .cursor/rules — done

- `AGENTS.md` 含使命、非目标、依赖方向、命令、规范、DoD、迭代循环、禁止事项、必须问人的情形、新增插件步骤、术语表。
- `.cursor/rules` 有 00–60 七个 `.mdc`，glob 能对上目录。

### R0-02 Monorepo、工具链、CI — done

- pnpm workspace、TypeScript strict、Biome、Vitest、Wrangler、Changesets、GitHub Actions。
- `pnpm check` 在本地通过。
- Dependabot 与每周健康检查 workflow 已提交。

### R0-03 核心接口与最小端到端 — done

- core 导出 Event、Detector、Action、Decision、Storage、Rule 与 `runPipeline`。
- 关键词检测器 + 删除动作 + 内存适配器，由 `examples/minimal-pipeline` 覆盖。
- core 覆盖率 ≥ 90%，关键词 eval 不低于基线。

### R0-04 本路线图 — done

- P0–P3 拆成可独立交付的任务，每项有验收标准。

### R0-05 架构与 ADR — done

- `docs/architecture.md`。
- ADR 0001 技术选型、0002 多租户、0003 隐私。

### R0-06 免费额度 — done

- `docs/limits.md` 记录查证日期、来源链接、以及对热路径的约束。

## P0

### P0-01 Telegram webhook 接入 — done

验收：

- `POST /telegram/webhook` 校验 `secret_token`，失败返回 401，且不调用流水线。
- 合法更新在 Worker 内归一化成 `Event`。core 的测试仍不 import Telegram 类型。
- 用 fixture 更新覆盖普通消息、没有文本的消息、管理员消息。

### P0-02 入群事件 — todo

验收：

- `chat_member` 变成 `kind: "chat_member"` 的 Event。
- 没有文本时关键词检测器返回 null，流水线不抛错。

### P0-03 按群加载规则 — todo

验收：

- Worker 从配置文件读取默认 RuleSet，并允许某个 `chatId` 覆盖。
- 热路径先读缓存端口，不在每条消息上打 D1。
- 规则 schema 失败时该群 fail-open，并打一条不含原文的日志。

### P0-04 mute 与 ban — todo

验收：

- `ModerationPort` 增加 mute 与 ban 之前有 ADR。
- 两个动作都支持 dry-run 和缺失目标时的 `failed`。
- 严重度顺序保持 ban > mute > delete。

### P0-05 白名单与管理员豁免的存储 — todo

验收：

- 预过滤数据按 tenant + chat 存在适配器里。
- 管理员豁免可配置关闭。
- 内存适配器与将要写的 Cloudflare 适配器共用 core 里的同一组行为测试。

### P0-06 私聊管理命令 — todo

验收：

- 仅配置中的管理员可在私聊使用 `/help`、`/rules`、`/whitelist`、`/logs`、`/dryrun`。
- 群聊里的命令不改变配置。
- `/logs` 展示审计摘要，不回显原文。

### P0-07 一键部署 — todo

验收：

- README 的 10 分钟路径包含：创建 D1/KV（若 P0-08 已合并）、设置 secret、`wrangler deploy`、设置 webhook。
- 全新账号按文档操作能收到 `/health` 与一次 webhook 200。
- 不要求付费计划。

### P0-08 Cloudflare 存储适配器 — todo

验收：

- D1 迁移可重复执行。
- 写入遵守 `docs/limits.md`：allow 与 dry-run 不写审计，失败 fail-open。
- 对照内存适配器的行为测试全部通过。

### P0-09 导出与删除 — todo

验收：

- 给定 tenant（以及可选 chat）可以导出审计 JSON，其中没有原文。
- 删除该范围内的审计后，再次读取为空。
- 保留期仍是 ADR 0003 的 30 天；若要实现自动清理，先确认维护者接受这个初始值。

## P1

### P1-01 按钮或问答 captcha — todo

验收：新成员在通过验证前受限；超时与通过都有不含原文的审计；失败检测器不困住入群。

### P1-02 洪泛与重复 — todo

验收：检测器有 fixtures 和 eval；超额时可降级为跳过，而不是拖垮请求；说明它用 KV、DO 还是内存窗口，并引用额度文档。

### P1-03 链接与域名信誉 — todo

验收：默认不在热路径上做远程查询。远程失败 fail-open。fixtures 覆盖短链接、无链接、信誉源超时。

### P1-04 跨群黑名单 opt-in — todo

验收：默认关闭。打开后只共享哈希或标识，不共享原文。关闭后立即停止读取共享名单。

### P1-05 消息目录 i18n — todo

验收：命令回复走字典。至少中文和英文。缺键时回退到 key，而不是抛错。

### P1-06 误判申诉 — todo

验收：管理员可以把一条审计标成误判或确认。记录不含原文。样本进入待审核队列，不自动改规则。

## P2

### P2-01 可插拔 LLM 分类 — todo

验收：默认关闭。Workers AI 额度错误或超时时跳过。模型名和免费计划可用性写进 ADR。不把付费模型设为默认。

### P2-02 反馈进入评测集 — todo

验收：确认/误判记录能导出成 eval 样本。在维护者明确同意保存原文之前，样本只有哈希、特征和标签。

### P2-03 云额度 — todo

必须先问维护者：免费次数、周期、超额后保留哪些检测器。未回答前保持 `apps/cloud` 只有租户目录占位。

### P2-04 运营指标 — todo

验收：拦截率、动作计数、检测器错误、存储失败可从日志聚合。指标标签不含消息文本和用户昵称。

## P3

### P3-01 Web 控制台 — todo

验收：只读审计和规则编辑复用私聊已经有的权限模型。不成为第二套规则引擎。

### P3-02 插件清单与签名 — todo

验收：manifest 含 id、版本、schema、完整性摘要。未签名包不能被公共 bot 加载。自部署可以显式打开未签名插件。

### P3-03 社区规则包订阅 — todo

验收：订阅是 opt-in。更新规则失败时保留上一份通过 schema 的 RuleSet。

## 自升级

### S0-01 Dependabot、每周 CI、社区模板 — done

验收：见 `.github/`。每周 issue 提醒人工核对 `docs/limits.md`，workflow 自己不改额度数字。

### S0-02 真实垃圾语料 — todo

验收：`evals/cases` 不再只有关键词玩具集。基线记录 precision、recall 和样本数。语料的收集方式符合 ADR 0003。

## Retro

### 2026-11-01 Round 0

- 做了什么：搭好 monorepo、core 流水线、关键词检测器、删除动作、内存端到端、额度文档和三份 ADR。Telegram 与 D1 故意没接。
- 学到什么：免费计划 HTTP CPU 只有 10 ms，KV 每天 1,000 次写，队列大约 3,000 条完整投递。热路径必须是本地规则；队列和 LLM 不能进默认路径。D1 从 2026-09-01 起超额会直接失败，所以存储错误必须 fail-open。
- 下一步：做 P0-01，把 webhook 校验和 Update → Event 放进 `platform-telegram`，core 保持不认识 Telegram。

### 2026-11-01 P0-01

- 做了什么：`POST /telegram/webhook` 校验 secret，把 `message` 更新归一化成 Event。fixture 覆盖普通消息、没有文本的消息、管理员消息。Worker 把事件送进内存流水线，不调用 Telegram 删除接口。
- 学到什么：免费计划的外部子请求很少，热路径不该为了判断管理员去打 `getChatMember`。`JSON.parse` 的异常文本会带回正文，不能写进日志。鉴权要放在读大 body 之前。
- 下一步：做 P0-02，把 `chat_member` 收成 `kind: "chat_member"`，并确认没有文本时关键词检测器返回 null、流水线不抛错。
