# 架构

TASB 是一个 Telegram 反垃圾 bot。运行形态有两种，核心只有一份。

- **Self-host**：用户把 `apps/worker` 部署到自己的 Cloudflare 账号。单租户，没有计费。
- **Cloud**：维护者部署公共 bot。用户把 bot 拉进群并授予管理员权限即接入。额度、租户目录放在 `apps/cloud`，以后才实现。

核心通过端口接收存储、时钟、日志和处罚能力。它不读取 `DEPLOYMENT_MODE`，也没有 `self-host` / `cloud` 分支。

## 依赖方向

```text
apps/worker
  ├─▶ packages/platform-telegram ─▶ packages/core
  ├─▶ packages/adapters-cloudflare ─▶ packages/core
  ├─▶ packages/detectors-* ─▶ packages/core
  └─▶ packages/actions ─▶ packages/core

apps/cloud ─▶ （未来的租户/额度模块；谁都不许反向依赖它）

examples / evals / packages/sdk ─▶ core 与插件

packages/core ─▶ zod
```

禁止的依赖：

- `packages/core` 依赖任何 adapter、platform、app、检测器或动作包
- 检测器依赖动作、适配器或 Telegram 包
- 适配器依赖 Telegram 包
- `apps/cloud` 被 core 引用

`scripts/check-boundaries.mjs` 在 CI 里检查 import。

## 一次检测

```text
Event
  → prefilter        管理员豁免 / 白名单，命中则直接 allow
  → detectors        并行。每个返回 score + reasons + evidence，或 null
  → aggregate        max 或 sum，按规则阈值比较
  → decision         取最重动作：ban > mute > delete > captcha > report > log > allow
  → actions          delete / …；dry-run 只记录，不调用端口
  → audit            非 allow 且非 dry-run 时写存储。失败不影响决策
```

检测器抛错或超时：默认 fail-open（当作没命中，并记一条 `detector_error`）。`failureMode: "closed"` 时把该检测器当作 score 1。配置错误（重复插件、非法超时、非法事件）直接抛出，不吞掉。

动作抛错同样不推翻已经做出的决策，结果记为 `failed`。

## 插件

Detector、Action、以及以后的 RuleSource、Notifier、Storage 都走同一套元数据：`id`、`version`、`capabilities`、zod `configSchema`。`defineDetector` / `defineAction` 在创建时校验配置。

规则是 JSON，由 `ruleSetSchema` 校验。版本字段目前只有 `1`。YAML 解析器还没有引入。

## 多租户

每条事件、规则和审计都带 `tenantId` 与 `chatId`。Self-host 是「一个租户、不计费」的配置，不是另一套程序。租户如何开通、额度如何扣，只允许出现在 `apps/cloud`。

## 隐私

请求处理期间，`Event.message.text` 可以留在内存里，检测器需要它。存储端口的 `AuditRecord` 没有原文栏位，只有 `textSha256`、原因和截断后的证据摘要。写入前会拒绝与原文完全相同的字符串，以及名为 `text` / `body` / `caption` / `raw` / `messageText` / `content` 的字段。

日志字段同样会丢掉这些键。检测器异常的 `message` 不会进入日志，避免把用户原文从错误对象里漏出去。

## 部署形态放在哪

`apps/worker` 读取 `DEPLOYMENT_MODE`，只影响 `/health` 这样的进程元数据。把 bot 行为按模式拆开，需要新的 ADR。
