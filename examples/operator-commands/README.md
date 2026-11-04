# 私聊命令

内存适配器跑一条私聊命令。没有 Telegram，也没有 Cloudflare。

`src/run.ts` 的 `runPrivateCommand` 把文本交给 `runOperatorCommand`。配置里的管理员能看到 `/help`、`/rules`、`/quota`、`/chats`、`/unban`、`/unmute`、`/ban`、`/mute`、`/member`、`/delete`、`/deletes`、`/decline`、`/approve`、`/bansender`、`/unbansender`、`/lock`、`/unlock`、`/perms`、`/clearreact`、`/revoke`、`/unpin`、`/admins`、`/untopic`、`/closetopic`、`/opentopic`、`/hidegeneral`、`/showgeneral`、`/deltopic`、`/count`、`/pin`、`/unpinmsg`、`/unreact`、`/delphoto`、`/leave`、`/tag`、`/delstickers`、`/boosts`、`/react`、`/title`、`/desc`、`/newtopic`、`/rentopic`、`/rengeneral`、`/stickers`、`/admintitle`、`/declinepost`、`/delephemeral`、`/myrights`、`/botrights`、`/setcommands`、`/commands`、`/delcommands`、`/menubutton`、`/button`、`/botname`、`/myname`、`/botdesc`、`/mydesc`、`/botshort`、`/myshort`、`/who`、`/hook`、`/guard`、`/joinbot`、`/reactions`、`/community`、`/canstickers`。`/ban`、`/mute`、`/delete`、`/deletes`、`/decline`、`/approve`、`/bansender`、`/unbansender`、`/lock`、`/unlock`、`/clearreact`、`/revoke`、`/unpin`、`/untopic`、`/closetopic`、`/opentopic`、`/hidegeneral`、`/showgeneral`、`/deltopic`、`/pin`、`/unpinmsg`、`/unreact`、`/delphoto`、`/leave`、`/tag`、`/delstickers`、`/react`、`/title`、`/desc`、`/rentopic`、`/rengeneral`、`/stickers`、`/admintitle`、`/declinepost`、`/delephemeral`、`/myrights`、`/setcommands`、`/delcommands`、`/menubutton`、`/botname`、`/botdesc`、`/botshort`、`/unban` 和 `/unmute` 记在内存处罚端口上，不请求 Telegram。`/member`、`/perms`、`/admins`、`/count`、`/boosts`、`/newtopic`、`/botrights`、`/commands`、`/button`、`/myname`、`/mydesc`、`/myshort`、`/who`、`/hook`、`/guard`、`/joinbot`、`/reactions`、`/community` 和 `/canstickers` 在这份内存端口上不知道状态，回复「参数无效」。群聊里的同样文本不会改配置。回复里没有夹在命令参数里的原文。

```sh
pnpm --filter @tasb/example-operator-commands test
```
