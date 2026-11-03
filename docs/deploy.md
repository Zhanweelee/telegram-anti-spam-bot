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

`/rule [chatId] <ruleId> on|off|reset` 只改这一群这一条已有规则的启用状态。没配 `POLICY_KV` 时，开关在 isolate 内存里，最多 256 个群、每个群 32 条，重启后回到文件。配了 `POLICY_KV` 之后，开关和 dry-run 写进那个 KV，每个群一个键，最多 32 条，重启还在。热路径用本 isolate 的 60 秒缓存，不按每条消息读 KV。不新增绑定。见 ADR 0034 和 ADR 0035。

配了 `DB` 之后，入群验证的挑战写在同一份 D1 里。另一个 isolate 收到按钮时仍能对上 nonce。没配 `DB` 时挑战留在 isolate 内存，重启后丢失。Cron 只删除已经到期的行，一次最多 64 条，不提前解除 Telegram 限制。表用 `CREATE TABLE IF NOT EXISTS`，再执行一次迁移只会补上缺的表。不新增绑定。见 ADR 0009 和 ADR 0051。

内联按钮上的 `url`、`login_url` 和 `web_app` 与隐藏链接一样，只把主机名交给 `links`。`copy_text` 里抽出的网址也只留下主机名。内联查询里的网址也只留主机名。见 ADR 0111。没有更前面的正文时，按钮上看得见的字成为正文，几个按钮用一个普通空格分开。已有正文时按钮文字不并进去。路径、查询、`callback_data` 和复制句子不进事件。回复键盘不读。没有 `text` 和 `caption` 时，富文本里看得见的字成为正文，链接和按钮只留主机名。富文本里的动图、视频、音频和文件名也只留主机名。见 ADR 0108。列表项标签里的网址也只留主机名。见 ADR 0109。投票选项、说明和清单任务里的网址也只留主机名，原文不进事件。投票、解释和选项上的媒体链接也只留主机名。见 ADR 0106。这些媒体上的文件名、音频标题、表演者和场馆标题、地址也只留主机名。见 ADR 0107。游戏说明、附加文字和账单说明里的网址也只留主机名。游戏动图的文件名也只留主机名。见 ADR 0110。链接预览指定的网址也只留主机名。场馆地址、场馆标题、游戏标题、账单标题、投票题干、奖品说明、清单标题、文件名、音频标题、表演者、手动引用、按钮文字、礼物附言、论坛话题名、后加的投票选项、清单任务、付费视频文件名、隐藏转发显示名和这条消息自己的作者签名里的网址也只留主机名。成员标签里的网址也只留主机名。见 ADR 0112。拒绝建议帖的说明里的网址也只留主机名。见 ADR 0113。改群名服务消息里的网址也只留主机名，群名本身不进事件。见 ADR 0114。加入或移入社区的服务消息里，社区名字只留主机名，名字本身不进事件。见 ADR 0115。入群服务消息的可见名字在没有更前面的正文时成为正文。已有正文时只留主机名。退群的人、发送者姓名和用户 id 不进事件。见 ADR 0118。视频聊天邀请里的可见名字同样处理。通话结束的时长不进事件。见 ADR 0119。群主变更里的新群主名字同样处理。没有下一位时不读。见 ADR 0120。靠近提醒里两个人的可见名字同样处理。距离不进事件。见 ADR 0121。富文本里的数学公式只留主机名，公式源码不进事件。见 ADR 0122。没有说明的富文本图片、语音、动图、视频、音频和文件按文件摘要参加重复判断。文件 id 不进事件。见 ADR 0123。没有说明的付费图片、视频和实况照片按文件摘要参加重复判断。文件 id 不进事件。见 ADR 0124。只给一个人看见的消息用临时消息 id 删除，删除请求带接收者 id。接收者姓名不进事件。见 ADR 0125。没有别的正文时，自定义表情的替代文字成为正文。已有正文时只留主机名。表情 id 不进事件。见 ADR 0126。代码块的语言标签只留主机名。标签原文不进事件。见 ADR 0127。普通消息、说明和媒体说明上的代码实体语言标签同样只留主机名。标签原文不进事件。见 ADR 0128。Telegram 代理和 socks 链接里的 server 只留主机名。secret、端口、用户名和密码不进证据。见 ADR 0129。分享链接和即时预览里的 url 只留主机名。路径和 rhash 不进证据。见 ADR 0130。私聊预填链接里的 text 只留主机名。路径和收件人用户名不进证据。见 ADR 0131。公开用户名和 `t.me/s/用户名` 上的 text 同样只留主机名。见 ADR 0137。`t.me/用户名/数字` 和 `用户名.t.me` 的 `text` 同样只留主机名。讨论串不读 text。用户名后再加一段应用名时，text 只留主机名。Passport 不读 text。见 ADR 0139。`tg:` 和 `t.me` 查询名 `domain`、`phone`、`server`、`host`、`invite`、`slug` 不区分大小写，先出现的值为准，值本身不改。空的 `SERVER` 仍算空。见 ADR 0140。小写 `t.me/folder/`、`telegram.me/folder/` 和 `telegram.dog/folder/` 记成邀请，邀请码不进事件。见 ADR 0141。`folder.t.me/`、`addlist.t.me/` 和 `joinchat.t.me/` 上的一段邀请码同样记成邀请。见 ADR 0142。`JoinChat` 和 `AddList` 的大小写同样记成邀请。`Folder` 仍只认小写。见 ADR 0143。`t.me/%20`、`telegram.me/%20` 和 `telegram.dog/%20` 同样记成邀请。末尾斜杠、`#` 和子域不记。见 ADR 0144。Passport 的 `callback_url` 只留主机名。`nonce`、公钥和路径不进事件。见 ADR 0145。用户名后的应用名路径同样只留 text 里的主机名。子域上的应用名、讨论串仍不读。见 ADR 0146。小写 `t.me/call/短码` 打开群通话，不读 `text`。见 ADR 0231。查询名正好是 `profile`、值不是 `0` 或 `false` 时打开资料页，不读 `text`。见 ADR 0232。`tg://resolve` 上的非零 `story`、`album` 和 `collection` 不读 `text`。见 ADR 0233。 `t.me/addstyle` 仍读 `text`。后面有短码时打开文风，不读 `text`。见 ADR 0234。`t.me/invoice` 仍读 `text`。后面是账单短码时打开付款，不读 `text`。带点的第二段仍读。见 ADR 0235。`t.me/addemoji` 仍读 `text`。后面是表情包短名时打开表情包，不读 `text`。连字符、末尾斜杠和大小写不同的命令仍读。见 ADR 0236。`t.me/addstickers` 仍读 `text`。后面是贴纸包短名时打开贴纸包，不读 `text`。连字符、末尾斜杠和大小写不同的命令仍读。见 ADR 0237。`t.me/addtheme` 仍读 `text`。后面是主题短名时打开主题，不读 `text`。连字符、末尾斜杠和大小写不同的命令仍读。见 ADR 0238。`t.me/setlanguage` 仍读 `text`。后面是语言包短名时打开语言包，不读 `text`。末尾斜杠和大小写不同的命令仍读。见 ADR 0239。`t.me/nft` 仍读 `text`。后面是礼物短名时打开礼物，不读 `text`。末尾斜杠和大小写不同的命令仍读。见 ADR 0240。`t.me/auction` 仍读 `text`。后面是拍卖短名时打开拍卖，不读 `text`。末尾斜杠和大小写不同的命令仍读。见 ADR 0241。`t.me/bg` 仍读 `text`。后面是壁纸短名时打开壁纸，不读 `text`。末尾斜杠和大小写不同的命令仍读。见 ADR 0242。`t.me/contact` 仍读 `text`。后面是联系人令牌时打开联系人，不读 `text`。大小写不同的命令仍读。见 ADR 0243。`t.me/login` 仍读 `text`。登录码路径在桌面端仍写草稿，所以也读。见 ADR 0244。`t.me/newbot` 仍读 `text`。后面是管理员用户名时打开创建机器人，不读 `text`。连字符仍读。见 ADR 0245。 `t.me/stargift_preview` 仍读 `text`。礼物预览路径在桌面端仍写草稿，所以也读。见 ADR 0246。 `t.me/stargift_auction` 仍读 `text`。礼物拍卖路径在桌面端仍写草稿，所以也读。见 ADR 0247。 `t.me/boost` 仍读 `text`。后面是频道用户名时打开助推，不读 `text`。连字符仍读。见 ADR 0248。 `t.me/web` 仍读 `text`。应用名和数字路径两边都写草稿，所以也读。见 ADR 0249。 `t.me/msg` 仍读 `text`。应用名和数字路径在桌面端仍写草稿，所以也读。见 ADR 0250。 `t.me/share` 仍读 `text`。应用名和数字路径在桌面端仍写草稿，所以也读。见 ADR 0251。 `t.me/folder` 仍读 `text`。带点的短名和大写命令在桌面端仍写草稿，所以也读。邀请码路径仍不读 `text`。见 ADR 0252。 `t.me/addlist` 仍读 `text`。末尾斜杠和大写命令在一边仍写草稿，所以也读。小写短名仍不读 `text`。见 ADR 0253。 `t.me/joinchat` 仍读 `text`。末尾斜杠和大写命令在一边仍写草稿，所以也读。小写短名仍不读 `text`。见 ADR 0254。`t.me/m` 仍读 `text`。末尾斜杠和大写命令在一边仍写草稿，所以也读。小写短码仍不读 `text`。见 ADR 0255。`t.me/c` 仍读 `text`。末尾斜杠和大写命令在一边仍写草稿，所以也读。小写数字路径仍不读 `text`。见 ADR 0256。`t.me/iv` 仍读 `text`。应用名和数字路径两边都写草稿，所以也读。见 ADR 0257。`t.me/confirmphone/短名` 仍读 `text`。大写命令也读。没有短名时仍不读 `text`。见 ADR 0258。`t.me/proxy/短名` 仍读 `text`。没有短名时 Android 仍写草稿，所以也读。`server` 仍只在代理命令上读。见 ADR 0259。`t.me/socks/短名` 仍读 `text`。没有短名时 Android 仍写草稿，所以也读。`server` 仍只在 socks 命令上读。见 ADR 0260。`t.me/webproxy/短名` 仍读 `text`。没有短名时 Android 仍写草稿，所以也读。`server` 仍只在网页代理命令上读。见 ADR 0261。`t.me/S` 仍读 `text`。小写 `s` 没有下一段时仍不读。见 ADR 0262。查询里的 `+` 在 `text`、分享 `url` 和 `callback_url` 里是空格。`%2B` 仍是加号。正文路径里的加号仍粘住后面的网址。见 ADR 0263。查询里非法的 UTF-8 百分号仍留下主机名。不完整的 `%` 仍留在原处。见 ADR 0264。分享、私聊预填和 Passport 回调超过 2048 时仍留下主机名。16384 之后的字不再读。直接打开的长链接仍按 2048 丢掉。见 ADR 0265。分享和私聊预填的 `text` 同样截到 16384。用户名草稿的 `text` 仍停在 4096。见 ADR 0266。隐藏草稿在 `|` 和替换字符处停住，后面的短链仍留下。`%2http://bit.ly` 仍不拆开。见 ADR 0267。隐藏草稿在表情处停住，后面的短链仍留下。路径里留住的增补字符不拆开。见 ADR 0268。隐藏草稿里的裸 IP 仍留下主机名。第一段是 `0` 的地址和路径里的地址不另算。见 ADR 0269。更长的应用名、帖子数字和 Passport 路径段同样只留主机名。见 ADR 0147。`tg://resolve?domain=s&appname=` 同样只留 text 里的主机名。`domain` 必须正好是小写 `s`。见 ADR 0148。`s.t.me/用户名`、`share.t.me/url` 和 `msg.t.me/url` 同样只留主机名。见 ADR 0149。去掉预览 `s` 之后的一段同样只留主机名。见 ADR 0150。纯数字的 `t.me/+`、`telegram.me/+` 和 `telegram.dog/+` 是电话链接，不是邀请，`text` 只留主机名。带字母的加号路径仍是邀请。号码不进证据。见 ADR 0138。抽奖要加入的频道名字只留主机名。频道 id、用户名和中奖者姓名不进事件。见 ADR 0132。官方分享链接的另外几种写法，以及 `tg://iv` 和私聊预填上的 `url`，同样只留主机名。用户名上的 `url`、其它路径和 `rhash` 不读。见 ADR 0133。网页代理链接的 server 只留主机名。secret 和路径不进证据。见 ADR 0134。代理链接没有 server 时，host 同样只留主机名。名叫 proxy 的参数不读。见 ADR 0135。网页代理上 server 为空时改读 host，只留主机名。其它代理的空 server 不改读。见 ADR 0136。没有更前面的正文时，表演者、礼物附言、论坛话题名、后加的投票选项、清单任务、付费视频文件名、隐藏转发显示名、作者签名、成员标签、拒绝说明、入群服务消息、视频聊天邀请、群主变更和靠近提醒里的名字成为正文。贴纸、星星数量、藏品名字、成交币种、话题图标、自定义表情、原消息、选项 id、完成者名字、付费媒体的文件 id、实况照片、频道标题、真实用户姓名和转发来源上的作者签名不进事件。见 ADR 0029、ADR 0053、ADR 0055、ADR 0063、ADR 0074、ADR 0075、ADR 0076、ADR 0077、ADR 0078、ADR 0079、ADR 0080、ADR 0081、ADR 0082、ADR 0083、ADR 0084、ADR 0085、ADR 0086、ADR 0087、ADR 0088、ADR 0089、ADR 0090、ADR 0091、ADR 0092 和 ADR 0101。

正文里的短链和邀请在比较前会去掉零宽字符、非常规空白、换行和变体选择符，并把点状间隔号收成 ASCII 点，全角拉丁字母收成半角，七个西里尔字母和乌克兰语 `і` 收成拉丁字母，再去掉夹在标签里的西里尔、希腊、亚美尼亚文和非 ASCII 拉丁字母。普通空格仍把主机名拆开。句号 `。`、全角数字、全角加号、汉字、谚文和假名保留。`т` 不映成 `t`。一层百分号编码的间隔号先收成对应字符。第二层和句号 `。` 的编码保留。证据仍只留主机名。见 ADR 0065、ADR 0093、ADR 0094、ADR 0095、ADR 0096、ADR 0097、ADR 0098、ADR 0099 和 ADR 0100。制表符、换行和不换行空格仍从粘连扫描里去掉。Android 在这些间隔前停住的主机名另外留下。见 ADR 0163。百分号编码的点、字母和方括号包住的点如果让 Android 停在短链前面，这个主机名也留下。见 ADR 0164。Android 标签类没有收录的增补字母如果让高亮停在短链前面，这个主机名也留下。见 ADR 0165。`@` 后面接不上用户信息时，Android 打开的主机名也留下。见 ADR 0166。路径放不下的字符后面，Android 另外打开的主机名也留下。见 ADR 0167。没写完的百分号后面，Android 另外打开的主机名也留下。见 ADR 0168。路径类没有的字符后面，Android 另外打开的主机名也留下。见 ADR 0169。主机名后面、路径还没开始时的标点，Android 另外打开的主机名也留下。见 ADR 0170。裸域名和 `www.` 在最后一个标签处结束，后面 Android 另外打开的主机名也留下。见 ADR 0171。带协议的主机名里，点号后面接不上标签时，Android 另外打开的主机名也留下。见 ADR 0172。用户信息超过 64 个字符，或密码超过 25 个字符时，Android 另外打开的主机名也留下。见 ADR 0173。标签超过 63 个字符，或连字符让标签放不下时，Android 另外打开的主机名也留下。见 ADR 0174。没有协议而 Android 会打开的点分 IPv4 也留下。见 ADR 0175。没有两个斜杠的 `tg:` 不盖住后面 Android 打开的主机名。见 ADR 0176。裸域名和裸 IP 的问号、端口和以斜杠开头的路径仍属于这一段。点号后面另起的网址仍单独打开。见 ADR 0177。路径或问号开始后的单引号仍属于这一段。路径还没开始时的单引号和双引号后面的网址仍单独打开。见 ADR 0178。U+1680、U+205F 和 U+FEFF 留在带协议的标签、路径和问号里。裸域名、`www.` 和不换行空格后面的网址仍单独打开。见 ADR 0179。Android 留在标签上的字符仍属于这一段主机名。除号后面没有单词边界时，前面的主机名仍单独打开。见 ADR 0180。没有协议的 `www.` 在点号处结束，后面的网址仍单独打开。带协议的点号仍留在这一段。见 ADR 0181。不是 Android 严格顶级域的后缀，后面的网址仍单独打开。见 ADR 0182。下划线夹在没有协议的标签中间时仍属于这一段。下划线开头或结尾时，后面的网址仍单独打开。见 ADR 0183。连字符或下划线把不同字母接在同一个裸标签里时，这一段仍留着。见 ADR 0184。没有协议的主机名在希腊字母、西里尔字母、亚美尼亚文或非 ASCII 拉丁字母前结束，后面的网址仍单独打开。见 ADR 0185。ASCII 点后面的点状字符仍留在标签里，后面的网址不再另开。见 ADR 0186。`@` 后面的标签字符仍留在这一段，后面的网址不再另开。见 ADR 0187。点状字符紧挨在 `@` 前面时仍保留，后面的网址单独打开。见 ADR 0188。只用点状字符当点、又没有协议的主机名不再盖住后面的网址。见 ADR 0189。西里尔形近字母或全角字母紧挨在网址前面时仍保留，后面的网址单独打开。见 ADR 0190。非间距组合附加符号紧挨在裸主机名和网址之间时，不再单独打开后面的短链。斜杠后面的网址仍会打开。见 ADR 0191。紧挨在网址前面的 `%2E` 不再收成点，换行或斜杠隔开时后面的网址仍会打开。见 ADR 0192。紧挨在网址前面的 `%2B` 不再收成加号，换行或斜杠隔开时后面的网址仍会打开。`t.me/%2B…` 仍记成邀请。见 ADR 0193。紧挨在网址前面的 `%2D` 和 `%252D` 不再收成连字符，换行或斜杠隔开时后面的网址仍会打开。`bit%2Dly` 仍留下。见 ADR 0194。用百分号编码的字母拼出的 `http://` 或 `https://` 不再收成协议。真正的协议和 `b%69t.ly` 仍会打开。见 ADR 0195。百分号编码的斜杠不再拼出 `http://` 或 `https://`。`t.me%2F+…` 和字面斜杠后面的网址仍会打开。见 ADR 0196。百分号编码的加号紧挨着裸主机名时不再收成加号。换行、空格或斜杠后面的网址仍会打开。见 ADR 0197。百分号编码的斜杠紧挨着裸主机名时不再收成斜杠。换行、空格或字面斜杠后面的网址仍会打开。见 ADR 0198。百分号编码的连字符紧挨着裸主机名时不再收成连字符。换行、空格或斜杠后面的网址仍会打开。见 ADR 0199。百分号编码的加号、斜杠或连字符紧挨着带百分号的主机名时，不再把这段收成短链或裸 IP。单独的 `b%69t.ly` 和 `bit%2Ely` 仍会打开。见 ADR 0200。百分号编码的间隔贴在主机名或协议前面时不再删掉。标签中间的编码和换行后面的网址仍会打开。见 ADR 0201。百分号编码的点状间隔号贴在已经写完的主机名或协议前面时不再收成点。当作标签之间的点用时仍会打开。见 ADR 0202。百分号编码的 ASCII 点贴在已经写完的主机名前面时，收成 Android 留下的两位十六进制。`bit%2Ely` 和换行后面的网址仍会打开。见 ADR 0203。百分号编码的括号点贴在已经写完的主机名前面时，收成闭合括号的两位十六进制。`bit%5B.%5Dly` 和字面括号仍会打开。见 ADR 0204。汉字、谚文、假名和其它 Android 留在标签里的字，夹在 ASCII 字母或数字中间时收成 `x`。`点击bit.ly`、句号 `。` 和后面的 `http://` 仍会打开。见 ADR 0205。IDNA 映射恰好是一个 ASCII 字母的字收成这个字母。`ℹbit.ly` 留着，后面的 `http://` 仍会打开。见 ADR 0206。字素连接符 U+034F 夹在 ASCII 字母和点号之间时从主机名里去掉。裸的 `bit.͏ly` 仍不打开。见 ADR 0207。带协议的主机名遇到多字节百分号编码就停下。`http://b%E2%85%A0t.ly` 留着。`http://b%69t.ly` 仍按短链删除。见 ADR 0208。亚美尼亚文、西里尔文、希腊文和拉丁文里的标点留在主机名里。`b՚it.ly` 留着。`bաit.ly` 和后面的 `http://` 仍会打开。见 ADR 0209。主机名里的除号和分数斜杠留下。`http://∕bit.ly` 留着。`http://bit.ly∕@example.com` 和没有协议的 `∕bit.ly` 仍按短链删除。见 ADR 0210。`://` 后面直接是问号时，问号里的地址留在这一条里。`http://?bit.ly` 留着。`http:///bit.ly` 仍按短链删除。见 ADR 0211。没有主机名的一到五位端口留在这一条里。`http://:80/bit.ly` 留着。六位端口后面的短链仍删除。见 ADR 0212。带协议的主机名里，路径、问号、下一个标签或写完的端口前的汉字留在这一条里。`http://bit.ly一` 留着。`@` 前面的短链仍删除。见 ADR 0213。增补平面的标签字同样留在这一条里。`http://bit.ly𠀀` 留着。第一平面的字后面的短链仍删除。见 ADR 0214。没有协议的主机名已经写完时，后面的单字母映射不再粘上去。`bit.lyª/…` 按短链删除。`bit.lyªevil.com/…` 留着。见 ADR 0215。写完的主机名和后面的域名之间的句号 `。` 收成一个点。`bit.ly。evil.com/…` 留着。`example.com。bit.ly/…` 仍按短链删除。见 ADR 0216。点状间隔号也收成一个点。`bit.ly·evil.com/…` 留着。`bit.ly·evil·com/…` 仍按短链删除。见 ADR 0217。裸 IP 前面的单字母不再粘上去。`ª203.0.113.10/…` 按裸 IP 删除。`http://ª203.0.113.10/…` 留着。见 ADR 0218。写完的主机名后面接不上严格域名时，标签字不再收成 x。见 ADR 0219。写完的主机名和后面的严格域名之间的标签字收成 x。见 ADR 0220。点号后面的标签可以是 Android 标签字，这段仍收成 x。见 ADR 0221。句号和点状间隔号后面的域名也可以含 Android 标签字。见 ADR 0222。带协议的点状间隔号留在标签里。见 ADR 0223。带协议的主机名里，希腊文、西里尔文、亚美尼亚文和非 ASCII 拉丁字母留在标签里。见 ADR 0224。点号后面的希腊文、西里尔文、亚美尼亚文和非 ASCII 拉丁字母留在带协议的主机名里。见 ADR 0225。句号、全角句点和半角句点后面的希腊文、西里尔文、亚美尼亚文和非 ASCII 拉丁字母留在带协议的主机名里。见 ADR 0226。地址解析会忽略、Android 仍算进标签的标记后面，希腊文、西里尔文、亚美尼亚文和非 ASCII 拉丁字母留在带协议的主机名里。见 ADR 0227。这种标记写在带协议主机名的任何位置时，后面的希腊文、西里尔文、亚美尼亚文和非 ASCII 拉丁字母也留下。见 ADR 0228。非间距标记写在带协议主机名的标签末尾，后面还能接上点、路径、查询或端口时，这个标记留在标签里，后面的希腊文、西里尔文、亚美尼亚文和非 ASCII 拉丁字母也留下。见 ADR 0229。带协议的主机名以连字符结束时，后面的希腊文、西里尔文、亚美尼亚文和非 ASCII 拉丁字母也留下。见 ADR 0230。方括号、圆括号和花括号包住的点也收成 ASCII 点。一层百分号编码的同一对也收成点。第二层和括号里的空格保留。见 ADR 0103 和 ADR 0104。已有正文时，按钮文字、文件名、作者签名和其它旁路纯文本走和正文相同的主机折叠。带协议的地址仍按原来的顺序解析。见 ADR 0105。

按钮 `url`、隐藏的 `text_link`，以及从 `copy_text` 抽出的网址，在解析前做同样的折叠。邀请码里的零宽字符仍只留下主机名。普通空格仍让这条地址无效。见 ADR 0066 和 ADR 0075。`tg://join?invite=` 和 `tg://addlist?slug=` 记成 `t.me` 邀请。`tg://resolve` 仍保留。邀请码不进事件。见 ADR 0102。

百分号编码的零宽字符、变体选择符和不间断空格会去掉两层。`%20` 仍让地址无效。`%252E` 和第三层编码仍留下。见 ADR 0067 和 ADR 0068。

没有协议的 `%2E` 在链接比较前收成点。`bit%252Ely` 和 `example%2Ecom` 仍保留。见 ADR 0069。

`%2F` 在链接比较和按钮地址解析前收成斜线。`t.me%2Fdurov` 和 `%252F` 仍保留。见 ADR 0070。

`%2B` 在链接比较和按钮地址解析前收成加号。`t.me/%2B…` 记成邀请。`t.me/durov`、`example.com/%2Bdocs` 和 `%252B` 仍保留。见 ADR 0071。

字母、数字、连字符和下划线的一层 `%HH` 在链接比较和按钮地址解析前收成字符。`b%69t.ly` 记成短链，`t.me/+OFF%45…` 记成邀请。`example%41.com`、`bit%2Dly` 和 `%2545` 仍保留。见 ADR 0072。

`%25HH` 再收一层，并且只收字母表里的字节。`b%2569t.ly` 记成短链，`t.me/+OFF%2545…` 记成邀请。`%252E` 和 `%252545` 仍保留。见 ADR 0073。

没有 `text` 和 `caption` 的投票、抽奖、清单、游戏、账单、场馆、文件、按钮和手动引用，用题干、奖品说明、标题、文件名、音频标题、按钮文字或引用文字当正文。自动引用和被回复的原消息不进事件。选项、任务文字、说明、附加文字、启动参数、封面文件 id、地址、坐标、贴纸包名和文件 id 不进事件。没有文件名和音频标题时，表演者整段成为正文。见 ADR 0092。纯位置消息没有名称。题干、清单标题和成为正文的手动引用上的 `text_link` 只留主机名。见 ADR 0056、ADR 0057、ADR 0058、ADR 0059、ADR 0061、ADR 0062 和 ADR 0063。

没有可当正文的名称时，贴纸、图片、视频笔记和语音仍参加同一条重复规则。事件里只有类别和文件摘要，没有文件 id 或贴纸包标题。文件名或音频标题成为正文之后，重复改按这段正文计次。空正文且没有文件摘要时不参加重复。见 ADR 0052 和 ADR 0062。

洪泛和重复默认在 isolate 内存里计数。要跨 isolate 累加时，在自己的 `wrangler.jsonc` 里加 Durable Object，绑定名是 `RATE_WINDOW`，类名是 `RateWindowObject`，迁移用 `new_sqlite_classes`。提交的配置不加这个绑定。对象调用失败时这条检测放过。Webhook 预算仍在内存。见 ADR 0010 和 ADR 0050。

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

`TELEGRAM_BOT_TOKEN` 用于私聊回复，以及 delete、mute、ban 和入群限制。没有它，Webhook 仍然返回 200。处罚只记在这台 isolate 的内存里，bot 不会去删消息、禁言或封禁。见 ADR 0020。

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

把 URL 换成部署输出里的地址。`allowed_updates` 要带上 `edited_message`、`chat_member`、`chat_join_request`、`callback_query` 和 `my_chat_member`，否则编辑后的垃圾消息、入群更新、入群申请、验证按钮，以及 bot 被设为管理员的事件不会送到 bot。已经设过 webhook 的部署要重设一次。见 ADR 0027。接入目录在没配 `POLICY_KV` 时留在内存里，重启后 `/chats` 要等下一次管理员变更。配了 `POLICY_KV` 之后，目录和白名单、规则开关在同一份 KV 里，每个租户一个键，最多 256 个群、每群 32 个用户 id，不含群名。见 ADR 0036。额度打开时，`/chats` 每一行带上已用次数和上限，查看不计数。见 ADR 0045。验证状态在 isolate 内存里，重启后未完成的验证会消失；限制的 `until_date` 仍会到期。同一群 10 秒内超过 30 条更新时，bot 返回 200 并且不再检测，避免 Telegram 重试。见 ADR 0024。频道转发默认会被删除。转载群把规则 `channel_forward` 的 `enabled` 改成 false，或在 `chats.json` 里整份换掉规则。见 ADR 0025。

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
