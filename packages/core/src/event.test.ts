import { describe, expect, it } from "vitest";
import { parseEvent } from "./event.js";

describe("event schema", () => {
  it("rejects an uppercase digest", () => {
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: { id: "msg_1", text: "hi", textSha256: "A".repeat(64) },
      }),
    ).toThrow();
  });

  it("keeps a scheduled mark and rejects other values", () => {
    const event = parseEvent({
      id: "evt_1",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
      message: {
        id: "msg_1",
        text: "hi",
        textSha256: "ab".repeat(32),
        offline: true,
      },
    });
    expect(event.message?.offline).toBe(true);
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "hi",
          textSha256: "ab".repeat(32),
          offline: "请免费领取礼品" as unknown as true,
        },
      }),
    ).toThrow();
  });

  it("keeps a numeric album id and rejects other ids", () => {
    const albumId = "12532140322504850";
    const event = parseEvent({
      id: "evt_1",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
      message: {
        id: "msg_1",
        text: "hi",
        textSha256: "ab".repeat(32),
        albumId,
      },
    });
    expect(event.message?.albumId).toBe(albumId);
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "hi",
          textSha256: "ab".repeat(32),
          albumId: "请免费领取礼品",
        },
      }),
    ).toThrow();
  });

  it("keeps an edited flag and rejects false", () => {
    const event = parseEvent({
      id: "evt_1",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
      edited: true,
      message: { id: "msg_1", text: "hi", textSha256: "ab".repeat(32) },
    });
    expect(event.edited).toBe(true);
    expect(event.message?.forward).toBeUndefined();
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        edited: false,
        message: { id: "msg_1", text: "hi", textSha256: "ab".repeat(32) },
      }),
    ).toThrow();
  });

  it("accepts a forward class and rejects anything else", () => {
    const event = parseEvent({
      id: "evt_1",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
      message: {
        id: "msg_1",
        text: "hi",
        textSha256: "ab".repeat(32),
        forward: "channel",
      },
    });
    expect(event.message?.forward).toBe("channel");
    expect(event.message?.hosts).toBeUndefined();
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "hi",
          textSha256: "ab".repeat(32),
          forward: "bot",
        },
      }),
    ).toThrow();
  });

  it("accepts hidden hostnames and rejects paths or odd names", () => {
    const event = parseEvent({
      id: "evt_1",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
      message: {
        id: "msg_1",
        text: "点这里",
        textSha256: "ab".repeat(32),
        hosts: ["bit.ly", "203.0.113.9"],
      },
    });
    expect(event.message?.hosts).toEqual(["bit.ly", "203.0.113.9"]);
    expect(event.message?.invites).toBeUndefined();
    const bad = [
      "BIT.LY",
      "a..b",
      ".bit.ly",
      "bit.ly.",
      "bit.ly/x",
      "",
      "a".repeat(254),
    ];
    for (const host of bad) {
      expect(() =>
        parseEvent({
          id: "evt_1",
          tenantId: "tenant_1",
          chatId: "chat_1",
          kind: "message",
          occurredAt: "2026-11-01T00:00:00Z",
          actor: { id: "user_1", isAdmin: false },
          message: {
            id: "msg_1",
            text: "点这里",
            textSha256: "ab".repeat(32),
            hosts: [host],
          },
        }),
      ).toThrow();
    }
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "点这里",
          textSha256: "ab".repeat(32),
          hosts: [],
        },
      }),
    ).toThrow();
  });

  it("accepts invite hostnames and rejects a code stuffed into the list", () => {
    const event = parseEvent({
      id: "evt_1",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
      message: {
        id: "msg_1",
        text: "点这里",
        textSha256: "ab".repeat(32),
        invites: ["t.me"],
      },
    });
    expect(event.message?.invites).toEqual(["t.me"]);
    expect(event.actor.bot).toBeUndefined();
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "点这里",
          textSha256: "ab".repeat(32),
          invites: ["t.me/+INVITESECRET99"],
        },
      }),
    ).toThrow();
  });

  it("accepts a joining bot flag and rejects false", () => {
    const event = parseEvent({
      id: "evt_1",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "chat_member",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false, bot: true },
    });
    expect(event.actor.bot).toBe(true);
    expect(event.message?.contact).toBeUndefined();
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "chat_member",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false, bot: false },
      }),
    ).toThrow();
  });

  it("accepts a foreign-channel flag and rejects false", () => {
    const event = parseEvent({
      id: "evt_1",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
      message: {
        id: "msg_1",
        text: "",
        textSha256: "ab".repeat(32),
        asChannel: true,
      },
    });
    expect(event.message?.asChannel).toBe(true);
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "",
          textSha256: "ab".repeat(32),
          asChannel: false,
        },
      }),
    ).toThrow();
  });

  it("accepts a shared-story flag and rejects false", () => {
    const event = parseEvent({
      id: "evt_1",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
      message: {
        id: "msg_1",
        text: "",
        textSha256: "ab".repeat(32),
        asStory: true,
      },
    });
    expect(event.message?.asStory).toBe(true);
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "",
          textSha256: "ab".repeat(32),
          asStory: false,
        },
      }),
    ).toThrow();
  });

  it("accepts a bare-location flag and rejects false", () => {
    const event = parseEvent({
      id: "evt_1",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
      message: {
        id: "msg_1",
        text: "",
        textSha256: "ab".repeat(32),
        asLocation: true,
      },
    });
    expect(event.message?.asLocation).toBe(true);
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "",
          textSha256: "ab".repeat(32),
          asLocation: false,
        },
      }),
    ).toThrow();
  });

  it("accepts a giveaway-card flag and rejects false", () => {
    const event = parseEvent({
      id: "evt_1",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
      message: {
        id: "msg_1",
        text: "",
        textSha256: "ab".repeat(32),
        asGiveaway: true,
      },
    });
    expect(event.message?.asGiveaway).toBe(true);
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "",
          textSha256: "ab".repeat(32),
          asGiveaway: false,
        },
      }),
    ).toThrow();
  });

  it("accepts a sticker emoji and rejects other marks", () => {
    const marked = parseEvent({
      id: "evt_1",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
      message: {
        id: "msg_1",
        text: "",
        textSha256: "ab".repeat(32),
        asStickerEmoji: true,
      },
    });
    expect(marked.message?.asStickerEmoji).toBe(true);
    const tagged = parseEvent({
      id: "evt_1",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
      message: {
        id: "msg_1",
        text: "今天站会",
        textSha256: "ab".repeat(32),
        senderTag: "加微x",
      },
    });
    expect(tagged.message?.senderTag).toBe("加微x");
    const labeled = parseEvent({
      id: "evt_1",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
      message: {
        id: "msg_1",
        text: "今天站会",
        textSha256: "ab".repeat(32),
        buttonText: "加微x",
      },
    });
    expect(labeled.message?.buttonText).toBe("加微x");
    const signed = parseEvent({
      id: "evt_1",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
      message: {
        id: "msg_1",
        text: "今天站会",
        textSha256: "ab".repeat(32),
        authorSignature: "加微x",
      },
    });
    expect(signed.message?.authorSignature).toBe("加微x");
    const mirrored = parseEvent({
      id: "evt_1",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
      message: {
        id: "msg_1",
        text: "今天站会",
        textSha256: "ab".repeat(32),
        mirrorSignature: "加微x",
      },
    });
    expect(mirrored.message?.mirrorSignature).toBe("加微x");
    const polled = parseEvent({
      id: "evt_1",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
      message: {
        id: "msg_1",
        text: "今天站会",
        textSha256: "ab".repeat(32),
        pollOption: "加微x",
      },
    });
    expect(polled.message?.pollOption).toBe("加微x");
    const tasked = parseEvent({
      id: "evt_1",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
      message: {
        id: "msg_1",
        text: "今天站会",
        textSha256: "ab".repeat(32),
        checklistTask: "加微x",
      },
    });
    expect(tasked.message?.checklistTask).toBe("加微x");
    const named = parseEvent({
      id: "evt_1",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
      message: {
        id: "msg_1",
        text: "今天站会",
        textSha256: "ab".repeat(32),
        mediaName: "加微x",
      },
    });
    expect(named.message?.mediaName).toBe("加微x");
    const performed = parseEvent({
      id: "evt_1",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
      message: {
        id: "msg_1",
        text: "今天站会",
        textSha256: "ab".repeat(32),
        performer: "加微x",
      },
    });
    expect(performed.message?.performer).toBe("加微x");
    const played = parseEvent({
      id: "evt_1",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
      message: {
        id: "msg_1",
        text: "今天站会",
        textSha256: "ab".repeat(32),
        gameText: "加微x",
        invoiceText: "加微信",
        venueAddress: "南京东路",
        pollExplanation: "点灯可见",
        pollQuestion: "选一个",
        prizeText: "奖品说明",
        checklistTitle: "购物清单",
        gameTitle: "小游戏",
        invoiceTitle: "商品",
        venueTitle: "见面地点",
        webAppButtonText: "打开小程序",
        quoteText: "引用原文",
        giftText: "礼物附言",
        giftLabel: "收藏名",
        topicName: "话题名",
        declineComment: "拒绝说明",
        addedText: "后加选项",
        hiddenName: "隐藏名字",
        memberName: "成员名字",
        sharedName: "分享名字",
        managedName: "受管名字",
        accessName: "小程序名字",
        gameFile: "动图文件",
        audioFile: "音频文件",
        paidFile: "付费文件",
        richName: "富文本名",
        pollMedia: "投票媒体",
        pollDescription: "投票描述",
        richText: "富文本段落",
        richButton: "富文本按钮",
        laterName: "后面的名称",
      },
    });
    expect(played.message?.gameText).toBe("加微x");
    expect(played.message?.invoiceText).toBe("加微信");
    expect(played.message?.venueAddress).toBe("南京东路");
    expect(played.message?.pollExplanation).toBe("点灯可见");
    expect(played.message?.pollQuestion).toBe("选一个");
    expect(played.message?.prizeText).toBe("奖品说明");
    expect(played.message?.checklistTitle).toBe("购物清单");
    expect(played.message?.gameTitle).toBe("小游戏");
    expect(played.message?.invoiceTitle).toBe("商品");
    expect(played.message?.venueTitle).toBe("见面地点");
    expect(played.message?.webAppButtonText).toBe("打开小程序");
    expect(played.message?.quoteText).toBe("引用原文");
    expect(played.message?.giftText).toBe("礼物附言");
    expect(played.message?.giftLabel).toBe("收藏名");
    expect(played.message?.topicName).toBe("话题名");
    expect(played.message?.declineComment).toBe("拒绝说明");
    expect(played.message?.addedText).toBe("后加选项");
    expect(played.message?.hiddenName).toBe("隐藏名字");
    expect(played.message?.memberName).toBe("成员名字");
    expect(played.message?.sharedName).toBe("分享名字");
    expect(played.message?.managedName).toBe("受管名字");
    expect(played.message?.accessName).toBe("小程序名字");
    expect(played.message?.gameFile).toBe("动图文件");
    expect(played.message?.audioFile).toBe("音频文件");
    expect(played.message?.paidFile).toBe("付费文件");
    expect(played.message?.richName).toBe("富文本名");
    expect(played.message?.pollMedia).toBe("投票媒体");
    expect(played.message?.pollDescription).toBe("投票描述");
    expect(played.message?.richText).toBe("富文本段落");
    expect(played.message?.richButton).toBe("富文本按钮");
    expect(played.message?.laterName).toBe("后面的名称");
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "今天站会",
          textSha256: "ab".repeat(32),
          buttonText: "a".repeat(257),
        },
      }),
    ).toThrow();
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "今天站会",
          textSha256: "ab".repeat(32),
          authorSignature: "a".repeat(257),
        },
      }),
    ).toThrow();
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "今天站会",
          textSha256: "ab".repeat(32),
          mirrorSignature: "a".repeat(257),
        },
      }),
    ).toThrow();
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "今天站会",
          textSha256: "ab".repeat(32),
          pollOption: "a".repeat(1212),
        },
      }),
    ).toThrow();
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "今天站会",
          textSha256: "ab".repeat(32),
          checklistTask: "a".repeat(3030),
        },
      }),
    ).toThrow();
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "今天站会",
          textSha256: "ab".repeat(32),
          mediaName: "a".repeat(4097),
        },
      }),
    ).toThrow();
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "今天站会",
          textSha256: "ab".repeat(32),
          performer: "a".repeat(4097),
        },
      }),
    ).toThrow();
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "今天站会",
          textSha256: "ab".repeat(32),
          gameText: "a".repeat(8194),
        },
      }),
    ).toThrow();
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "今天站会",
          textSha256: "ab".repeat(32),
          invoiceText: "a".repeat(256),
        },
      }),
    ).toThrow();
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "今天站会",
          textSha256: "ab".repeat(32),
          venueAddress: "a".repeat(4097),
        },
      }),
    ).toThrow();
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "今天站会",
          textSha256: "ab".repeat(32),
          pollExplanation: "a".repeat(201),
        },
      }),
    ).toThrow();
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "今天站会",
          textSha256: "ab".repeat(32),
          pollQuestion: "a".repeat(301),
        },
      }),
    ).toThrow();
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "今天站会",
          textSha256: "ab".repeat(32),
          prizeText: "a".repeat(256),
        },
      }),
    ).toThrow();
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "今天站会",
          textSha256: "ab".repeat(32),
          checklistTitle: "a".repeat(256),
        },
      }),
    ).toThrow();
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "今天站会",
          textSha256: "ab".repeat(32),
          gameTitle: "a".repeat(4097),
        },
      }),
    ).toThrow();
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "今天站会",
          textSha256: "ab".repeat(32),
          invoiceTitle: "a".repeat(33),
        },
      }),
    ).toThrow();
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "今天站会",
          textSha256: "ab".repeat(32),
          venueTitle: "a".repeat(4097),
        },
      }),
    ).toThrow();
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "今天站会",
          textSha256: "ab".repeat(32),
          webAppButtonText: "a".repeat(4097),
        },
      }),
    ).toThrow();
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "今天站会",
          textSha256: "ab".repeat(32),
          quoteText: "a".repeat(4097),
        },
      }),
    ).toThrow();
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "今天站会",
          textSha256: "ab".repeat(32),
          giftText: "a".repeat(129),
        },
      }),
    ).toThrow();
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "今天站会",
          textSha256: "ab".repeat(32),
          giftLabel: "a".repeat(4097),
        },
      }),
    ).toThrow();
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "今天站会",
          textSha256: "ab".repeat(32),
          topicName: "a".repeat(129),
        },
      }),
    ).toThrow();
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "今天站会",
          textSha256: "ab".repeat(32),
          declineComment: "a".repeat(129),
        },
      }),
    ).toThrow();
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "今天站会",
          textSha256: "ab".repeat(32),
          addedText: "a".repeat(3030),
        },
      }),
    ).toThrow();
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "今天站会",
          textSha256: "ab".repeat(32),
          hiddenName: "a".repeat(4097),
        },
      }),
    ).toThrow();
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "今天站会",
          textSha256: "ab".repeat(32),
          memberName: "a".repeat(4097),
        },
      }),
    ).toThrow();
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "今天站会",
          textSha256: "ab".repeat(32),
          sharedName: "a".repeat(4097),
        },
      }),
    ).toThrow();
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "今天站会",
          textSha256: "ab".repeat(32),
          managedName: "a".repeat(4097),
        },
      }),
    ).toThrow();
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "今天站会",
          textSha256: "ab".repeat(32),
          accessName: "a".repeat(4097),
        },
      }),
    ).toThrow();
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "今天站会",
          textSha256: "ab".repeat(32),
          gameFile: "a".repeat(4097),
        },
      }),
    ).toThrow();
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "今天站会",
          textSha256: "ab".repeat(32),
          audioFile: "a".repeat(4097),
        },
      }),
    ).toThrow();
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "今天站会",
          textSha256: "ab".repeat(32),
          paidFile: "a".repeat(4097),
        },
      }),
    ).toThrow();
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "今天站会",
          textSha256: "ab".repeat(32),
          richName: "a".repeat(4097),
        },
      }),
    ).toThrow();
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "今天站会",
          textSha256: "ab".repeat(32),
          pollMedia: "a".repeat(4097),
        },
      }),
    ).toThrow();
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "今天站会",
          textSha256: "ab".repeat(32),
          pollDescription: "a".repeat(1025),
        },
      }),
    ).toThrow();
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "今天站会",
          textSha256: "ab".repeat(32),
          richText: "a".repeat(4097),
        },
      }),
    ).toThrow();
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "今天站会",
          textSha256: "ab".repeat(32),
          richButton: "a".repeat(4097),
        },
      }),
    ).toThrow();
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "今天站会",
          textSha256: "ab".repeat(32),
          laterName: "a".repeat(4097),
        },
      }),
    ).toThrow();
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "今天站会",
          textSha256: "ab".repeat(32),
          senderTag: "a".repeat(17),
        },
      }),
    ).toThrow();
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "",
          textSha256: "ab".repeat(32),
          asStickerEmoji: false,
        },
      }),
    ).toThrow();
  });

  it("accepts a button emoji and rejects other marks", () => {
    const marked = parseEvent({
      id: "evt_1",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
      message: {
        id: "msg_1",
        text: "",
        textSha256: "ab".repeat(32),
        asButtonEmoji: true,
      },
    });
    expect(marked.message?.asButtonEmoji).toBe(true);
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "",
          textSha256: "ab".repeat(32),
          asButtonEmoji: false,
        },
      }),
    ).toThrow();
  });

  it("accepts a login forward and rejects other marks", () => {
    const marked = parseEvent({
      id: "evt_1",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
      message: {
        id: "msg_1",
        text: "",
        textSha256: "ab".repeat(32),
        asLoginForward: true,
      },
    });
    expect(marked.message?.asLoginForward).toBe(true);
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "",
          textSha256: "ab".repeat(32),
          asLoginForward: false,
        },
      }),
    ).toThrow();
  });

  it("accepts a switch query and rejects other marks", () => {
    const marked = parseEvent({
      id: "evt_1",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
      message: {
        id: "msg_1",
        text: "",
        textSha256: "ab".repeat(32),
        asSwitchQuery: true,
      },
    });
    expect(marked.message?.asSwitchQuery).toBe(true);
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "",
          textSha256: "ab".repeat(32),
          asSwitchQuery: false,
        },
      }),
    ).toThrow();
  });

  it("accepts a copy button and rejects other marks", () => {
    const marked = parseEvent({
      id: "evt_1",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
      message: {
        id: "msg_1",
        text: "",
        textSha256: "ab".repeat(32),
        asCopyText: true,
      },
    });
    expect(marked.message?.asCopyText).toBe(true);
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "",
          textSha256: "ab".repeat(32),
          asCopyText: false,
        },
      }),
    ).toThrow();
  });

  it("accepts a custom emoji and rejects other marks", () => {
    const marked = parseEvent({
      id: "evt_1",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
      message: {
        id: "msg_1",
        text: "",
        textSha256: "ab".repeat(32),
        asCustomEmoji: true,
      },
    });
    expect(marked.message?.asCustomEmoji).toBe(true);
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "",
          textSha256: "ab".repeat(32),
          asCustomEmoji: false,
        },
      }),
    ).toThrow();
  });

  it("accepts a text mention and rejects other marks", () => {
    const named = parseEvent({
      id: "evt_1",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
      message: {
        id: "msg_1",
        text: "",
        textSha256: "ab".repeat(32),
        asTextMention: true,
      },
    });
    expect(named.message?.asTextMention).toBe(true);
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "",
          textSha256: "ab".repeat(32),
          asTextMention: false,
        },
      }),
    ).toThrow();
  });

  it("accepts a rich reference link and rejects other marks", () => {
    const cited = parseEvent({
      id: "evt_1",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
      message: {
        id: "msg_1",
        text: "",
        textSha256: "ab".repeat(32),
        asRichReferenceLink: true,
      },
    });
    expect(cited.message?.asRichReferenceLink).toBe(true);
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "",
          textSha256: "ab".repeat(32),
          asRichReferenceLink: false,
        },
      }),
    ).toThrow();
  });

  it("accepts a rich reference and rejects other marks", () => {
    const reference = parseEvent({
      id: "evt_1",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
      message: {
        id: "msg_1",
        text: "",
        textSha256: "ab".repeat(32),
        asRichReference: true,
      },
    });
    expect(reference.message?.asRichReference).toBe(true);
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "",
          textSha256: "ab".repeat(32),
          asRichReference: false,
        },
      }),
    ).toThrow();
  });

  it("accepts a rich anchor link and rejects other marks", () => {
    const link = parseEvent({
      id: "evt_1",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
      message: {
        id: "msg_1",
        text: "",
        textSha256: "ab".repeat(32),
        asRichAnchorLink: true,
      },
    });
    expect(link.message?.asRichAnchorLink).toBe(true);
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "",
          textSha256: "ab".repeat(32),
          asRichAnchorLink: false,
        },
      }),
    ).toThrow();
  });

  it("accepts a rich anchor and rejects other marks", () => {
    const anchor = parseEvent({
      id: "evt_1",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
      message: {
        id: "msg_1",
        text: "",
        textSha256: "ab".repeat(32),
        asRichAnchor: true,
      },
    });
    expect(anchor.message?.asRichAnchor).toBe(true);
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "",
          textSha256: "ab".repeat(32),
          asRichAnchor: false,
        },
      }),
    ).toThrow();
  });

  it("accepts a rich cashtag and rejects other marks", () => {
    const cash = parseEvent({
      id: "evt_1",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
      message: {
        id: "msg_1",
        text: "",
        textSha256: "ab".repeat(32),
        asRichCashtag: true,
      },
    });
    expect(cash.message?.asRichCashtag).toBe(true);
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "",
          textSha256: "ab".repeat(32),
          asRichCashtag: false,
        },
      }),
    ).toThrow();
  });

  it("accepts a rich hashtag and rejects other marks", () => {
    const tag = parseEvent({
      id: "evt_1",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
      message: {
        id: "msg_1",
        text: "",
        textSha256: "ab".repeat(32),
        asRichHashtag: true,
      },
    });
    expect(tag.message?.asRichHashtag).toBe(true);
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "",
          textSha256: "ab".repeat(32),
          asRichHashtag: false,
        },
      }),
    ).toThrow();
  });

  it("accepts a rich command and rejects other marks", () => {
    const command = parseEvent({
      id: "evt_1",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
      message: {
        id: "msg_1",
        text: "",
        textSha256: "ab".repeat(32),
        asRichCommand: true,
      },
    });
    expect(command.message?.asRichCommand).toBe(true);
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "",
          textSha256: "ab".repeat(32),
          asRichCommand: false,
        },
      }),
    ).toThrow();
  });

  it("accepts a rich text mention and rejects other marks", () => {
    const named = parseEvent({
      id: "evt_1",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
      message: {
        id: "msg_1",
        text: "",
        textSha256: "ab".repeat(32),
        asRichTextMention: true,
      },
    });
    expect(named.message?.asRichTextMention).toBe(true);
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "",
          textSha256: "ab".repeat(32),
          asRichTextMention: false,
        },
      }),
    ).toThrow();
  });

  it("accepts a rich mention and rejects other marks", () => {
    const mention = parseEvent({
      id: "evt_1",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
      message: {
        id: "msg_1",
        text: "",
        textSha256: "ab".repeat(32),
        asRichMention: true,
      },
    });
    expect(mention.message?.asRichMention).toBe(true);
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "",
          textSha256: "ab".repeat(32),
          asRichMention: false,
        },
      }),
    ).toThrow();
  });

  it("accepts a rich map and rejects other marks", () => {
    const map = parseEvent({
      id: "evt_1",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
      message: {
        id: "msg_1",
        text: "",
        textSha256: "ab".repeat(32),
        asRichMap: true,
      },
    });
    expect(map.message?.asRichMap).toBe(true);
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "",
          textSha256: "ab".repeat(32),
          asRichMap: false,
        },
      }),
    ).toThrow();
  });

  it("accepts a rich email and rejects other marks", () => {
    const email = parseEvent({
      id: "evt_1",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
      message: {
        id: "msg_1",
        text: "",
        textSha256: "ab".repeat(32),
        asRichEmail: true,
      },
    });
    expect(email.message?.asRichEmail).toBe(true);
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "",
          textSha256: "ab".repeat(32),
          asRichEmail: false,
        },
      }),
    ).toThrow();
  });

  it("accepts a rich phone or card and rejects other marks", () => {
    const phone = parseEvent({
      id: "evt_1",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
      message: {
        id: "msg_1",
        text: "",
        textSha256: "ab".repeat(32),
        asRichPhone: true,
      },
    });
    expect(phone.message?.asRichPhone).toBe(true);
    const card = parseEvent({
      id: "evt_1",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
      message: {
        id: "msg_1",
        text: "",
        textSha256: "ab".repeat(32),
        asRichCard: true,
      },
    });
    expect(card.message?.asRichCard).toBe(true);
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "",
          textSha256: "ab".repeat(32),
          asRichPhone: false,
        },
      }),
    ).toThrow();
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "",
          textSha256: "ab".repeat(32),
          asRichCard: false,
        },
      }),
    ).toThrow();
  });

  it("accepts spoiler media and rejects other marks", () => {
    const event = parseEvent({
      id: "evt_1",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
      message: {
        id: "msg_1",
        text: "",
        textSha256: "ab".repeat(32),
        asSpoiler: true,
      },
    });
    expect(event.message?.asSpoiler).toBe(true);
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "",
          textSha256: "ab".repeat(32),
          asSpoiler: false,
        },
      }),
    ).toThrow();
  });

  it("accepts a message effect and rejects other marks", () => {
    const event = parseEvent({
      id: "evt_1",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
      message: {
        id: "msg_1",
        text: "",
        textSha256: "ab".repeat(32),
        asEffect: true,
      },
    });
    expect(event.message?.asEffect).toBe(true);
    expect(JSON.stringify(event)).not.toContain("fx5982secret");
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "",
          textSha256: "ab".repeat(32),
          asEffect: false,
        },
      }),
    ).toThrow();
  });

  it("accepts a pending suggested post and rejects other marks", () => {
    const event = parseEvent({
      id: "evt_1",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
      message: {
        id: "msg_1",
        text: "",
        textSha256: "ab".repeat(32),
        asPostPending: true,
      },
    });
    expect(event.message?.asPostPending).toBe(true);
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "",
          textSha256: "ab".repeat(32),
          asPostPending: false,
        },
      }),
    ).toThrow();
  });

  it("accepts a created group and rejects other marks", () => {
    const event = parseEvent({
      id: "evt_1",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
      message: {
        id: "msg_1",
        text: "",
        textSha256: "ab".repeat(32),
        asGroupCreated: true,
      },
    });
    expect(event.message?.asGroupCreated).toBe(true);
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "",
          textSha256: "ab".repeat(32),
          asGroupCreated: false,
        },
      }),
    ).toThrow();
  });

  it("accepts a declined suggested post and rejects other marks", () => {
    const event = parseEvent({
      id: "evt_1",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
      message: {
        id: "msg_1",
        text: "",
        textSha256: "ab".repeat(32),
        asPostDeclined: true,
      },
    });
    expect(event.message?.asPostDeclined).toBe(true);
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "",
          textSha256: "ab".repeat(32),
          asPostDeclined: false,
        },
      }),
    ).toThrow();
  });

  it("accepts a topic rename and rejects other marks", () => {
    const event = parseEvent({
      id: "evt_1",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
      message: {
        id: "msg_1",
        text: "",
        textSha256: "ab".repeat(32),
        topicNotice: "created",
      },
    });
    expect(event.message?.topicNotice).toBe("created");
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "",
          textSha256: "ab".repeat(32),
          topicNotice: "closed",
        },
      }),
    ).toThrow();
  });

  it("accepts an added checklist task and rejects other marks", () => {
    const event = parseEvent({
      id: "evt_1",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
      message: {
        id: "msg_1",
        text: "",
        textSha256: "ab".repeat(32),
        asChecklistAdded: true,
      },
    });
    expect(event.message?.asChecklistAdded).toBe(true);
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "",
          textSha256: "ab".repeat(32),
          asChecklistAdded: false,
        },
      }),
    ).toThrow();
  });

  it("accepts a poll option notice and rejects other marks", () => {
    const event = parseEvent({
      id: "evt_1",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
      message: {
        id: "msg_1",
        text: "",
        textSha256: "ab".repeat(32),
        pollNotice: "added",
      },
    });
    expect(event.message?.pollNotice).toBe("added");
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "",
          textSha256: "ab".repeat(32),
          pollNotice: "open",
        },
      }),
    ).toThrow();
  });

  it("accepts a proximity alert and rejects other marks", () => {
    const event = parseEvent({
      id: "evt_1",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
      message: {
        id: "msg_1",
        text: "",
        textSha256: "ab".repeat(32),
        asProximity: true,
      },
    });
    expect(event.message?.asProximity).toBe(true);
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "",
          textSha256: "ab".repeat(32),
          asProximity: false,
        },
      }),
    ).toThrow();
  });

  it("accepts an owner notice and rejects other marks", () => {
    const event = parseEvent({
      id: "evt_1",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
      message: {
        id: "msg_1",
        text: "",
        textSha256: "ab".repeat(32),
        ownerNotice: "changed",
      },
    });
    expect(event.message?.ownerNotice).toBe("changed");
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "",
          textSha256: "ab".repeat(32),
          ownerNotice: "other",
        },
      }),
    ).toThrow();
  });

  it("accepts a video-chat invite and rejects other marks", () => {
    const event = parseEvent({
      id: "evt_1",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
      message: {
        id: "msg_1",
        text: "",
        textSha256: "ab".repeat(32),
        asCallInvite: true,
      },
    });
    expect(event.message?.asCallInvite).toBe(true);
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "",
          textSha256: "ab".repeat(32),
          asCallInvite: false,
        },
      }),
    ).toThrow();
  });

  it("accepts a chat move and rejects an empty id", () => {
    const event = parseEvent({
      id: "evt_1",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
      chatMove: { from: "-1001", to: "-1002" },
      message: {
        id: "msg_1",
        text: "",
        textSha256: "ab".repeat(32),
      },
    });
    expect(event.chatMove).toEqual({ from: "-1001", to: "-1002" });
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        chatMove: { from: "", to: "-1002" },
        message: {
          id: "msg_1",
          text: "",
          textSha256: "ab".repeat(32),
        },
      }),
    ).toThrow();
  });

  it("accepts a checklist notice and rejects other marks", () => {
    const event = parseEvent({
      id: "evt_1",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
      message: {
        id: "msg_1",
        text: "",
        textSha256: "ab".repeat(32),
        checklistNotice: "done",
      },
    });
    expect(event.message?.checklistNotice).toBe("done");
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "",
          textSha256: "ab".repeat(32),
          checklistNotice: "added",
        },
      }),
    ).toThrow();
  });

  it("accepts a suggested-post notice and rejects other marks", () => {
    const event = parseEvent({
      id: "evt_1",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
      message: {
        id: "msg_1",
        text: "",
        textSha256: "ab".repeat(32),
        postNotice: "approved",
      },
    });
    expect(event.message?.postNotice).toBe("approved");
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "",
          textSha256: "ab".repeat(32),
          postNotice: "declined",
        },
      }),
    ).toThrow();
  });

  it("accepts a price notice and rejects other marks", () => {
    const event = parseEvent({
      id: "evt_1",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
      message: {
        id: "msg_1",
        text: "",
        textSha256: "ab".repeat(32),
        priceNotice: "paid",
      },
    });
    expect(event.message?.priceNotice).toBe("paid");
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "",
          textSha256: "ab".repeat(32),
          priceNotice: "stars",
        },
      }),
    ).toThrow();
  });

  it("accepts an auto-delete mark and rejects false", () => {
    const event = parseEvent({
      id: "evt_1",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
      message: {
        id: "msg_1",
        text: "",
        textSha256: "ab".repeat(32),
        asAutoDelete: true,
      },
    });
    expect(event.message?.asAutoDelete).toBe(true);
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "",
          textSha256: "ab".repeat(32),
          asAutoDelete: false,
        },
      }),
    ).toThrow();
  });

  it("accepts a forum notice and rejects other marks", () => {
    const event = parseEvent({
      id: "evt_1",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
      message: {
        id: "msg_1",
        text: "",
        textSha256: "ab".repeat(32),
        forumNotice: "closed",
      },
    });
    expect(event.message?.forumNotice).toBe("closed");
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "",
          textSha256: "ab".repeat(32),
          forumNotice: "created",
        },
      }),
    ).toThrow();
  });

  it("accepts a boost mark and rejects false", () => {
    const event = parseEvent({
      id: "evt_1",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
      message: {
        id: "msg_1",
        text: "",
        textSha256: "ab".repeat(32),
        asBoost: true,
      },
    });
    expect(event.message?.asBoost).toBe(true);
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "",
          textSha256: "ab".repeat(32),
          asBoost: false,
        },
      }),
    ).toThrow();
  });

  it("accepts a giveaway notice and rejects other marks", () => {
    const event = parseEvent({
      id: "evt_1",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
      message: {
        id: "msg_1",
        text: "",
        textSha256: "ab".repeat(32),
        giveawayNotice: "created",
      },
    });
    expect(event.message?.giveawayNotice).toBe("created");
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "",
          textSha256: "ab".repeat(32),
          giveawayNotice: "card",
        },
      }),
    ).toThrow();
  });

  it("accepts a pin mark and rejects false", () => {
    const event = parseEvent({
      id: "evt_1",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
      message: {
        id: "msg_1",
        text: "",
        textSha256: "ab".repeat(32),
        asPin: true,
      },
    });
    expect(event.message?.asPin).toBe(true);
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "",
          textSha256: "ab".repeat(32),
          asPin: false,
        },
      }),
    ).toThrow();
  });

  it("accepts a gift mark and rejects other marks", () => {
    const event = parseEvent({
      id: "evt_1",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
      message: {
        id: "msg_1",
        text: "",
        textSha256: "ab".repeat(32),
        gift: "card",
      },
    });
    expect(event.message?.gift).toBe("card");
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "",
          textSha256: "ab".repeat(32),
          gift: "join",
        },
      }),
    ).toThrow();
  });

  it("accepts a chat-background notice and rejects other marks", () => {
    const event = parseEvent({
      id: "evt_1",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
      message: {
        id: "msg_1",
        text: "",
        textSha256: "ab".repeat(32),
        background: "wallpaper",
      },
    });
    expect(event.message?.background).toBe("wallpaper");
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "",
          textSha256: "ab".repeat(32),
          background: "join",
        },
      }),
    ).toThrow();
  });

  it("accepts a chat-photo notice and rejects other marks", () => {
    const event = parseEvent({
      id: "evt_1",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
      message: {
        id: "msg_1",
        text: "",
        textSha256: "ab".repeat(32),
        photo: "set",
      },
    });
    expect(event.message?.photo).toBe("set");
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "",
          textSha256: "ab".repeat(32),
          photo: "join",
        },
      }),
    ).toThrow();
  });

  it("accepts a shared-chat mark and rejects false", () => {
    const event = parseEvent({
      id: "evt_1",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
      message: {
        id: "msg_1",
        text: "",
        textSha256: "ab".repeat(32),
        asSharedChat: true,
      },
    });
    expect(event.message?.asSharedChat).toBe(true);
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "",
          textSha256: "ab".repeat(32),
          asSharedChat: false,
        },
      }),
    ).toThrow();
  });

  it("accepts a community notice and rejects other marks", () => {
    const event = parseEvent({
      id: "evt_1",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
      message: {
        id: "msg_1",
        text: "",
        textSha256: "ab".repeat(32),
        community: "added",
      },
    });
    expect(event.message?.community).toBe("added");
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "",
          textSha256: "ab".repeat(32),
          community: "join",
        },
      }),
    ).toThrow();
  });

  it("accepts a renamed-chat mark and rejects false", () => {
    const event = parseEvent({
      id: "evt_1",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
      message: {
        id: "msg_1",
        text: "",
        textSha256: "ab".repeat(32),
        asTitle: true,
      },
    });
    expect(event.message?.asTitle).toBe(true);
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "",
          textSha256: "ab".repeat(32),
          asTitle: false,
        },
      }),
    ).toThrow();
  });

  it("accepts a video-chat notice and rejects other marks", () => {
    const event = parseEvent({
      id: "evt_1",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
      message: {
        id: "msg_1",
        text: "",
        textSha256: "ab".repeat(32),
        call: "started",
      },
    });
    expect(event.message?.call).toBe("started");
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "",
          textSha256: "ab".repeat(32),
          call: "join",
        },
      }),
    ).toThrow();
  });

  it("accepts a shared-contact flag and rejects false", () => {
    const event = parseEvent({
      id: "evt_1",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
      message: {
        id: "msg_1",
        text: "",
        textSha256: "ab".repeat(32),
        contact: true,
      },
    });
    expect(event.message?.contact).toBe(true);
    expect(event.message?.via).toBeUndefined();
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "",
          textSha256: "ab".repeat(32),
          contact: false,
        },
      }),
    ).toThrow();
  });

  it("accepts a media class with its digest and rejects a digest alone", () => {
    const event = parseEvent({
      id: "evt_1",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
      message: {
        id: "msg_1",
        text: "",
        textSha256: "ab".repeat(32),
        media: "sticker",
        mediaSha256: "cd".repeat(32),
      },
    });
    expect(event.message?.media).toBe("sticker");
    expect(event.message?.mediaSha256).toBe("cd".repeat(32));
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "",
          textSha256: "ab".repeat(32),
          mediaSha256: "cd".repeat(32),
        },
      }),
    ).toThrow();
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "",
          textSha256: "ab".repeat(32),
          media: "gif",
        },
      }),
    ).toThrow();
  });

  it("accepts an inline-bot flag and rejects false", () => {
    const event = parseEvent({
      id: "evt_1",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
      message: {
        id: "msg_1",
        text: "今天站会",
        textSha256: "ab".repeat(32),
        via: true,
      },
    });
    expect(event.message?.via).toBe(true);
    expect(event.message?.paid).toBeUndefined();
    const paid = parseEvent({
      id: "evt_paid",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
      message: {
        id: "msg_1",
        text: "",
        textSha256: "ab".repeat(32),
        paid: true,
      },
    });
    expect(paid.message?.paid).toBe(true);
    expect(() =>
      parseEvent({
        id: "evt_paid",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "",
          textSha256: "ab".repeat(32),
          paid: false,
        },
      }),
    ).toThrow();
    expect(() =>
      parseEvent({
        id: "evt_1",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "今天站会",
          textSha256: "ab".repeat(32),
          via: false,
        },
      }),
    ).toThrow();
  });

  it("keeps a safe join query id and rejects a phrase", () => {
    const event = parseEvent({
      id: "evt_join",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "join_request",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "83", isAdmin: false },
      joinQueryId: "query83",
    });
    expect(event.joinQueryId).toBe("query83");
    const named = parseEvent({
      id: "evt_join_name",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "join_request",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "83", isAdmin: false },
      nameHosts: ["bit.ly"],
      nameInvites: ["t.me"],
    });
    expect(named.nameHosts).toEqual(["bit.ly"]);
    expect(named.nameInvites).toEqual(["t.me"]);
    expect(() =>
      parseEvent({
        id: "evt_join_name",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "join_request",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "83", isAdmin: false },
        nameHosts: ["https://bit.ly/name83"],
      }),
    ).toThrow();
    expect(() =>
      parseEvent({
        id: "evt_join_name",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "join_request",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "83", isAdmin: false },
        nameHosts: [],
      }),
    ).toThrow();
    expect(() =>
      parseEvent({
        id: "evt_join",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "join_request",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "83", isAdmin: false },
        joinQueryId: "请免费领取礼品",
      }),
    ).toThrow();
    expect(() =>
      parseEvent({
        id: "evt_join",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "join_request",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "83", isAdmin: false },
        joinQueryId: "",
      }),
    ).toThrow();
  });

  it("keeps a folder-invite flag and rejects false", () => {
    const event = parseEvent({
      id: "evt_folder",
      tenantId: "tenant_1",
      chatId: "chat_1",
      kind: "chat_member",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
      membership: "join",
      folderInvite: true,
    });
    expect(event.folderInvite).toBe(true);
    expect(() =>
      parseEvent({
        id: "evt_folder",
        tenantId: "tenant_1",
        chatId: "chat_1",
        kind: "chat_member",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        folderInvite: false,
      }),
    ).toThrow();
  });
});
