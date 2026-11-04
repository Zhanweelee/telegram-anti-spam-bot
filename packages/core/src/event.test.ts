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
