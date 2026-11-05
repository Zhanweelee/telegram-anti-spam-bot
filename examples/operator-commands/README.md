# 私聊命令

内存适配器跑一条私聊命令。没有 Telegram，也没有 Cloudflare。

`src/run.ts` 的 `runPrivateCommand` 把文本交给 `runOperatorCommand`。配置里的管理员能看到 `/help`、`/rules`、`/quota`、`/chats`、`/unban`、`/unmute`、`/ban`、`/mute`、`/member`、`/delete`、`/deletes`、`/decline`、`/approve`、`/bansender`、`/unbansender`、`/lock`、`/unlock`、`/perms`、`/clearreact`、`/revoke`、`/unpin`、`/admins`、`/untopic`、`/closetopic`、`/opentopic`、`/hidegeneral`、`/showgeneral`、`/deltopic`、`/count`、`/pin`、`/unpinmsg`、`/unreact`、`/delphoto`、`/leave`、`/tag`、`/delstickers`、`/boosts`、`/react`、`/title`、`/desc`、`/newtopic`、`/rentopic`、`/rengeneral`、`/stickers`、`/admintitle`、`/declinepost`、`/delephemeral`、`/myrights`、`/botrights`、`/setcommands`、`/commands`、`/delcommands`、`/menubutton`、`/button`、`/botname`、`/myname`、`/botdesc`、`/mydesc`、`/botshort`、`/myshort`、`/who`、`/hook`、`/guard`、`/joinbot`、`/reactions`、`/community`、`/canstickers`、`/parent`、`/personal`、`/privacy`、`/banfor`、`/allows`、`/canadmin`、`/kick`、`/cani`。`/ban`、`/banfor`、`/mute`、`/delete`、`/deletes`、`/decline`、`/approve`、`/bansender`、`/unbansender`、`/lock`、`/unlock`、`/clearreact`、`/revoke`、`/unpin`、`/untopic`、`/closetopic`、`/opentopic`、`/hidegeneral`、`/showgeneral`、`/deltopic`、`/pin`、`/unpinmsg`、`/unreact`、`/delphoto`、`/leave`、`/tag`、`/delstickers`、`/react`、`/title`、`/desc`、`/rentopic`、`/rengeneral`、`/stickers`、`/admintitle`、`/declinepost`、`/delephemeral`、`/myrights`、`/setcommands`、`/delcommands`、`/menubutton`、`/botname`、`/botdesc`、`/botshort`、`/unban`、`/kick` 和 `/unmute` 记在内存处罚端口上，不请求 Telegram。`/member`、`/perms`、`/admins`、`/count`、`/boosts`、`/newtopic`、`/botrights`、`/commands`、`/button`、`/myname`、`/mydesc`、`/myshort`、`/who`、`/hook`、`/guard`、`/joinbot`、`/reactions`、`/community`、`/canstickers`、`/parent`、`/personal`、`/privacy`、`/allows`、`/canadmin` 和 `/cani` 在这份内存端口上不知道状态，回复「参数无效」。群聊里的同样文本不会改配置。回复里没有夹在命令参数里的原文。

`/rules -100 skip 64` 跳过前面的 64 条再往下列。不写 `skip` 时仍从第一条开始。

`/rules -100 on` 只列打开的规则。`off` 只列关闭的规则。不写时仍列出全部。

`/commands skip 93` 跳过前面的 93 条再往下列。不写 `skip` 时仍从第一条开始。

`/allowhost -100 skip 31` 只列出最后一台放行主机。不写 `skip` 时仍从第一台开始。

`/chats skip 166` 跳过前面的 166 个群再往下列。不写 `skip` 时仍从第一个群开始。

`/whitelist -100 skip 164` 从第 165 个豁免号继续列。不写 `skip` 时仍从第一个开始。

`/admins -100 skip 248` 跳过前面的 248 个管理员再往下列。不写 `skip` 时仍从第一个人开始。

`/chats -100` 列出这个群记下的人。没有人时下一行是 `none`。不写群号时仍列出群。

```sh
pnpm --filter @tasb/example-operator-commands test
```
