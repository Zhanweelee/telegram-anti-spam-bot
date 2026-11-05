import {
  createMemoryReviewQueue,
  createMemoryRuleSubscriptionStore,
  createMemoryStorage,
} from "@tasb/adapter-memory";
import { createMemoryRulePackArchive } from "@tasb/core";
import { describe, expect, it } from "vitest";
import { runPrivateCommand } from "./run.js";

describe("operator command example", () => {
  it("shows help to a configured admin and hides audit text", async () => {
    const phrase = "请免费领取礼品";
    const help = await runPrivateCommand({
      text: `/help ${phrase}`,
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(help).toContain("/logs");
    expect(help).toContain("/blocklist");
    expect(help).toContain("/appeal");
    expect(help).toContain("/evals");
    expect(help).toContain("/packs");
    expect(help).toContain("/quota");
    expect(help).toContain("/delete");
    expect(help).toContain("/deletes");
    expect(help).toContain("/decline");
    expect(help).toContain("/approve");
    expect(help).toContain("/bansender");
    expect(help).toContain("/unbansender");
    expect(help).toContain("/lock");
    expect(help).toContain("/unlock");
    expect(help).toContain("/perms");
    expect(help).toContain("/clearreact");
    expect(help).toContain("/revoke");
    expect(help).toContain("/unpin");
    expect(help).toContain("/admins");
    expect(help).toContain("/untopic");
    expect(help).toContain("/closetopic");
    expect(help).toContain("/opentopic");
    expect(help).toContain("/hidegeneral");
    expect(help).toContain("/showgeneral");
    expect(help).toContain("/deltopic");
    expect(help).toContain("/count");
    expect(help).toContain("/pin");
    expect(help).toContain("/unpinmsg");
    expect(help).toContain("/unreact");
    expect(help).toContain("/delphoto");
    expect(help).toContain("/leave");
    expect(help).toContain("/tag");
    expect(help).toContain("/delstickers");
    expect(help).toContain("/boosts");
    expect(help).toContain("/react <chatId> <messageId> <emoji>");
    expect(help).toContain("/title <chatId> <title>");
    expect(help).toContain("/desc <chatId> [description]");
    expect(help).toContain("/newtopic <chatId> <name>");
    expect(help).toContain("/rentopic <chatId> <threadId> <name>");
    expect(help).toContain("/rengeneral <chatId> <name>");
    expect(help).toContain("/stickers <chatId> <name>");
    expect(help).toContain("/admintitle <chatId> <userId> [title]");
    expect(help).toContain("/declinepost <chatId> <messageId> [comment]");
    expect(help).toContain("/delephemeral <chatId> <userId> <messageId>");
    expect(help).toContain("/myrights [channels] <clear|right...>");
    expect(help).toContain("/botrights [channels]");
    expect(help).toContain("/setcommands [private]");
    expect(help).toContain("/commands [private]");
    expect(help).toContain("/delcommands [private]");
    expect(help).toContain("/menubutton <commands|default>");
    expect(help).toContain("/button");
    expect(help).toContain("/botname [name]");
    expect(help).toContain("/myname");
    expect(help).toContain("/botdesc [description]");
    expect(help).toContain("/mydesc");
    expect(help).toContain("/botshort [short]");
    expect(help).toContain("/myshort");
    expect(help).toContain("\n/who");
    expect(help).toContain("\n/hook");
    expect(help).toContain("\n/guard <chatId>");
    expect(help).toContain("\n/joinbot <chatId>");
    expect(help).toContain("\n/reactions <chatId>");
    expect(help).toContain("\n/community <chatId>");
    expect(help).toContain("\n/canstickers <chatId>");
    expect(help).toContain("\n/parent <chatId>");
    expect(help).toContain("\n/personal <chatId>");
    expect(help).toContain("\n/privacy <chatId>");
    expect(help).toContain("\n/banfor <chatId> <actorId> <seconds>");
    expect(help).toContain("\n/allows <chatId> <actorId>");
    expect(help).toContain("\n/canadmin <chatId> <actorId>");
    expect(help).toContain("\n/kick <chatId> <actorId>");
    expect(help).toContain("\n/cani <chatId>");
    expect(help).toContain("\n/captcha <chatId> <actorId>");
    expect(help).toContain("\n/uncaptcha <chatId> <actorId>");
    expect(help).toContain("\n/warn <chatId> <actorId>");
    expect(help).toContain("\n/unwarn <chatId> <actorId>");
    expect(help).toContain("\n/warns <chatId> [actorId]");
    expect(help).toContain("\n/warnlimit <chatId> [limit|reset]");
    expect(help).toContain("\n/report <chatId> [targetId|reset]");
    expect(help).toContain("\n/flood <chatId> [count [seconds]|reset]");
    expect(help).toContain("\n/keyword <chatId> [add|remove <token>|reset]");
    expect(help).toContain("\n/repeat <chatId> [count [seconds]|reset]");
    expect(help).toContain("\n/rulemute <chatId> [seconds|reset]");
    expect(help).toContain("\n/verifyfor <chatId> [seconds|reset]");
    expect(help).toContain("\n/verifyfail <chatId> [stay|kick|ban|reset]");
    expect(help).toContain("\n/admins <chatId> [skip <count>]");
    expect(help).toContain("\n/chats [chatId|skip <count>]");
    expect(help).toContain(
      "\n/whitelist <chatId> [add|remove <actorId>|skip <count>]",
    );
    expect(help).toContain(
      "\n/allowhost <chatId> [add|remove <host>|reset|skip <count>]",
    );
    const stickers = await runPrivateCommand({
      text: "/delstickers -100",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(stickers).toBe("已请求删除 -100 的群贴纸包。消息还在。");
    const tagged = await runPrivateCommand({
      text: "/tag -100 77 ops",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(tagged).toBe("已请求设置 -100 里 77 的标签。名字还在。");
    expect(tagged).not.toContain("ops");
    const left = await runPrivateCommand({
      text: "/leave -100",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(left).toBe("已请求退出 -100。之后这个 bot 不再处理它。消息还在。");
    const photo = await runPrivateCommand({
      text: "/delphoto -100",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(photo).toBe("已请求删除 -100 的头像。标题和简介还在。");
    const unreacted = await runPrivateCommand({
      text: "/unreact -100 55 77",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(unreacted).toBe(
      "已请求撤下 77 在 -100 消息 55 上的反应。别人的反应还在。其它消息上的反应还在。",
    );
    const unpinnedMessage = await runPrivateCommand({
      text: "/unpinmsg -100 55",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(unpinnedMessage).toBe(
      "已请求撤下 -100 的消息 55 的置顶。消息还在。其它置顶还在。",
    );
    const pinned = await runPrivateCommand({
      text: "/pin -100 55",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(pinned).toBe(
      "已请求置顶 -100 的消息 55。群里可能收到通知。频道和私聊不会。消息还在。其它置顶还在。",
    );
    const deletedTopic = await runPrivateCommand({
      text: "/deltopic -100 55",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(deletedTopic).toBe(
      "已请求删除 -100 话题 55 和里面的消息。其它话题不在这次里",
    );
    const shownGeneral = await runPrivateCommand({
      text: "/showgeneral -100",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(shownGeneral).toBe(
      "已请求显示 -100 的通用话题。原先关着的话仍然关着。消息还在。其它话题不在这次里",
    );
    const hiddenGeneral = await runPrivateCommand({
      text: "/hidegeneral -100",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(hiddenGeneral).toBe(
      "已请求隐藏 -100 的通用话题。原先开着的话会一起关闭。消息还在。其它话题不在这次里",
    );
    const openedGeneral = await runPrivateCommand({
      text: "/opentopic -100",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(openedGeneral).toBe(
      "已请求重新打开 -100 的通用话题。原先隐藏的话会重新显示。消息还在。其它话题不在这次里",
    );
    const closedGeneral = await runPrivateCommand({
      text: "/closetopic -100",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(closedGeneral).toBe(
      "已请求关闭 -100 的通用话题。消息还在。其它话题不在这次里",
    );
    const generalTopic = await runPrivateCommand({
      text: "/untopic -100",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(generalTopic).toBe(
      "已请求撤下 -100 通用话题的全部置顶。消息还在。其它话题不在这次里",
    );
    const unpinned = await runPrivateCommand({
      text: "/unpin -100",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(unpinned).toBe(
      "已请求撤下 -100 的全部置顶。消息还在。话题里的置顶不在这次里",
    );
    const code = "AbCdEfGhIjKlMnOp";
    const revoked = await runPrivateCommand({
      text: `/revoke -100 https://t.me/+${code}`,
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(revoked).toBe(
      "已请求撤销 -100 里机器人自己发的邀请链接。别人发的撤不掉，新的主链接也不在这里",
    );
    expect(revoked).not.toContain(code);
    const reactionReply = await runPrivateCommand({
      text: "/clearreact -100 77",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(reactionReply).toBe(
      "已请求清除 77 在 -100 的最近反应。一万条以前的可能还在",
    );
    const admins = await runPrivateCommand({
      text: "/admins -100",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(admins).toBe("参数无效");
    const members = await runPrivateCommand({
      text: "/count -100",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(members).toBe("参数无效");
    const boosts = await runPrivateCommand({
      text: "/boosts -100 77",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(boosts).toBe("参数无效");
    const botRights = await runPrivateCommand({
      text: "/botrights",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(botRights).toBe("参数无效");
    const listed = await runPrivateCommand({
      text: "/commands",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(listed).toBe("参数无效");
    const buttonState = await runPrivateCommand({
      text: "/button",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(buttonState).toBe("参数无效");
    const currentName = await runPrivateCommand({
      text: "/myname",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(currentName).toBe("参数无效");
    const currentDescription = await runPrivateCommand({
      text: "/mydesc",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(currentDescription).toBe("参数无效");
    const currentShort = await runPrivateCommand({
      text: "/myshort",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(currentShort).toBe("参数无效");
    const currentWho = await runPrivateCommand({
      text: "/who",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(currentWho).toBe("参数无效");
    const currentHook = await runPrivateCommand({
      text: "/hook",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(currentHook).toBe("参数无效");
    const currentGuard = await runPrivateCommand({
      text: "/guard -100",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(currentGuard).toBe("参数无效");
    const currentJoinBot = await runPrivateCommand({
      text: "/joinbot -100",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(currentJoinBot).toBe("参数无效");
    const currentReactions = await runPrivateCommand({
      text: "/reactions -100",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(currentReactions).toBe("参数无效");
    const currentCommunity = await runPrivateCommand({
      text: "/community -100",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(currentCommunity).toBe("参数无效");
    const currentCanStickers = await runPrivateCommand({
      text: "/canstickers -100",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(currentCanStickers).toBe("参数无效");
    const currentParent = await runPrivateCommand({
      text: "/parent -100",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(currentParent).toBe("参数无效");
    const currentPersonal = await runPrivateCommand({
      text: "/personal -100",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(currentPersonal).toBe("参数无效");
    const currentPrivacy = await runPrivateCommand({
      text: "/privacy -100",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(currentPrivacy).toBe("参数无效");
    const topic = await runPrivateCommand({
      text: "/newtopic -100 hello",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(topic).toBe("参数无效");
    expect(topic).not.toContain("hello");
    const renamed = await runPrivateCommand({
      text: "/rentopic -100 55 hello",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(renamed).toBe(
      "已请求修改 -100 里话题 55 的名字。消息还在。其它话题还在。",
    );
    expect(renamed).not.toContain("hello");
    const general = await runPrivateCommand({
      text: "/rengeneral -100 hello",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(general).toBe(
      "已请求修改 -100 的通用话题名字。其它话题还在。消息还在。",
    );
    expect(general).not.toContain("hello");
    const chosen = await runPrivateCommand({
      text: "/stickers -100 Animals_by_SomeBot",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(chosen).toBe("已请求设置 -100 的群贴纸包。消息还在。");
    expect(chosen).not.toContain("Animals_by_SomeBot");
    const adminTitle = await runPrivateCommand({
      text: "/admintitle -100 77 ops",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(adminTitle).toBe("已请求设置 -100 里 77 的管理员头衔。权限还在。");
    expect(adminTitle).not.toContain("ops");
    const declinedPost = await runPrivateCommand({
      text: "/declinepost -100 55 ops",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(declinedPost).toBe(
      "已请求拒绝 -100 的建议帖 55。这条不会发出。其它建议帖还在。",
    );
    expect(declinedPost).not.toContain("ops");
    const ephemeral = await runPrivateCommand({
      text: "/delephemeral -100 77 55",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(ephemeral).toBe(
      "已请求删除 -100 里发给 77 的临时消息 55。对方离线时可能收不到这次删除。其它消息还在。",
    );
    const rights = await runPrivateCommand({
      text: "/myrights manage_chat",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(rights).toBe(
      "已请求设置这个 bot 在群和超级群里的默认管理员权限。加入时仍可修改。已有群不受影响。",
    );
    expect(rights).not.toContain("manage_chat");
    const menu = await runPrivateCommand({
      text: "/setcommands",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(menu).toBe(
      "已请求设置私聊里的命令菜单。群菜单不变。已有单独语言列表的人不受影响。",
    );
    expect(menu).not.toContain("/help");
    const clearedMenu = await runPrivateCommand({
      text: "/delcommands",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(clearedMenu).toBe(
      "已请求清掉私聊里的命令菜单。更高一层的菜单会显示出来。群菜单不变。已有单独语言列表的人不受影响。",
    );
    expect(clearedMenu).not.toContain("/help");
    const menuButton = await runPrivateCommand({
      text: "/menubutton commands",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(menuButton).toBe(
      "已请求把默认菜单按钮设成命令列表。某个私聊里单独设过的按钮不受影响。",
    );
    const botName = await runPrivateCommand({
      text: "/botname hello",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(botName).toBe(
      "已请求设置这个 bot 的名字。已有单独语言名字的人不受影响。",
    );
    expect(botName).not.toContain("hello");
    const botDescription = await runPrivateCommand({
      text: "/botdesc hello",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(botDescription).toBe(
      "已请求设置这个 bot 的简介。已有单独语言简介的人不受影响。",
    );
    expect(botDescription).not.toContain("hello");
    const botShort = await runPrivateCommand({
      text: "/botshort hello",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(botShort).toBe(
      "已请求设置这个 bot 的短简介。已有单独语言短简介的人不受影响。",
    );
    expect(botShort).not.toContain("hello");
    const reacted = await runPrivateCommand({
      text: "/react -100 55 👍",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(reacted).toBe(
      "已请求在 -100 的消息 55 上设置 👍。别人的反应还在。一组媒体里会落到还在的第一条。",
    );
    const titled = await runPrivateCommand({
      text: "/title -100 hello",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(titled).toBe("已请求修改 -100 的标题。简介和头像还在。");
    expect(titled).not.toContain("hello");
    const described = await runPrivateCommand({
      text: "/desc -100 hello",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(described).toBe("已请求修改 -100 的简介。标题和头像还在。");
    expect(described).not.toContain("hello");
    const clearedDescription = await runPrivateCommand({
      text: "/desc -100",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(clearedDescription).toBe("已请求清掉 -100 的简介。标题和头像还在。");
    const perms = await runPrivateCommand({
      text: "/perms -100",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(perms).toBe("参数无效");
    const opened = await runPrivateCommand({
      text: "/unlock -100",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(opened).toBe(
      "已打开 -100 的默认发言权限。这可能比锁定前更宽。单人禁言仍在",
    );
    const locked = await runPrivateCommand({
      text: "/lock -100",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(locked).toBe(
      "已关闭 -100 的默认发言权限。管理员仍可发言。此状态会保持到重新设置权限",
    );
    const lifted = await runPrivateCommand({
      text: "/unbansender -100 -1005",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(lifted).toBe("已解除 -1005 在 -100 的代发禁止");
    const sender = await runPrivateCommand({
      text: "/bansender -100 -1005",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(sender).toBe(
      "已禁止 -1005 在 -100 代发。频道主人的其它频道也会被挡住，直到解除",
    );
    const approved = await runPrivateCommand({
      text: "/approve -100 77",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(approved).toBe("已批准 -100 77");
    const declined = await runPrivateCommand({
      text: "/decline -100 77",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(declined).toBe("已拒绝 -100 77");
    const deleted = await runPrivateCommand({
      text: "/delete -100 88",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(deleted).toBe("已删除 -100 88");
    const deletedMany = await runPrivateCommand({
      text: "/deletes -100 88 89",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(deletedMany).toBe("已请求删除 -100 的 2 条。找不到的会跳过");
    expect(help).toContain("/member");
    const standing = await runPrivateCommand({
      text: "/member -100 77",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(standing).toBe("参数无效");
    expect(help).toContain("/mute");
    const muted = await runPrivateCommand({
      text: "/mute -100 77",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(muted).toBe("已禁言 -100 77 3600 秒");
    expect(help).toContain("/ban");
    const banned = await runPrivateCommand({
      text: "/ban -100 77",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(banned).toBe("已封禁 -100 77");
    expect(help).toContain("/unban");
    const unbanned = await runPrivateCommand({
      text: "/unban -100 77",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(unbanned).toBe("已解除封禁 -100 77");
    expect(help).toContain("/unmute");
    const unmuted = await runPrivateCommand({
      text: "/unmute -100 77",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(unmuted).toBe("已解除禁言 -100 77");
    const quota = await runPrivateCommand({
      text: "/quota -100",
      actorId: "42",
      adminActorIds: ["42"],
      quota: {
        async read() {
          return {
            enabled: true,
            used: 2,
            limit: 1,
            period: "calendar_month",
            degraded: true,
            basicDetectorIds: ["keyword", "join"],
            resetsAt: "2026-12-01T00:00:00.000Z",
          };
        },
      },
    });
    expect(quota).toBe(
      "quota -100 2/1 calendar_month basic until 2026-12-01T00:00:00.000Z\nkeyword,join",
    );
    expect(quota).not.toContain(phrase);
    const rules = await runPrivateCommand({
      text: "/rules -100",
      actorId: "42",
      adminActorIds: ["42"],
      quota: {
        async read() {
          return {
            enabled: true,
            used: 2,
            limit: 1,
            period: "calendar_month",
            degraded: true,
            basicDetectorIds: ["join"],
            resetsAt: "2026-12-01T00:00:00.000Z",
          };
        },
      },
    });
    expect(
      rules?.startsWith("rules -100 until 2026-12-01T00:00:00.000Z\n"),
    ).toBe(true);
    expect(rules).toContain(
      "spam_keywords enabled file threshold 1 actions delete paused",
    );
    expect(rules).not.toContain(phrase);
    const chats = await runPrivateCommand({
      text: "/chats",
      actorId: "42",
      adminActorIds: ["42"],
      chats: {
        async noteBot() {
          return "ok" as const;
        },
        async noteMember() {
          return "ok" as const;
        },
        async chatsFor() {
          return ["-100"];
        },
        async operators() {
          return [];
        },
        async list() {
          return ["-100"];
        },
      },
      quota: {
        async read() {
          return {
            enabled: true,
            used: 2,
            limit: 1,
            period: "calendar_month",
            degraded: true,
          };
        },
      },
    });
    expect(chats).toBe("chats\n-100 2/1");
    expect(chats).not.toContain(phrase);
    expect(help).toContain("/chats");
    expect(help).toContain("/rule");
    expect(help).not.toContain(phrase);
    const english = await runPrivateCommand({
      text: "/help",
      actorId: "42",
      adminActorIds: ["42"],
      locale: "en",
    });
    expect(english?.startsWith("Commands:")).toBe(true);
    expect(english).not.toContain(phrase);

    const storage = createMemoryStorage();
    await storage.appendAudit({
      tenantId: "local",
      chatId: "-100",
      eventId: "evt_1",
      action: "delete",
      score: 1,
      reasons: ["keyword_match"],
      evidence: [{ kind: "keyword", summary: phrase }],
      ruleIds: ["spam_keywords"],
      createdAt: "2026-11-01T00:00:00Z",
    });
    const logs = await runPrivateCommand({
      text: "/logs -100",
      actorId: "42",
      adminActorIds: ["42"],
      storage,
    });
    expect(logs).toContain("evt_1");
    expect(logs).not.toContain(phrase);

    const exported = await runPrivateCommand({
      text: "/export -100",
      actorId: "42",
      adminActorIds: ["42"],
      storage,
    });
    expect(exported).toContain('"audits"');
    expect(exported).not.toContain('"text"');
    const review = createMemoryReviewQueue();
    const appeal = await runPrivateCommand({
      text: "/appeal -100 evt_1 false",
      actorId: "42",
      adminActorIds: ["42"],
      storage,
      review,
    });
    expect(appeal).toBe("appeal -100 evt_1 误判");
    expect(
      JSON.stringify(await review.list({ tenantId: "local" })),
    ).not.toContain(phrase);
    const evals = await runPrivateCommand({
      text: "/evals -100",
      actorId: "42",
      adminActorIds: ["42"],
      storage,
      review,
    });
    expect(evals).toContain('"label":"ham"');
    expect(evals).not.toContain(phrase);
    expect(evals).not.toContain('"text"');
    const forgotten = await runPrivateCommand({
      text: "/forget -100",
      actorId: "42",
      adminActorIds: ["42"],
      storage,
    });
    const packs = createMemoryRuleSubscriptionStore();
    const subscribed = await runPrivateCommand({
      text: "/packs -100 community",
      actorId: "42",
      adminActorIds: ["42"],
      rulePacks: packs,
    });
    expect(subscribed).toBe("packs -100 community");
    expect(await packs.get("local", "-100")).toBe("community");
    const archive = createMemoryRulePackArchive();
    const packSource = {
      async load() {
        return {
          version: 1,
          aggregate: "max",
          rules: [
            {
              id: "community_keywords",
              enabled: true,
              detectorIds: ["keyword"],
              threshold: 2,
              actions: ["delete"],
            },
          ],
        };
      },
    };
    const packed = await runPrivateCommand({
      text: "/rules -100",
      actorId: "42",
      adminActorIds: ["42"],
      rulePacks: packs,
      rulePackSource: packSource,
      rulePackArchive: archive,
    });
    expect(packed?.startsWith("rules -100 community\n")).toBe(true);
    expect(packed).toContain("community_keywords enabled file");
    expect(packed).not.toContain("spam_keywords");
    const cleared = await runPrivateCommand({
      text: "/packs -100 off",
      actorId: "42",
      adminActorIds: ["42"],
      rulePacks: packs,
    });
    expect(cleared).toBe("packs -100 none");
    expect(forgotten).toBe("已删除 1 条");
    expect(await review.list({ tenantId: "local" })).toHaveLength(1);
    expect(
      await storage.listAudits({
        tenantId: "local",
        chatId: "-100",
        limit: 10,
      }),
    ).toEqual([]);
  });
});
