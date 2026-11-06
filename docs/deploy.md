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

Workers AI 也先不要绑。默认规则 `llm_hint` 是关闭的。要打开时，在 `wrangler.jsonc` 里加 `"ai": { "binding": "AI" }`，再把那条规则的 `enabled` 改成 true。模型名和免费计划限制见 ADR 0015。

正则规则 `regex_hint` 同样是关闭的。要打开时只改这条规则的 `enabled`，或在私聊用 `/rule`。模式列表在检测器里，创建时就会拒绝过长或带嵌套量词的写法。见 ADR 0023。

`/rule [chatId] <ruleId> on|off|reset` 只改这一群这一条已有规则的启用状态。同一个命令还可以换成 `log`、`report`、`captcha`、`decline`、`delete`、`warn`、`mute`、`ban` 里的一个动作，`file` 回到文件里的动作。没配 `POLICY_KV` 时，开关和动作各在 isolate 内存里，最多 256 个群、每个群 32 条，重启后回到文件。配了 `POLICY_KV` 之后，开关和 dry-run 仍写进原来的键，动作写进 `runtime-action` 键，每个群最多 32 条，重启还在。热路径用本 isolate 的 60 秒缓存，不按每条消息读 KV。不新增绑定。见 ADR 0034、ADR 0035 和 ADR 0458。

`/report <chatId> [targetId|reset]` 决定这个群的上报发到哪里。不设置时仍发给配置里的第一个管理员，回复里不写这个编号。目的地不能是本群。没配 `POLICY_KV` 时记在 isolate 内存里，最多 256 个群，重启后回到默认。配了之后写进 `runtime-report` 键，重启还在。见 ADR 0021 和 ADR 0459。

`/flood <chatId> [count [seconds]|reset]` 改这个群的洪泛窗口。不设置时仍是 10 秒 5 条。只写条数时秒数保持现状。写成 5 和 10，或 `reset`，都回到默认。条数是 2 到 32，秒数是 1 到 300。没配 `POLICY_KV` 时记在 isolate 内存里，最多 256 个群，重启后回到默认。配了之后写进 `runtime-flood` 键，重启还在。见 ADR 0010 和 ADR 0460。

`/keyword <chatId> [add|remove <token>|reset]` 给这个群追加关键词。内置词「免费领取」和「加微信」仍在。只列出追加的词。一个词折叠后最多 32 个字符，一个群最多 32 个。没配 `POLICY_KV` 时记在 isolate 内存里，最多 256 个群，重启后只剩内置词。配了之后写进 `runtime-keyword` 键，重启还在。见 ADR 0461。

`/repeat <chatId> [count [seconds]|reset]` 改这个群的重复窗口。不设置时仍是 60 秒 3 条。只写条数时秒数保持现状。写成 3 和 60，或 `reset`，都回到默认。条数是 2 到 32，秒数是 1 到 300。没配 `POLICY_KV` 时记在 isolate 内存里，最多 256 个群，重启后回到默认。配了之后写进 `runtime-repeat` 键，重启还在。见 ADR 0010 和 ADR 0462。

`/rulemute <chatId> [seconds|reset]` 改这个群在规则命中后的禁言时长。不设置时仍是 3600 秒。写成 3600，或 `reset`，都回到默认。秒数是 30 到 366 天。私聊 `/mute` 不写秒数时仍是 3600 秒。没配 `POLICY_KV` 时记在 isolate 内存里，最多 256 个群，重启后回到默认。配了之后写进 `runtime-mute` 键，重启还在。见 ADR 0004 和 ADR 0463。

`/verifyfor <chatId> [seconds|reset]` 改这个群的验证时长。不设置时仍是 300 秒。写成 300，或 `reset`，都回到默认。秒数是 30 到 86400。入群验证和私聊 `/captcha` 用同一段时长。没配 `POLICY_KV` 时记在 isolate 内存里，最多 256 个群，重启后回到默认。配了之后写进 `runtime-captcha` 键，重启还在。见 ADR 0450 和 ADR 0464。

`/verifyfail <chatId> [stay|kick|ban|reset]` 决定这个群验证到期后怎么处理。不设置时成员留下。`kick` 移出，以后还能再加入。`ban` 封禁。`stay` 或 `reset` 回到留下。没配 `POLICY_KV` 时记在 isolate 内存里，最多 256 个群。配了之后写进 `runtime-captcha-fail` 键。定时清理和过期后点按钮都读这份记录。见 ADR 0009 和 ADR 0465。

`/allowhost <chatId> [add|remove <host>|reset]` 让这个群放行一台主机。不添加时短链、邀请和裸 IP 仍删除。带路径或端口的值不写入。没配 `POLICY_KV` 时记在 isolate 内存里，最多 256 个群，一个群最多 32 台。配了之后写进 `runtime-allow-host` 键。见 ADR 0466。正文上的文字链接后来由 ADR 0737 不能越过正文。说明上的文字链接后来由 ADR 0738 不能越过说明。手动引用自己就是正文时，文字链接后来由 ADR 0739 不能越过摘录。投票描述上的文字链接后来由 ADR 0740 不能越过描述。

`/allowhost <chatId> skip <count>` 跳过前面的主机再往下列。不写 `skip` 时仍从第一台开始。见 ADR 0524。

`/rule <chatId> service_notice on` 删掉这个群的入群和退群服务消息。默认关闭。`off` 回到留下。入群验证仍走 `chat_member`。见 ADR 0467。

配了 `DB` 之后，入群验证的挑战写在同一份 D1 里。另一个 isolate 收到按钮时仍能对上 nonce。没配 `DB` 时挑战留在 isolate 内存，重启后丢失。Cron 只删除已经到期的行，一次最多 64 条，不提前解除 Telegram 限制。表用 `CREATE TABLE IF NOT EXISTS`，再执行一次迁移只会补上缺的表。不新增绑定。见 ADR 0009 和 ADR 0051。

哪些可见字段会进检测，写在 [message-surface.md](message-surface.md)。

洪泛和重复默认在 isolate 内存里计数。同一条事件 id 在这个 key 最近 32 次里只计一次。要跨 isolate 累加时，在自己的 `wrangler.jsonc` 里加 Durable Object，绑定名是 `RATE_WINDOW`，类名是 `RateWindowObject`，迁移用 `new_sqlite_classes`。提交的配置不加这个绑定。对象调用失败时这条检测放过。Webhook 预算仍在内存。见 ADR 0010 和 ADR 0050。

`/blocklist <chatId> on|off`、`add` 和 `remove` 只改这个租户的共享名单。状态行带 `shared` 和条目数，这是整个租户的条数，不列出标识。`remove` 删一条 actor id 或哈希，回复不回显这条标识。名单里没有它时不写。查看条数也不写。没配 `POLICY_KV` 时，开关和条目在 isolate 内存里，最多 128 个群、256 条，重启后清空。配了之后每个租户一个键，只在真的变化时写，重启还在。热路径用本 isolate 的 60 秒缓存。发出关闭的那次请求之后，下一条消息不再读名单。不新增绑定。见 ADR 0012、ADR 0047 和 ADR 0048。

## 部署

```sh
pnpm install
cd apps/worker
pnpm exec wrangler login
printf '%s' "$WEBHOOK_SECRET" | pnpm exec wrangler secret put WEBHOOK_SECRET
printf '%s' "$TELEGRAM_BOT_TOKEN" | pnpm exec wrangler secret put TELEGRAM_BOT_TOKEN
pnpm exec wrangler deploy
```

`TELEGRAM_BOT_TOKEN` 用于私聊回复，以及 delete、warn、mute、ban 和入群限制。没有它，Webhook 仍然返回 200。处罚只记在这台 isolate 的内存里，bot 不会去删消息、禁言或封禁。见 ADR 0020。

可选：把你的 Telegram 用户 id 设成管理员，私聊命令才改得了配置。

```sh
printf '%s' '123456789' | pnpm exec wrangler secret put ADMIN_USER_IDS
```

多个 id 用逗号隔开。不要把 id 写进 `wrangler.jsonc`。

命令回复默认中文。要英文时，在 `wrangler.jsonc` 的 `vars` 里加 `"LOCALE": "en"`。只接受 `zh` 和 `en`。别的值仍用中文。这不是密钥。

外部插件默认必须带 HMAC 签名。自部署要临时加载未签名插件时，把 secret `ALLOW_UNSIGNED_PLUGINS` 设为 `true`。公共 bot 的 `DEPLOYMENT_MODE=cloud` 会忽略这个值。签名密钥不要写进仓库。

社区规则在 `apps/worker/rules/packs.json`。提交的文件是空对象。管理员在私聊用 `/packs <chatId> <packId>` 之后，这个群才改用其中一份。`/packs <chatId> off` 立刻回到 `default.json` 或 `chats.json`。没配 `POLICY_KV` 时，订阅和上一份成功的规则都在 isolate 内存里，重启后需要重新订阅。配了之后，订阅指针和白名单、规则开关在同一份 KV 里，每个群一个键，重启还在。上一份成功的规则在内容变化时写进同一个 KV，键前缀是 `pack-rules`，本 isolate 缓存 60 秒。超过 16384 个字符不写，坏文档不回写。热路径不会去拉远程地址。见 ADR 0037 和 ADR 0046。订阅之后，私聊 `/rules` 列出正在执行的那一份，包括规则开关，标题带上 pack id。每一行标明 `file` 或 `switch`。未订阅时标题仍只有群 id。读订阅失败时回复参数无效。见 ADR 0038、ADR 0039 和 ADR 0040。额度打开并且这个群已经超额时，不在基础检测器里的规则行末尾是 `paused`，标题末尾带上窗口结束时间。查看不计数。见 ADR 0041 和 ADR 0044。自部署默认不打开额度。

## 免费额度

自部署默认关闭。`DEPLOYMENT_MODE=cloud` 时默认打开：每个群每个 UTC 自然月 3000 次检测。超过之后只跑基础检测器，关键词、洪泛和频道转发还在，`llm` 停用。管理员私聊 `/quota <chatId>` 查看已用次数。状态行末尾带窗口结束时间。超额时下一行列出基础检测器 id，默认名单仍是 ADR 0026。见 ADR 0026、ADR 0042 和 ADR 0043。

不要把下面的变量写进本仓库的 `wrangler.jsonc`。自己的部署可以放在 `vars`，或用 `wrangler secret put`：

- `QUOTA_ENABLED`：`true` 或 `false`，覆盖部署模式的默认开关。
- `QUOTA_LIMIT`：1 到 1000000 的整数。非法值回到 3000。
- `QUOTA_PERIOD`：`calendar_month` 或 `rolling_30d`。非法值回到自然月。
- `QUOTA_BASIC`：逗号分隔的检测器 id，最多 32 个。默认是 `keyword,join,flood,repeat,link,blocklist,forward,regex`。`bot`、`contact` 和 `via` 不在这份默认名单里。云模式超额后，对应规则会停，直到把 id 加进 `QUOTA_BASIC`。`via_inline` 默认还是关闭的。自部署默认不计数。

计数在 isolate 内存里，最多 256 个群，重启后从 0 开始。这不是账单，也没有支付。



部署结束时 Wrangler 会打印 `https://tasb.<你的子域>.workers.dev`。免费套餐使用这个地址即可。

## 设置 Webhook

```sh
curl -sS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -H 'content-type: application/json' \
  -d "{\"url\":\"https://tasb.<你的子域>.workers.dev/telegram/webhook\",\"secret_token\":\"${WEBHOOK_SECRET}\",\"allowed_updates\":[\"message\",\"edited_message\",\"chat_member\",\"chat_join_request\",\"callback_query\",\"my_chat_member\"],\"drop_pending_updates\":true}"
```

把 URL 换成部署输出里的地址。`allowed_updates` 要带上 `edited_message`、`chat_member`、`chat_join_request`、`callback_query` 和 `my_chat_member`，否则编辑后的垃圾消息、入群更新、入群申请、验证按钮，以及 bot 被设为管理员的事件不会送到 bot。已经设过 webhook 的部署要重设一次。见 ADR 0027。接入目录在没配 `POLICY_KV` 时留在内存里，重启后 `/chats` 要等下一次管理员变更。配了 `POLICY_KV` 之后，目录和白名单、规则开关在同一份 KV 里，每个租户一个键，最多 256 个群、每群 32 个用户 id，不含群名。见 ADR 0036。额度打开时，`/chats` 每一行带上已用次数和上限，查看不计数。见 ADR 0045。验证状态在 isolate 内存里，重启后未完成的验证会消失；限制的 `until_date` 仍会到期。同一群 10 秒内超过 30 条更新时，bot 返回 200 并且不再检测，避免 Telegram 重试。同一条更新在最近 32 次计数里只计一次。见 ADR 0024 和 ADR 0339。频道转发默认会被删除。转载群把规则 `channel_forward` 的 `enabled` 改成 false，或在 `chats.json` 里整份换掉规则。讨论组里关联频道自己的帖子留下。原帖来源上的作者签名只留主机名。见 ADR 0025、ADR 0443 和 ADR 0445。

`/chats skip <count>` 跳过前面的群再往下列。不写 `skip` 时仍从第一个群开始。见 ADR 0525。

`/whitelist <chatId> skip <count>` 跳过前面的 id 再往下列。不写 `skip` 时仍从第一个 id 开始。见 ADR 0526。

`/admins <chatId> skip <count>` 跳过前面的管理员再往下列。不写 `skip` 时仍从第一个人开始。见 ADR 0527。

`/chats <chatId>` 列出这个群记下的人。不写群号时仍列出群。见 ADR 0528。

`/guard <chatId>` 写出付费发言的星星数，以及频道是否接受付费媒体。缺字段写未知。见 ADR 0529。

`/guard <chatId>` 写出这个群接受哪些礼物。缺字段写未知。见 ADR 0530。

`/guard <chatId>` 写出这个群有没有绑定地点。没返回写关。见 ADR 0531。

入群名字或新标签命中 `t.me/+` 或「加微x」时封禁。`/rule <chatId> join_regex off` 回到只验证。申请简介命中同一组模式时拒绝。普通消息仍要打开 `regex_hint`。见 ADR 0532。

入群服务消息、视频聊天邀请、换群主和靠近提醒上的可见名字命中同一组模式时删除。`/rule <chatId> service_name_regex off` 回到只看关键词和短链。名字干净时这几行仍留下。见 ADR 0533。

正文旁边的成员标签命中同一组模式时删除。`/rule <chatId> sender_tag_regex off` 回到只看关键词和短链。标签自己就是正文时仍要打开 `regex_hint`。见 ADR 0534。

正文旁边的内联按钮文字命中同一组模式时删除。`/rule <chatId> button_text_regex off` 回到只看关键词和短链。按钮自己就是正文时仍要打开 `regex_hint`。见 ADR 0535。

正文旁边的作者签名，以及讨论组原帖来源上的签名，命中同一组模式时删除。`/rule <chatId> author_signature_regex off` 和 `mirror_signature_regex off` 回到只看关键词和短链。签名自己就是正文时仍要打开 `regex_hint`。见 ADR 0536。

投票选项命中同一组模式时删除。`/rule <chatId> poll_option_regex off` 回到只看关键词和短链。选项自己就是题干时仍要打开 `regex_hint`。见 ADR 0537。投票选项上的文字链接后来由 ADR 0729 不能越过正文。

清单任务命中同一组模式时删除。`/rule <chatId> checklist_task_regex off` 回到只看关键词和短链。任务自己就是标题时仍要打开 `regex_hint`。见 ADR 0538。清单标题和任务上的文字链接后来由 ADR 0726 不能越过正文。

说明旁边的文件名或音频标题命中同一组模式时删除。`/rule <chatId> media_name_regex off` 回到只看关键词和短链。名称自己就是正文时仍要打开 `regex_hint`。见 ADR 0539。

标题旁边的音频表演者命中同一组模式时删除。`/rule <chatId> performer_regex off` 回到只看关键词和短链。表演者自己就是正文时仍要打开 `regex_hint`。见 ADR 0540。

游戏说明、附加文字和账单说明命中同一组模式时删除。`/rule <chatId> game_text_regex off` 和 `invoice_text_regex off` 回到只看关键词和短链。说明自己就是正文时仍要打开 `regex_hint`。见 ADR 0541。游戏附加文字上的文字链接后来由 ADR 0733 不能越过正文。

地点地址命中同一组模式时删除。`/rule <chatId> venue_address_regex off` 回到只看关键词和短链。地址自己就是正文时仍要打开 `regex_hint`。见 ADR 0542。

测验说明命中同一组模式时删除。`/rule <chatId> poll_explanation_regex off` 回到只看关键词和短链。说明自己就是正文时仍要打开 `regex_hint`。见 ADR 0543。测验说明上的文字链接后来由 ADR 0730 不能越过正文。

题干、奖品说明和清单标题命中同一组模式时删除。`/rule <chatId> poll_question_regex off`、`prize_text_regex off` 和 `checklist_title_regex off` 回到只看关键词和短链。这段自己就是正文时仍要打开 `regex_hint`。见 ADR 0544。外部回复清单标题上的文字链接后来由 ADR 0735 不能越过标题。投票题干上的文字链接后来由 ADR 0736 不能越过题干。

游戏、账单和场馆标题命中同一组模式时删除。`/rule <chatId> game_title_regex off`、`invoice_title_regex off` 和 `venue_title_regex off` 回到只看关键词和短链。标题自己就是正文时仍要打开 `regex_hint`。见 ADR 0545。

小程序按钮文字命中同一组模式时删除。`/rule <chatId> web_app_button_regex off` 回到只看关键词和短链。这段自己就是正文时仍要打开 `regex_hint`。见 ADR 0546。

手动引用命中同一组模式时删除。`/rule <chatId> quote_text_regex off` 回到只看关键词和短链。这段自己就是正文时仍要打开 `regex_hint`。见 ADR 0547。引用上的文字链接后来由 ADR 0732 不能越过正文。

礼物附言命中同一组模式时删除。`/rule <chatId> gift_text_regex off` 回到只看关键词和短链。这段自己就是正文时仍要打开 `regex_hint`。见 ADR 0548。礼物附言上的文字链接后来由 ADR 0734 不能越过正文。

独特礼物的收藏名命中同一组模式时删除。`/rule <chatId> gift_label_regex off` 回到只看关键词和短链。这段自己就是正文时仍要打开 `regex_hint`。见 ADR 0549。

论坛话题名命中同一组模式时删除。`/rule <chatId> topic_name_regex off` 回到只看关键词和短链。这段自己就是正文时仍要打开 `regex_hint`。见 ADR 0550。

拒绝建议帖的说明命中同一组模式时删除。`/rule <chatId> decline_comment_regex off` 回到只看关键词和短链。这段自己就是正文时仍要打开 `regex_hint`。见 ADR 0551。

后加的投票选项或清单任务命中同一组模式时删除。`/rule <chatId> added_text_regex off` 回到只看关键词和短链。这段自己就是正文时仍要打开 `regex_hint`。见 ADR 0552。后加或删除的选项上的文字链接后来由 ADR 0731 不能越过正文。

隐藏转发的显示名命中同一组模式时删除。`/rule <chatId> hidden_name_regex off` 回到只看关键词和短链。这段自己就是正文时仍要打开 `regex_hint`。见 ADR 0553。

入群、邀请、换群主或靠近提醒的可见名字命中同一组模式时删除。`/rule <chatId> member_name_regex off` 后，距离无效的靠近提醒回到只看关键词和短链。另外四类仍由 `service_name_regex` 删除。见 ADR 0554。

分享来的用户画出的全名命中同一组模式时删除。用户名不进这段。`/rule <chatId> shared_name_regex off` 回到只看关键词和短链。这段自己就是正文时仍要打开 `regex_hint`。见 ADR 0555 与 ADR 0644。

新建受管 bot 画出的全名命中同一组模式时删除。用户名不进这段。`/rule <chatId> managed_name_regex off` 回到只看关键词和短链。这段自己就是正文时仍要打开 `regex_hint`。见 ADR 0556 与 ADR 0643。

允许发消息带上的小程序名字命中同一组模式时删除。`/rule <chatId> access_name_regex off` 回到只看关键词和短链。这段自己就是正文时仍要打开 `regex_hint`。见 ADR 0557。

游戏动图文件名命中同一组模式时删除。`/rule <chatId> game_file_regex off` 回到只看关键词和短链。这段自己就是正文时仍要打开 `regex_hint`。见 ADR 0558。

音频文件名命中同一组模式时删除。`/rule <chatId> audio_file_regex off` 回到只看关键词和短链。这段自己就是名称时仍要打开 `regex_hint`。见 ADR 0559。

后面的付费视频文件名命中同一组模式时删除。`/rule <chatId> paid_file_regex off` 回到只看关键词和短链。第一段自己就是名称时仍要打开 `regex_hint`。见 ADR 0560。

富文本里的文件名、音频标题和表演者命中同一组模式时删除。`/rule <chatId> rich_name_regex off` 回到只看关键词和短链。和正文是同一截时不重复存放。见 ADR 0561。

投票媒体上的文件名、音频名和场馆名命中同一组模式时删除。`/rule <chatId> poll_media_regex off` 回到只看关键词和短链。和正文是同一截时不重复存放。见 ADR 0562。

投票描述命中同一组模式时删除。`/rule <chatId> poll_description_regex off` 回到只看关键词和短链。这段自己就是正文时仍要打开 `regex_hint`。见 ADR 0563。

富文本里看得见的字命中同一组模式时删除。`/rule <chatId> rich_text_regex off` 回到只看关键词和短链。这段自己就是正文时仍要打开 `regex_hint`。见 ADR 0564。

段落旁边的富文本按钮命中同一组模式时删除。`/rule <chatId> rich_button_regex off` 回到只看关键词和短链。没有段落时，这些字仍留在正文或富文本里。见 ADR 0565。

选中名称之后的文件名命中同一组模式时删除。`/rule <chatId> later_name_regex off` 回到只看关键词和短链。这一段自己就是名称时仍要打开 `regex_hint`。见 ADR 0566。

`/rule <chatId> hidden_forward on` 只删这个群的隐藏来源转发。`chat_forward` 删从别的群转发来的消息，`user_forward` 删用户转发。三条默认关闭。频道转发仍由 `channel_forward` 删除。见 ADR 0468。

`/rule <chatId> media_sticker on` 只删这个群的贴纸。`media_animation` 删动图，`media_voice` 删语音，`media_video_note` 删视频留言，`media_dice` 删骰子。五条默认关闭。付费帖仍留下。见 ADR 0469。

`/rule <chatId> media_photo on` 只删这个群的照片。`media_video` 删视频，`media_document` 删文件，`media_audio` 删音频。四条默认关闭。动图和语音仍留下。付费帖仍留下。见 ADR 0575。

`/rule <chatId> script_arabic on` 删这个群里阿拉伯字母占多数的消息。`script_cyrillic` 删西里尔文。至少 4 个字母，并且要多于其它字母。两条默认关闭。见 ADR 0470。

`/rule <chatId> channel_sender on` 删这个群里别的频道以自己身份发出的消息。默认关闭。讨论组里关联频道的自动转发仍留下。见 ADR 0471。

`/rule <chatId> shared_story on` 删这个群里转发来的故事卡片。默认关闭。只回复一条故事的消息仍留下。见 ADR 0472。

`/rule <chatId> bare_location on` 删这个群里只有坐标的位置消息。默认关闭。带标题的场馆消息仍留下。见 ADR 0473。

`/rule <chatId> giveaway_card on` 删这个群里的抽奖卡片和结束公告。默认关闭。投票仍留下。见 ADR 0474。

`/rule <chatId> call_notice on` 删这个群里视频聊天的开始、结束和预约。默认关闭。邀请名单仍留下。见 ADR 0475。

`/rule <chatId> chat_title on` 删这个群里的改名服务消息。默认关闭。新群名不进证据，群名本身不变。见 ADR 0476。

`/rule <chatId> community_notice on` 删这个群里移入、加入和移出社区的服务消息。默认关闭。社区名字不进证据。见 ADR 0477。

`/rule <chatId> shared_chat on` 删这个群里分享来的聊天卡片。默认关闭。标题不进证据。分享来的用户仍留下。见 ADR 0478。

`/rule <chatId> chat_photo on` 删这个群里换头像和删头像的服务消息。默认关闭。文件号不进证据。群头像本身不变。见 ADR 0479。

`/rule <chatId> chat_background on` 删这个群里换背景的服务消息。默认关闭。文件名不进证据。背景本身不变。见 ADR 0480。

`/rule <chatId> gift_card on` 删这个群里的普通礼物、独特礼物和升级购买。默认关闭。星星数量不进证据。附言里的关键词仍删除。见 ADR 0481。

`/rule <chatId> pin_notice on` 删这个群里的置顶提示。默认关闭。被置顶的原文不进证据。置顶本身还在。见 ADR 0482。文字、账单说明、清单标题的前 20 个码元和游戏标题里的短链也会删除。见 ADR 0653 与 ADR 0654。富文本预览的前 20 个码元后来由 ADR 0714 也只留主机名。文字预览上的文字链接后来由 ADR 0715 也只留主机名。清单标题上的文字链接后来由 ADR 0716 也只留主机名。思考块不画在富文本预览里，后来由 ADR 0718 改读后面的块。提及、日期和表情替代字后来由 ADR 0719 改读后面的字。没勾上的复选框后来由 ADR 0720 多占一个码元。字母和罗马数字编号后来由 ADR 0721 按画出来的长度占位。语音后来由 ADR 0723 改读后面。行内公式后来由 ADR 0724 占满后面。

`/rule <chatId> giveaway_notice on` 删这个群里的抽奖创建公告和没有公开中奖者的结束公告。默认关闭。奖品原文不进证据。抽奖本身不取消。见 ADR 0483。创建公告上画出的群名里的短链也会删除。见 ADR 0656。

`/rule <chatId> chat_boost on` 删这个群里的助推提示。默认关闭。次数不进证据。助推本身还在。见 ADR 0484。

`/rule <chatId> forum_notice on` 删这个群里关掉话题、重开话题、隐藏通用话题和重新显示通用话题的提示。默认关闭。话题名不进证据。话题开关不变。见 ADR 0485。

`/rule <chatId> autodelete_notice on` 删这个群里改自动删除计时的提示。默认关闭。秒数不进证据。计时本身还在。见 ADR 0486。

`/rule <chatId> price_notice on` 删这个群里付费发言改价和私信改价的提示。默认关闭。星星数量不进证据。价格和私信开关不变。见 ADR 0487。

`/rule <chatId> post_notice on` 删这个群里建议帖通过、付款失败、付款和退款的提示。默认关闭。原帖和价格不进证据。稿子状态不变。见 ADR 0488。

`/rule <chatId> checklist_notice on` 删这个群里清单标成完成和取消完成的提示。默认关闭。任务号不进证据。任务完成状态不变。见 ADR 0489。对上的第一条任务里的短链也会删除。见 ADR 0655。勾完的任务上的文字链接后来由 ADR 0728 不能越过正文。

群升级成超级群时，旧编号上的开关、关键词、洪泛、重复、禁言、验证、允许的主机名和白名单会抄到新编号。新编号已经保存的那一项留下。见 ADR 0490。

`/rule <chatId> call_invite on` 删这个群里把人拉进视频聊天的提示。默认关闭。用户编号不进证据。被邀请的名字仍参与关键词。开始、结束和预约仍看 `call_notice`。见 ADR 0491。

`/rule <chatId> owner_notice on` 删这个群里换群主和群主离开的提示。默认关闭。用户编号不进证据。新群主的名字仍参与关键词。没有下一位时这行也会删除。见 ADR 0492。

`/rule <chatId> proximity_notice on` 删这个群里的靠近提醒。默认关闭。距离和用户编号不进证据。两个人的名字仍参与关键词。纯坐标仍看 `bare_location`。见 ADR 0493。

`/rule <chatId> poll_notice on` 删这个群里后加投票选项和删除投票选项的提示。默认关闭。选项编号和原投票不进证据。选项文字仍参与关键词。投票题干仍不带这个标记。见 ADR 0494。

`/rule <chatId> checklist_added on` 删这个群里新加清单任务的提示。默认关闭。任务编号、完成者名字和原清单不进证据。任务文字仍参与关键词。完成和取消完成仍看 `checklist_notice`。见 ADR 0495。后加任务上的文字链接后来由 ADR 0727 不能越过正文。

`/rule <chatId> topic_notice on` 删这个群里新建话题和改名的提示。默认关闭。图标颜色和自定义表情编号不进证据。话题名仍参与关键词。只改图标时这行也会删除。关掉和重开仍看 `forum_notice`。见 ADR 0496。

`/rule <chatId> post_declined on` 删这个群里建议帖被拒绝的提示。默认关闭。原帖不进证据。拒绝说明仍参与关键词。没有说明时这行也会删除。通过、失败、付款和退款仍看 `post_notice`。见 ADR 0497。

`/rule <chatId> group_created on` 删这个群里普通群刚建好的提示。默认关闭。发送者名字不进证据。超级群和频道的创建字段不带这个标记。入群和退群仍看 `service_notice`。见 ADR 0498。

`/rule <chatId> post_pending on` 删这个群里待审建议帖正文。默认关闭。价格和发表时间不进证据。通过、失败、付款和退款仍看 `post_notice`。拒绝仍看 `post_declined`。见 ADR 0499。

`/rule <chatId> media_spoiler on` 删这个群里盖着剧透的媒体。默认关闭。文件号不进证据。说明仍参与关键词。没有剧透的照片和视频仍留下。见 ADR 0500。

`/rule <chatId> message_effect on` 删这个群里带消息特效的消息。默认关闭。特效编号不进证据。正文仍参与关键词。没有特效的消息仍留下。见 ADR 0576。

后加投票选项的人，菜单上的短名里的短链、邀请或裸 IP 会删掉这条消息。从下标 2 起的空格后面不读。群标题仍整段读。证据只有主机名。名字和用户名不进事件。`example.com` 仍留下。见 ADR 0577 与 ADR 0662。

清单任务的完成者，名字里的短链、邀请或裸 IP 会删掉这条消息。证据只有主机名。名字和用户名不进事件。`example.com` 仍留下。见 ADR 0578。

已知用户和群的转发抬头里的短链、邀请或裸 IP 会删掉这条消息。证据只有主机名。名字和用户名不进事件。频道标题仍不读。见 ADR 0579。

公开中奖者的名字里的短链、邀请或裸 IP 会删掉这条消息。证据只有主机名。名字和用户名不进事件。`example.com` 仍留下。见 ADR 0580。

别的聊天代发时，标题里的短链、邀请或裸 IP 会删掉这条消息。证据只有主机名。标题和用户名不进事件。本群自己的身份仍不读。见 ADR 0581。

退群的人，名字里的短链、邀请或裸 IP 会删掉这条提示。证据只有主机名。名字和用户名不进事件。`example.com` 仍留下。见 ADR 0582。

助推的人，名字里的短链、邀请或裸 IP 会删掉这条提示。发送者是聊天时只读聊天标题。证据只有主机名。名字和用户名不进事件。`example.com` 仍留下。见 ADR 0674。

改自动删除计时的人，名字里的短链、邀请或裸 IP 会删掉这条提示。证据只有主机名。名字和用户名不进事件。`example.com` 仍留下。见 ADR 0584。

改价的人，名字里的短链、邀请或裸 IP 会删掉这条提示。发送者是聊天时只读聊天标题。证据只有主机名。名字、用户名和星星数量不进事件。`example.com` 仍留下。见 ADR 0680。

置顶的人，名字里的短链、邀请或裸 IP 会删掉这条提示。发送者是聊天时不读占位名字。证据只有主机名。名字、用户名和被置顶的原文不进事件。`example.com` 仍留下。见 ADR 0684。文字预览前 20 个码元和游戏标题也一样。见 ADR 0653。富文本预览的前 20 个码元后来由 ADR 0714 也只留主机名。文字预览上的文字链接后来由 ADR 0715 也只留主机名。清单标题上的文字链接后来由 ADR 0716 也只留主机名。思考块不画在富文本预览里，后来由 ADR 0718 改读后面的块。提及、日期和表情替代字后来由 ADR 0719 改读后面的字。没勾上的复选框后来由 ADR 0720 多占一个码元。字母和罗马数字编号后来由 ADR 0721 按画出来的长度占位。语音后来由 ADR 0723 改读后面。行内公式后来由 ADR 0724 占满后面。

建群的人，名字里的短链、邀请或裸 IP 会删掉这条提示。发送者是聊天时只读聊天标题。证据只有主机名。名字和用户名不进事件。`example.com` 仍留下。见 ADR 0681。

开视频聊天的人，名字里的短链、邀请或裸 IP 会删掉这条提示。结束和预约同样。证据只有主机名。名字、用户名和时长不进事件。`example.com` 仍留下。见 ADR 0588。

关话题的人，名字里的短链、邀请或裸 IP 会删掉这条提示。重开、隐藏和重新显示同样。证据只有主机名。名字、用户名和话题名不进事件。`example.com` 仍留下。见 ADR 0589。

创建公告上画出的群名含短链、邀请或裸 IP 时会删除这条提示。证据只有主机名。发送者的名字不读。`example.com` 仍留下。见 ADR 0664。

换头像的人，名字里的短链、邀请或裸 IP 会删掉这条提示。删头像同样。频道不读发送者。群里发送者是聊天时只读聊天标题。证据只有主机名。名字、用户名和文件号不进事件。`example.com` 仍留下。见 ADR 0682。

改名的人，名字里的短链、邀请或裸 IP 会删掉这条提示。频道不读发送者。群里发送者是聊天时只读聊天标题。证据只有主机名。名字、用户名和新群名不进事件。`example.com` 仍留下。见 ADR 0683。

换背景的人，名字里的短链、邀请或裸 IP 会删掉这条提示。壁纸、图案和纯色由聊天换时不读。内置主题由聊天换时读聊天标题。证据只有主机名。名字、用户名和文件号不进事件。`example.com` 仍留下。见 ADR 0696。

动社区的人，名字里的短链、邀请或裸 IP 会删掉这条提示。移入、加入和移出同样。发送者是聊天时只读聊天标题。证据只有主机名。名字、用户名和社区编号不进事件。`example.com` 仍留下。见 ADR 0688。

交群的人，名字里的短链、邀请或裸 IP 会删掉这条提示。离开同样。发送者是聊天时只读聊天标题。证据只有主机名。这个人的名字、用户名和用户编号不进事件。`example.com` 仍留下。见 ADR 0687。

拉进视频聊天的人，名字里的短链、邀请或裸 IP 会删掉这条提示。证据只有主机名。这个人的名字、用户名和用户编号不进事件。`example.com` 仍留下。见 ADR 0596。

靠近提醒不读消息发送者。触发者和设置者全名里的短链、邀请或裸 IP 会删掉这条提示。证据只有主机名。发送者的名字、用户名和用户编号不进事件。`example.com` 仍留下。见 ADR 0697。

拉人进群的人，名字里的短链、邀请或裸 IP 会删掉这条提示。证据只有主机名。这个人的名字、用户名和用户编号不进事件。`example.com` 仍留下。见 ADR 0598。

送礼的人画出的全名里的短链、邀请或裸 IP 会删掉这条提示。证据只有主机名。发送者是聊天时只读聊天标题，不读占位名字。用户仍按全名。购买报价成交不读发送者，也不读本群标题。升级只读私聊对方的全名。转账和转售读对话。这个人的名字、用户名和短名不进事件。`example.com` 仍留下。见 ADR 0599、ADR 0648、ADR 0691、ADR 0693、ADR 0694 与 ADR 0695。

拒绝建议帖不读消息发送者。这个人的名字和用户名不进事件。说明和话题用户全名里的短链、邀请或裸 IP 会删掉这条提示。证据只有主机名。`example.com` 仍留下。见 ADR 0600、ADR 0692 与 ADR 0698。回复的人不是话题用户时，话题用户全名也一样。见 ADR 0652。

通过、失败、付款或退款建议帖不读消息发送者。这个人的名字和用户名不进事件。话题用户全名里的短链、邀请或裸 IP 会删掉这条提示。证据只有主机名。`example.com` 仍留下。见 ADR 0601、ADR 0692 与 ADR 0698。付款失败、退款和有价通过上的话题用户全名也一样。见 ADR 0650 和 ADR 0651。

勾完或取消勾完清单的人，名字里的短链、邀请或裸 IP 会删掉这条提示。发送者是聊天时只读聊天标题。证据只有主机名。这个人的名字和用户名不进事件。`example.com` 仍留下。见 ADR 0686。

新加清单任务的人，名字里的短链、邀请或裸 IP 会删掉这条提示。发送者是聊天时只读聊天标题。证据只有主机名。这个人的名字和用户名不进事件。`example.com` 仍留下。见 ADR 0686。四条起只读前三条任务。见 ADR 0660。

加选项或删选项的人，短名里的短链、邀请或裸 IP 会删掉这条提示。证据只有主机名。从下标 2 起的空格后面不读。发送者是聊天时不读占位名字，也不读这个聊天的标题。用户仍按短名。这个人的名字和用户名不进事件。`example.com` 仍留下。见 ADR 0604、ADR 0659 与 ADR 0690。

改名话题的人，名字里的短链、邀请或裸 IP 会删掉这条提示。证据只有主机名。新建不读发送者。`example.com` 仍留下。见 ADR 0665。

把人移出群的人，名字里的短链、邀请或裸 IP 会删掉这条提示。证据只有主机名。这个人的名字和用户名不进事件。`example.com` 仍留下。见 ADR 0606。

入群申请的名字里的短链、邀请或裸 IP 会拒绝这条申请。证据只有主机名。这个人的名字和用户名不进事件。`example.com` 仍留下。见 ADR 0607。

频道私信话题里，话题用户名字中的短链、邀请或裸 IP 会删除这条消息。证据只有主机名。这个人的名字和用户名不进事件。`example.com` 仍留下。见 ADR 0608。

名片名字里的短链、邀请或裸 IP 会删除这条消息。证据只有主机名。这个人的名字和电话不进事件。`example.com` 在关掉名片规则后仍留下。见 ADR 0609。

成员转发的频道标题里的短链、邀请或裸 IP 会删除这条消息。证据只有主机名。标题和用户名不进事件。`example.com` 在关掉频道转发后仍留下。见 ADR 0610。

成员转发的频道签名里的短链、邀请或裸 IP 会删除这条消息。证据只有主机名。签名和用户名不进事件。`example.com` 在关掉频道转发后仍留下。见 ADR 0611。

群来源的签名里的短链、邀请或裸 IP 会删除这条消息。证据只有主机名。签名和用户名不进事件。`example.com` 仍留下。见 ADR 0612。

名片公司名里的短链、邀请或裸 IP 会删除这条消息。证据只有主机名。公司名和电话不进事件。`example.com` 在关掉名片规则后仍留下。见 ADR 0613。

名片没有姓名时，标题上的电话里的短链、邀请或裸 IP 会删除这条消息。证据只有主机名。电话原文不进事件。`example.com` 在关掉名片规则后仍留下。见 ADR 0614。

名片副标题里原样画出的电话或邮箱含短链、邀请或裸 IP 时会删除这条消息。证据只有主机名。原文不进事件。`example.com` 在关掉名片规则后仍留下。见 ADR 0615。

客座回复抬头上 bot 自己的短名含短链、邀请或裸 IP 时会删除这条消息。证据只有主机名。名字不进事件。`example.com` 仍留下。见 ADR 0616。召唤者同样按短名。见 ADR 0661。

商业账号代发时，时间戳旁的 bot 全名含短链、邀请或裸 IP 时会删除这条消息。证据只有主机名。名字不进事件。`example.com` 仍留下。见 ADR 0617。

付款成功这行画出的名字或账单标题含短链、邀请或裸 IP 时会删除这条消息。证据只有主机名。名字不进事件。`example.com` 仍留下。见 ADR 0618。私聊退款画出的对方全名也一样。见 ADR 0649。护照提示上画出的私聊对方也一样。见 ADR 0657。

已知用户转发抬头画出的全名含短链、邀请或裸 IP 时会删除这条消息。证据只有主机名。名字不进事件。`example.com` 仍留下。见 ADR 0619。

置顶提示上画出的发送者全名含短链、邀请或裸 IP 时会删除这条消息。发送者是聊天时不读占位名字。证据只有主机名。名字不进事件。`example.com` 仍留下。见 ADR 0684。文字预览前 20 个码元和游戏标题也一样。见 ADR 0653。富文本预览的前 20 个码元后来由 ADR 0714 也只留主机名。文字预览上的文字链接后来由 ADR 0715 也只留主机名。清单标题上的文字链接后来由 ADR 0716 也只留主机名。思考块不画在富文本预览里，后来由 ADR 0718 改读后面的块。提及、日期和表情替代字后来由 ADR 0719 改读后面的字。没勾上的复选框后来由 ADR 0720 多占一个码元。字母和罗马数字编号后来由 ADR 0721 按画出来的长度占位。语音后来由 ADR 0723 改读后面。行内公式后来由 ADR 0724 占满后面。

建群提示上画出的发送者全名含短链、邀请或裸 IP 时会删除这条消息。发送者是聊天时只读聊天标题。证据只有主机名。名字不进事件。`example.com` 仍留下。见 ADR 0681。

拉人进群的人画出的全名含短链、邀请或裸 IP 时会删除这条消息。频道自己加入不读发送者。发送者是聊天时只读聊天标题。证据只有主机名。名字不进事件。`example.com` 仍留下。见 ADR 0677。

把人移出群的人画出的全名含短链、邀请或裸 IP 时会删除这条消息。发送者是聊天时只读聊天标题。证据只有主机名。名字不进事件。`example.com` 仍留下。见 ADR 0678。

离开的人画出的全名含短链、邀请或裸 IP 时会删除这条消息。证据只有主机名。名字不进事件。`example.com` 仍留下。见 ADR 0624。

关掉、重开、隐藏或重新显示话题的人画出的全名含短链、邀请或裸 IP 时会删除这条消息。发送者是聊天时只读聊天标题。证据只有主机名。名字不进事件。`example.com` 仍留下。见 ADR 0685。

改名或只换图标的人画出的全名含短链、邀请或裸 IP 时会删除这条消息。发送者是聊天时只读聊天标题。证据只有主机名。名字不进事件。`example.com` 仍留下。见 ADR 0685。

勾完或取消勾完清单的人画出的全名含短链、邀请或裸 IP 时会删除这条消息。发送者是聊天时只读聊天标题。证据只有主机名。名字不进事件。`example.com` 仍留下。见 ADR 0686。

新加清单任务的人画出的全名含短链、邀请或裸 IP 时会删除这条消息。发送者是聊天时只读聊天标题。证据只有主机名。名字不进事件。`example.com` 仍留下。见 ADR 0686。

改付费发言或私信开关的人画出的全名含短链、邀请或裸 IP 时会删除这条消息。发送者是聊天时只读聊天标题。证据只有主机名。名字不进事件。`example.com` 仍留下。见 ADR 0680。

改自动删除计时的人画出的全名含短链、邀请或裸 IP 时会删除这条消息。频道不读发送者。群里发送者是聊天时只读聊天标题。证据只有主机名。名字不进事件。`example.com` 仍留下。见 ADR 0679。

换头像或删头像的人画出的全名含短链、邀请或裸 IP 时会删除这条消息。频道不读发送者。群里发送者是聊天时只读聊天标题。证据只有主机名。名字不进事件。`example.com` 仍留下。见 ADR 0682。

改群名的人画出的全名含短链、邀请或裸 IP 时会删除这条消息。频道不读发送者。群里发送者是聊天时只读聊天标题。证据只有主机名。名字不进事件。`example.com` 仍留下。见 ADR 0683。

交群或离开的人画出的全名含短链、邀请或裸 IP 时会删除这条消息。发送者是聊天时只读聊天标题。证据只有主机名。名字不进事件。`example.com` 仍留下。见 ADR 0687。

拉进视频聊天的人画出的全名含短链、邀请或裸 IP 时会删除这条消息。发送者是聊天时只读聊天标题。证据只有主机名。名字不进事件。`example.com` 仍留下。见 ADR 0676。

开始或结束视频聊天的人画出的全名含短链、邀请或裸 IP 时会删除这条消息。频道不读发送者。群里发送者是聊天时只读聊天标题。证据只有主机名。名字不进事件。预约不读发送者。`example.com` 仍留下。见 ADR 0675。

加入社区的人画出的全名含短链、邀请或裸 IP 时会删除这条消息。发送者是聊天时只读聊天标题。证据只有主机名。名字不进事件。移入和移出的用户画短名，从下标 2 起的空格后面不读。`example.com` 仍留下。见 ADR 0688。

频道私信话题标题上的用户全名含短链、邀请或裸 IP 时会删除这条消息。证据只有主机名。名字不进事件。发言人不是这个用户时不读。`example.com` 仍留下。见 ADR 0637。

入群申请名单上的申请人全名含短链、邀请或裸 IP 时会拒绝这条申请。证据只有主机名。名字不进事件。`example.com` 仍留下。见 ADR 0638。

名片标题上的全名含短链、邀请或裸 IP 时会删除这条消息。证据只有主机名。名字不进事件。`example.com` 在关掉名片规则后仍留下。见 ADR 0639。

公开抽奖结果上的中奖者全名含短链、邀请或裸 IP 时会删除这条消息。证据只有主机名。名字不进事件。`example.com` 仍留下。见 ADR 0640。

清单任务上的完成者全名含短链、邀请或裸 IP 时会删除这条消息。证据只有主机名。名字不进事件。`example.com` 仍留下。见 ADR 0641。

靠近提醒上画出的两个人的全名含短链、邀请或裸 IP 时会删除这条消息。证据只有主机名。用户名不进事件。消息发送者不读。`example.com` 仍留下。见 ADR 0697。

新建受管 bot 上画出的全名含短链、邀请或裸 IP 时会删除这条消息。证据只有主机名。用户名不进事件。`example.com` 仍留下。见 ADR 0643。

分享给 bot 的用户画出的全名含短链、邀请或裸 IP 时会删除这条消息。证据只有主机名。几个人用逗号分开。用户名不进事件。`example.com` 仍留下。见 ADR 0644。

入群名单上画出的全名含短链、邀请或裸 IP 时会删除这条服务消息。频道自己加入不读这份名单。证据只有主机名。几个人用逗号分开。用户名不进事件。`example.com` 仍留下。见 ADR 0670。

视频聊天邀请名单上画出的全名含短链、邀请或裸 IP 时会删除这条服务消息。证据只有主机名。几个人用逗号分开。用户名不进事件。`example.com` 仍留下。见 ADR 0646。

新群主画出的全名含短链、邀请或裸 IP 时会删除这条服务消息。证据只有主机名。用户名不进事件。`example.com` 仍留下。见 ADR 0647。

`/rule <chatId> rich_phone on` 和 `/rule <chatId> rich_card on` 分别删这个群里的富文本电话和银行卡。默认关闭。号码不进证据。看得见的字仍参与关键词。见 ADR 0501。

`/rule <chatId> rich_email on` 删这个群里的富文本邮箱。默认关闭。地址不进证据。看得见的字仍参与关键词。电话和银行卡仍看各自的规则。见 ADR 0502。

`/rule <chatId> media_spoiler on` 也删富文本里盖着剧透的照片、视频和动图。文件号不进证据。说明仍参与关键词。见 ADR 0503。

`/rule <chatId> rich_map on` 删这个群里的富文本地图。默认关闭。坐标不进证据。说明仍参与关键词。纯位置仍看 `bare_location`。见 ADR 0504。

`/rule <chatId> rich_mention on` 删这个群里的富文本用户名提及。默认关闭。用户名不进证据。看得见的字仍参与关键词。邮箱仍看 `rich_email`。见 ADR 0505。

`/rule <chatId> rich_text_mention on` 删这个群里按用户标识的富文本提及。默认关闭。用户编号不进证据。看得见的字仍参与关键词。用户名提及仍看 `rich_mention`。见 ADR 0506。

`/rule <chatId> rich_command on` 删这个群里的富文本机器人命令。默认关闭。命令不进证据。看得见的字仍参与关键词。按标识提及仍看 `rich_text_mention`。见 ADR 0507。

`/rule <chatId> rich_hashtag on` 删这个群里的富文本话题标签。默认关闭。标签不进证据。看得见的字仍参与关键词。机器人命令仍看 `rich_command`。见 ADR 0508。

`/rule <chatId> rich_cashtag on` 删这个群里的富文本行情标签。默认关闭。行情代码不进证据。看得见的字仍参与关键词。话题标签仍看 `rich_hashtag`。见 ADR 0509。

`/rule <chatId> rich_anchor on` 删这个群里的富文本锚点。默认关闭。名字不进证据。看得见的字仍参与关键词。行情标签仍看 `rich_cashtag`。见 ADR 0510。

`/rule <chatId> rich_anchor_link on` 删这个群里指向锚点的富文本链接。默认关闭。名字不进证据。看得见的字仍参与关键词。锚点仍看 `rich_anchor`。见 ADR 0511。

`/rule <chatId> rich_reference on` 删这个群里的富文本引用。默认关闭。名字不进证据。看得见的字仍参与关键词。锚点链接仍看 `rich_anchor_link`。见 ADR 0512。

`/rule <chatId> rich_reference_link on` 删这个群里指向引用的富文本链接。默认关闭。名字不进证据。看得见的字仍参与关键词。引用仍看 `rich_reference`。见 ADR 0513。

`/rule <chatId> text_mention on` 删这个群里按用户标识的普通提及。默认关闭。用户编号不进证据。看得见的字仍参与关键词。富文本提及仍看 `rich_text_mention`。见 ADR 0514。

清单任务和后加任务上的按标识提及也算。投票选项和手动引用仍不算。见 ADR 0567。

投票说明和描述上的按标识提及也算。见 ADR 0568。

礼物附言上的按标识提及也算。发布者用户名不进证据。见 ADR 0569。

游戏附加文字上的按标识提及也算。封面文件编号不进证据。见 ADR 0570。正文上的按标识提及后来由 ADR 0754 要求起点落在正文里。说明上的按标识提及后来由 ADR 0755 要求起点落在说明里。投票题干上的按标识提及后来由 ADR 0756 要求起点落在题干里。测验说明上的按标识提及后来由 ADR 0757 要求起点落在说明里。投票描述上的按标识提及后来由 ADR 0758 要求起点落在描述里。清单标题上的按标识提及后来由 ADR 0759 要求起点落在标题里。清单任务上的按标识提及后来由 ADR 0760 要求起点落在这条任务里。后加任务上的按标识提及后来由 ADR 0761 要求起点落在这条画出的任务里。礼物附言上的按标识提及后来由 ADR 0762 要求起点落在附言里。

`/rule <chatId> custom_emoji on` 删这个群里的自定义表情。默认关闭。编号不进证据。看得见的字仍参与关键词。按标识提及仍看 `text_mention`。见 ADR 0515。正文上的自定义表情后来由 ADR 0741 必须整段落在正文里。说明上的自定义表情后来由 ADR 0742 必须整段落在说明里。投票题干上的自定义表情后来由 ADR 0743 必须整段落在题干里。投票选项上的自定义表情后来由 ADR 0744 必须整段落在选项里。后加和删掉的选项上的自定义表情后来由 ADR 0745 必须整段落在选项里。测验说明上的自定义表情后来由 ADR 0746 必须整段落在说明里。投票描述上的自定义表情后来由 ADR 0747 必须整段落在描述里。清单标题上的自定义表情后来由 ADR 0748 必须整段落在标题里。清单任务上的自定义表情后来由 ADR 0749 必须整段落在任务里。后加任务上的自定义表情后来由 ADR 0750 必须整段落在前三条里。礼物附言上的自定义表情后来由 ADR 0751 必须整段落在附言里。游戏附加文字上的自定义表情后来由 ADR 0752 必须整段落在附加文字里。手动引用上的自定义表情后来由 ADR 0753 必须整段落在摘录里。

投票描述上的自定义表情也算。编号不进证据。见 ADR 0571。

后加清单任务上的自定义表情也算。完成者名字不进证据。见 ADR 0572。

后加和删掉的投票选项上的自定义表情也算。选项编号不进证据。见 ADR 0573。

手动引用上的自定义表情也算。引用位置不进证据。见 ADR 0574。

`/rule <chatId> copy_text on` 删这个群里复制到剪贴板的按钮。默认关闭。复制句子不进证据。看得见的按钮文字仍参与关键词。自定义表情仍看 `custom_emoji`。见 ADR 0516。

`/rule <chatId> switch_query on` 删这个群里按下后把查询插进输入框的按钮。默认关闭。查询不进证据。看得见的按钮文字仍参与关键词。复制按钮仍看 `copy_text`。见 ADR 0517。

`/rule <chatId> login_forward on` 删这个群里带有转发后替换文字的登录按钮。默认关闭。替换文字不进证据。看得见的按钮文字仍参与关键词。内联查询仍看 `switch_query`。见 ADR 0518。

`/rule <chatId> button_emoji on` 删这个群里带有自定义表情图标的内联按钮。默认关闭。编号不进证据。看得见的按钮文字仍参与关键词。正文里的自定义表情仍看 `custom_emoji`。见 ADR 0519。

`/rule <chatId> sticker_emoji on` 删这个群里的自定义表情贴纸。默认关闭。编号不进证据。普通贴纸仍看 `media_sticker`。正文里的自定义表情仍看 `custom_emoji`。见 ADR 0520。

`/rules <chatId> skip <count>` 跳过前面的 `count` 条再往下列。不写 `skip` 时仍从第一条开始。见 ADR 0521。

`/rules <chatId> on` 只列打开的规则，`off` 只列关闭的规则。不写时仍列出全部。见 ADR 0522。

`/commands skip <count>` 跳过前面的命令再往下列。不写 `skip` 时仍从第一条开始。见 ADR 0523。

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

`pnpm smoke` 成功时打印 `smoke ok`。然后把 bot 拉进群并授予管理员。群里发一条普通消息后，Telegram 会收到 200。命中默认规则时，按上面的 `TELEGRAM_BOT_TOKEN` 说明调用删除、禁言或封禁。

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
