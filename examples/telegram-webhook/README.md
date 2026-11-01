# Telegram webhook 示例

校验 `X-Telegram-Bot-Api-Secret-Token`，把一条 `message` 更新变成内部 `Event`。

```sh
pnpm --filter @tasb/example-telegram-webhook test
```

密钥不一致时 `events` 为空，状态码 401。密钥正确时，`message` 得到 `kind: "message"`，`chat_member` 得到 `kind: "chat_member"` 且没有 `message`。主体是状态变化的那个用户，不是执行操作的 `from`。`chat_join_request` 得到 `kind: "join_request"`，简介在 `profile` 里，邀请链接和姓名不在事件里。入群服务消息 `new_chat_members` 在没有别的正文时，把看得见的名字放进 `message.text`。发送者姓名和退群的人不在事件里。视频聊天邀请上的名字同样放进正文。通话结束的时长不在事件里。群主变更里的新群主名字同样放进正文。没有下一位时正文是空的。靠近提醒里两个人的名字同样放进正文。距离不在事件里。数学公式里的网址只留下主机名，公式源码不在事件里。HTTP 响应只有 `{ "ok": true }`，不含消息原文和昵称。

这个例子不调用 Telegram 的删除接口。Worker 在没有 `DB` / `POLICY_KV` 时用内存端口；配了绑定之后审计走 D1、白名单走 KV。处罚仍然不请求 Telegram。
