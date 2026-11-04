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
