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
