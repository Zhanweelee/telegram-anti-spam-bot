# 安全

不要在公开 issue 或 PR 里贴 bot token、webhook secret、私人聊天内容。

请用 GitHub 的私有安全通告报告漏洞。如果仓库还没打开这个功能，先私下联系维护者，不要把利用细节发到 issue。

运行时的密钥放在 Workers Secrets。本地只放 `apps/worker/.dev.vars`，不要提交。审计和日志不得保存消息原文。Webhook 必须校验 Telegram 的 `secret_token`；未配置 `WEBHOOK_SECRET` 时入口直接 401，不进入流水线。
