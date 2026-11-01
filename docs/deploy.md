# 部署

Self-host 部署到你自己的 Cloudflare 账号。Workers 免费套餐就够，不需要信用卡、自定义域名或付费绑定。

规则在 Worker 包内的 JSON 文件里，热路径读缓存，不读 D1。审计可以进 D1，白名单可以进 KV。这两个绑定都可以先不填。没填时审计和白名单留在 isolate 内存里，`wrangler deploy` 仍然成功。

## 准备

- Node.js 22、pnpm 10
- 一个 Cloudflare 账号
- BotFather 创建的 bot token

生成 webhook 密钥。Telegram 的 `secret_token` 只允许字母、数字、下划线和短横线，长度 1 到 256：

```sh
openssl rand -hex 32
```

把 token 和密钥留在 shell 环境里，不要写进仓库：

```sh
export TELEGRAM_BOT_TOKEN='你的 token'
export WEBHOOK_SECRET='上面生成的 hex'
```

## 创建 D1 和 KV

在 `apps/worker` 里：

```sh
pnpm exec wrangler login
pnpm exec wrangler d1 create tasb
pnpm exec wrangler kv namespace create POLICY_KV
```

把打印出来的 id 写进 `apps/worker/wrangler.jsonc`。仓库里的这份配置故意不带占位 id：

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "tasb",
    "database_id": "<d1 create 打印的 id>"
  }
],
"kv_namespaces": [
  {
    "binding": "POLICY_KV",
    "id": "<kv namespace create 打印的 id>"
  }
]
```

迁移可以重复执行。`review_samples` 和审计、规则文档在同一份 SQL 里，再执行一次只会补上缺的表：

```sh
pnpm exec wrangler d1 execute tasb --remote --file=../../packages/adapters-cloudflare/migrations/0001_storage.sql
```

额度数字以 [limits.md](limits.md) 为准。这一步不需要付费计划。

## 部署

```sh
pnpm install
cd apps/worker
pnpm exec wrangler login
printf '%s' "$WEBHOOK_SECRET" | pnpm exec wrangler secret put WEBHOOK_SECRET
printf '%s' "$TELEGRAM_BOT_TOKEN" | pnpm exec wrangler secret put TELEGRAM_BOT_TOKEN
pnpm exec wrangler deploy
```

`TELEGRAM_BOT_TOKEN` 只用于私聊命令的回复。没有它，Webhook 仍然返回 200，只是 bot 不会把 `/help` 的结果发回 Telegram。

可选：把你的 Telegram 用户 id 设成管理员，私聊命令才改得了配置。

```sh
printf '%s' '123456789' | pnpm exec wrangler secret put ADMIN_USER_IDS
```

多个 id 用逗号隔开。不要把 id 写进 `wrangler.jsonc`。

命令回复默认中文。要英文时，在 `wrangler.jsonc` 的 `vars` 里加 `"LOCALE": "en"`。只接受 `zh` 和 `en`。别的值仍用中文。这不是密钥。



部署结束时 Wrangler 会打印 `https://tasb.<你的子域>.workers.dev`。免费套餐使用这个地址即可。

## 设置 Webhook

```sh
curl -sS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -H 'content-type: application/json' \
  -d "{\"url\":\"https://tasb.<你的子域>.workers.dev/telegram/webhook\",\"secret_token\":\"${WEBHOOK_SECRET}\",\"allowed_updates\":[\"message\",\"chat_member\",\"callback_query\"],\"drop_pending_updates\":true}"
```

把 URL 换成部署输出里的地址。`allowed_updates` 要带上 `chat_member` 和 `callback_query`，否则入群更新和验证按钮不会送到 bot。验证状态在 isolate 内存里，重启后未完成的验证会消失；限制的 `until_date` 仍会到期。

## 确认

```sh
curl -sS "https://tasb.<你的子域>.workers.dev/health"
```

期望：

```json
{"ok":true,"service":"tasb","deploymentMode":"self-host"}
```

再用同一条检查脚本打一次 Webhook。它会确认没带密钥时是 401，带密钥的 `message` 更新是 200，并且响应里没有消息原文和密钥：

```sh
cd ../..
TASB_URL='https://tasb.<你的子域>.workers.dev' pnpm smoke
```

`pnpm smoke` 成功时打印 `smoke ok`。然后把 bot 拉进群并授予管理员。群里发一条普通消息后，Telegram 会收到 200。本仓库还不会调用删除、禁言或封禁接口。

## 本地先看一眼

不登录 Cloudflare 也可以看同一条路径。在 `apps/worker/.dev.vars`（已 gitignore）里写：

```sh
WEBHOOK_SECRET=你的hex
TELEGRAM_BOT_TOKEN=
ADMIN_USER_IDS=
```

另开一个终端：

```sh
pnpm --filter @tasb/worker dev
```

默认监听 `http://127.0.0.1:8787`。然后：

```sh
WEBHOOK_SECRET='你的hex' pnpm smoke
```
