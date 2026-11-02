# Telegram webhook 示例

校验 `X-Telegram-Bot-Api-Secret-Token`，把一条 `message` 更新变成内部 `Event`。

```sh
pnpm --filter @tasb/example-telegram-webhook test
```

密钥不一致时 `events` 为空，状态码 401。密钥正确时，`message` 得到 `kind: "message"`，`chat_member` 得到 `kind: "chat_member"` 且没有 `message`。主体是状态变化的那个用户，不是执行操作的 `from`。`chat_join_request` 得到 `kind: "join_request"`，简介在 `profile` 里，邀请链接和姓名不在事件里。入群服务消息 `new_chat_members` 在没有别的正文时，把看得见的名字放进 `message.text`。发送者姓名和退群的人不在事件里。视频聊天邀请上的名字同样放进正文。通话结束的时长不在事件里。群主变更里的新群主名字同样放进正文。没有下一位时正文是空的。靠近提醒里两个人的名字同样放进正文。距离不在事件里。数学公式里的网址只留下主机名，公式源码不在事件里。没有说明的富文本图片留下媒体类别和文件摘要，文件 id 不在事件里。没有说明的付费图片留下媒体类别和文件摘要，文件 id 不在事件里。只给一个人看见的消息留下临时消息 id 和接收者 id，姓名不在事件里。自定义表情的替代文字在没有别的正文时放进正文。已有正文时只留主机名。表情 id 不在事件里。代码块的语言标签只留下主机名，标签原文不在事件里。普通消息上的代码实体语言标签同样只留下主机名，标签原文不在事件里。Telegram 代理链接里的 server 只留下主机名，secret 和端口不在事件里。分享链接里的 url 只留下主机名，路径不在事件里。私聊预填链接里的 text 只留下主机名，路径和收件人用户名不在事件里。公开用户名和 `t.me/s/用户名` 上的 text 同样只留下主机名。`t.me/用户名/数字` 和 `用户名.t.me` 的 text 同样只留下主机名。讨论串、小程序路径和 Passport 不读。`domain`、`phone`、`server`、`host`、`invite` 和 `slug` 不区分大小写，先出现的值为准。空的 `SERVER` 仍算空。纯数字的 `t.me/+` 是电话链接，不是邀请，`text` 只留下主机名。号码不在事件里。抽奖要加入的频道名字只留下主机名，名字原文不在事件里。其余分享链接写法和 `tg://iv`、私聊预填上的 `url` 只留下主机名，路径和 `rhash` 不在事件里。网页代理链接的 server 只留下主机名，secret 不在事件里。没有 server 时的 host 同样只留下主机名。网页代理上 server 为空时改读 host，只留下主机名。其它代理的空 server 不改读。HTTP 响应只有 `{ "ok": true }`，不含消息原文和昵称。

这个例子不调用 Telegram 的删除接口。Worker 在没有 `DB` / `POLICY_KV` 时用内存端口；配了绑定之后审计走 D1、白名单走 KV。处罚仍然不请求 Telegram。
