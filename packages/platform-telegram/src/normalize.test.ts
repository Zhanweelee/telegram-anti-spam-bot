import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "./hash.js";
import { normalizeUpdate } from "./normalize.js";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "../fixtures");
const EMPTY_HASH =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const NOW = "2026-11-01T00:00:00.000Z";

function load(name: string): unknown {
  return JSON.parse(readFileSync(join(fixtureDir, name), "utf8"));
}

async function normalize(
  update: unknown,
  adminUserIds: readonly string[] = [],
) {
  return normalizeUpdate({
    update,
    tenantId: "local",
    adminUserIds,
    nowIso: NOW,
  });
}

describe("normalizeUpdate", () => {
  it("hashes with the known sha256 test vector", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(await sha256Hex("")).toBe(EMPTY_HASH);
  });

  it("normalizes a text message fixture", async () => {
    const outcome = await normalize(load("message.json"));
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    expect(outcome.event).toMatchObject({
      id: "tg_1001",
      tenantId: "local",
      chatId: "-100123",
      kind: "message",
      occurredAt: new Date(1761955200 * 1000).toISOString(),
      actor: { id: "42", isAdmin: false },
      message: {
        id: "10",
        text: "hello",
        textSha256: await sha256Hex("hello"),
      },
    });
  });

  it("keeps a message id when the update has no text", async () => {
    const outcome = await normalize(load("message-no-text.json"));
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    expect(outcome.event.actor.isAdmin).toBe(false);
    expect(outcome.event.message).toEqual({
      id: "11",
      text: "",
      textSha256: EMPTY_HASH,
    });
  });

  it("marks sender_chat of the same chat as an admin", async () => {
    const outcome = await normalize(load("message-admin.json"));
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    expect(outcome.event.actor).toEqual({ id: "42", isAdmin: true });
    expect(outcome.event.message?.text).toBe("公告");
  });

  it("marks a private chat as direct and leaves groups unset", async () => {
    const privateOutcome = await normalize({
      update_id: 30,
      message: {
        message_id: 1,
        date: 1761955200,
        chat: { id: 42, type: "private" },
        from: { id: 42, is_bot: false, first_name: "Ada" },
        text: "/help",
      },
    });
    expect(privateOutcome.status).toBe("event");
    if (privateOutcome.status !== "event") {
      return;
    }
    expect(privateOutcome.event.direct).toBe(true);
    expect(privateOutcome.event.chatId).toBe("42");

    const groupOutcome = await normalize(load("message.json"));
    expect(groupOutcome.status).toBe("event");
    if (groupOutcome.status !== "event") {
      return;
    }
    expect(groupOutcome.event.direct).toBeUndefined();
  });

  it("marks configured admin user ids without calling Telegram", async () => {
    const outcome = await normalize(load("message.json"), ["42"]);
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    expect(outcome.event.actor.isAdmin).toBe(true);
  });

  it("keeps only the hostname of a hidden text link", async () => {
    const secret = "https://user:机密@bit.ly/机密路径?q=1";
    const outcome = await normalize({
      update_id: 2003,
      message: {
        message_id: 9,
        date: 1761955200,
        chat: { id: -100589, type: "supergroup" },
        from: { id: 9 },
        text: "点这里",
        entities: [
          { type: "text_link", offset: 0, length: 3, url: secret },
          {
            type: "text_link",
            offset: 0,
            length: 3,
            url: "https://BIT.LY/again",
          },
          {
            type: "url",
            offset: 0,
            length: 3,
            url: "https://evil.example/nope",
          },
          {
            type: "text_link",
            offset: 0,
            length: 3,
            url: "tg://resolve?domain=spam",
          },
          {
            type: "text_link",
            offset: 0,
            length: 3,
            url: `https://bit.ly/${"a".repeat(2048)}`,
          },
          {
            type: "text_link",
            offset: 0,
            length: 3,
            url: "http://[2001:db8::1]/x",
          },
        ],
        caption_entities: [
          {
            type: "text_link",
            offset: 0,
            length: 2,
            url: "https://example.com/docs?token=机密",
          },
        ],
      },
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    expect(outcome.event.message?.text).toBe("点这里");
    expect(outcome.event.message?.textSha256).toBe(await sha256Hex("点这里"));
    expect(outcome.event.message?.hosts).toEqual(["bit.ly", "example.com"]);
    const dumped = JSON.stringify(outcome.event);
    expect(dumped).not.toContain(secret);
    expect(dumped).not.toContain("机密");
    expect(dumped).not.toContain("evil.example");
  });

  it("prefers a caption when text is missing", async () => {
    const outcome = await normalize({
      update_id: 8,
      message: {
        message_id: 3,
        date: 1761955200,
        chat: { id: 5 },
        from: { id: 9 },
        caption: "caption-only",
      },
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    expect(outcome.event.message?.text).toBe("caption-only");
    expect(outcome.event.message?.textSha256).toBe(
      await sha256Hex("caption-only"),
    );
  });

  it("keeps only the forward class and drops the channel title", async () => {
    const title = "机密频道名";
    const origin = await normalize({
      update_id: 31,
      message: {
        message_id: 4,
        date: 1761955200,
        chat: { id: -100582, type: "supergroup" },
        from: { id: 9 },
        text: "今天站会",
        forward_origin: {
          type: "channel",
          chat: { id: -1001, title, type: "channel" },
        },
      },
    });
    expect(origin.status).toBe("event");
    if (origin.status !== "event") {
      return;
    }
    expect(origin.event.message?.forward).toBe("channel");
    expect(JSON.stringify(origin.event)).not.toContain(title);

    const legacy = await normalize({
      update_id: 32,
      message: {
        message_id: 5,
        date: 1761955200,
        chat: { id: -100582, type: "supergroup" },
        from: { id: 9 },
        text: "今天站会",
        forward_from_chat: { id: -1001, title, type: "channel" },
      },
    });
    expect(legacy.status).toBe("event");
    if (legacy.status !== "event") {
      return;
    }
    expect(legacy.event.message?.forward).toBe("channel");
    expect(JSON.stringify(legacy.event)).not.toContain(title);

    const hidden = await normalize({
      update_id: 33,
      message: {
        message_id: 6,
        date: 1761955200,
        chat: { id: -100582, type: "supergroup" },
        from: { id: 9 },
        text: "今天站会",
        forward_origin: { type: "hidden_user", sender_user_name: title },
      },
    });
    expect(hidden.status).toBe("event");
    if (hidden.status !== "event") {
      return;
    }
    expect(hidden.event.message?.forward).toBe("hidden");
    expect(JSON.stringify(hidden.event)).not.toContain(title);
  });

  it("uses the supplied clock when the message has no date", async () => {
    const outcome = await normalize({
      update_id: 9,
      message: {
        message_id: 4,
        chat: { id: -1 },
        from: { id: 2 },
        text: "x",
      },
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    expect(outcome.event.occurredAt).toBe(NOW);
  });

  it("treats anonymous admins as the chat itself", async () => {
    const outcome = await normalize({
      update_id: 4,
      message: {
        message_id: 1,
        date: 1761955200,
        chat: { id: -5 },
        sender_chat: { id: -5 },
        text: "hi",
      },
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    expect(outcome.event.actor).toEqual({ id: "-5", isAdmin: true });
  });

  it("rejects updates that are not objects or lack update_id", async () => {
    expect((await normalize([])).status).toBe("invalid");
    expect((await normalize({})).status).toBe("invalid");
    expect((await normalize(null)).status).toBe("invalid");
  });

  it("normalizes a chat_member fixture onto the joining user", async () => {
    const outcome = await normalize(load("chat-member.json"));
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    expect(outcome.event.kind).toBe("chat_member");
    expect(outcome.event.message).toBeUndefined();
    expect(outcome.event.actor).toEqual({ id: "77", isAdmin: false });
    expect(outcome.event.membership).toBe("join");
    expect(outcome.event.chatId).toBe("-100123");
    expect(outcome.event.occurredAt).toBe(
      new Date(1761955200 * 1000).toISOString(),
    );
    expect(outcome.event.profile?.text).toBe("Newbie");
    const withoutProfile = { ...outcome.event, profile: undefined };
    expect(JSON.stringify(withoutProfile)).not.toContain("Newbie");
    expect(outcome.event.actor.id).not.toBe("1");
  });

  it("treats creator and administrator status as admins", async () => {
    const outcome = await normalize({
      update_id: 2002,
      chat_member: {
        chat: { id: -100123 },
        from: { id: 1 },
        date: 1761955200,
        new_chat_member: {
          user: { id: 77 },
          status: "administrator",
        },
      },
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    expect(outcome.event.actor).toEqual({ id: "77", isAdmin: true });
  });

  it("marks a configured admin id on a membership change", async () => {
    const outcome = await normalize(
      {
        update_id: 2003,
        chat_member: {
          chat: { id: 5 },
          date: 1761955200,
          new_chat_member: { user: { id: 77 }, status: "member" },
        },
      },
      ["77"],
    );
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    expect(outcome.event.actor.isAdmin).toBe(true);
    expect(outcome.event.membership).toBe("join");
  });

  it("does not mark a leave or a bot as a join", async () => {
    const leave = await normalize({
      update_id: 2004,
      chat_member: {
        chat: { id: -100 },
        date: 1761955200,
        old_chat_member: { user: { id: 77 }, status: "member" },
        new_chat_member: { user: { id: 77 }, status: "left" },
      },
    });
    expect(leave.status).toBe("event");
    if (leave.status === "event") {
      expect(leave.event.membership).toBeUndefined();
    }
    const bot = await normalize({
      update_id: 2005,
      chat_member: {
        chat: { id: -100 },
        date: 1761955200,
        old_chat_member: {
          user: { id: 88, is_bot: true },
          status: "left",
        },
        new_chat_member: {
          user: { id: 88, is_bot: true },
          status: "member",
        },
      },
    });
    expect(bot.status).toBe("event");
    if (bot.status === "event") {
      expect(bot.event.membership).toBeUndefined();
    }
  });

  it("ignores incomplete membership updates and my_chat_member", async () => {
    expect(
      (await normalize({ update_id: 4, chat_member: { chat: { id: 1 } } }))
        .status,
    ).toBe("ignored");
    expect(
      (
        await normalize({
          update_id: 5,
          my_chat_member: {
            chat: { id: 1 },
            date: 1761955200,
            new_chat_member: { user: { id: 2 }, status: "member" },
          },
        })
      ).status,
    ).toBe("ignored");
  });

  it("turns a captcha button into a challenge without message text", async () => {
    const nonce = "0123456789abcdef";
    const leaked = "请免费领取礼品";
    const outcome = await normalize({
      update_id: 30,
      callback_query: {
        id: "cb-1",
        from: { id: 77 },
        data: `c:${nonce}`,
        message: {
          message_id: 4,
          chat: { id: -100123 },
          text: leaked,
        },
      },
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    expect(outcome.event.kind).toBe("challenge");
    expect(outcome.event.message).toBeUndefined();
    expect(outcome.event.challenge).toEqual({ nonce });
    expect(outcome.event.actor).toEqual({ id: "77", isAdmin: false });
    expect(JSON.stringify(outcome.event)).not.toContain(leaked);
  });

  it("ignores callback data that is not a captcha nonce", async () => {
    const leaked = "请免费领取礼品";
    const outcome = await normalize({
      update_id: 31,
      callback_query: {
        id: "cb-2",
        from: { id: 77 },
        data: leaked,
        message: { chat: { id: -100 } },
      },
    });
    expect(outcome.status).toBe("ignored");
    expect(JSON.stringify(outcome)).not.toContain(leaked);
  });

  it("ignores unsupported update types and incomplete messages", async () => {
    expect(
      (await normalize({ update_id: 1, callback_query: { id: "1" } })).status,
    ).toBe("ignored");
    expect(
      (await normalize({ update_id: 2, edited_message: { message_id: 1 } }))
        .status,
    ).toBe("ignored");
    const phrase = "请免费领取礼品";
    const edited = await normalize({
      update_id: 4,
      edited_message: {
        message_id: 9,
        date: 1761955200,
        text: phrase,
        chat: { id: -100568, type: "supergroup" },
        from: { id: 5 },
      },
    });
    expect(edited.status).toBe("event");
    if (edited.status === "event") {
      expect(edited.event.edited).toBe(true);
      expect(edited.event.kind).toBe("message");
      expect(edited.event.message?.id).toBe("9");
      expect(edited.event.message?.text).toBe(phrase);
    }
    expect(
      (await normalize({ update_id: 3, message: { text: "no ids" } })).status,
    ).toBe("ignored");
  });

  it("keeps a joining name for screening and drops other profile fields", async () => {
    const name = "广告员";
    const extra = "机密简介";
    const outcome = await normalize({
      update_id: 38,
      chat_member: {
        chat: { id: -100588, type: "supergroup", title: extra },
        from: { id: 1, first_name: extra },
        date: 1761955200,
        old_chat_member: { user: { id: 77 }, status: "left" },
        new_chat_member: {
          user: {
            id: 77,
            first_name: name,
            last_name: "免费领取",
            username: "gift",
            language_code: extra,
          },
          status: "member",
        },
      },
    });
    expect(outcome.status).toBe("event");
    if (outcome.status === "event") {
      expect(outcome.event.membership).toBe("join");
      expect(outcome.event.profile?.text).toBe(`${name} 免费领取 gift`);
      expect(outcome.event.profile?.textSha256).toHaveLength(64);
      const encoded = JSON.stringify({
        ...outcome.event,
        profile: { textSha256: outcome.event.profile?.textSha256 },
      });
      expect(encoded).not.toContain(name);
      expect(encoded).not.toContain(extra);
    }
    const stayed = await normalize({
      update_id: 39,
      chat_member: {
        chat: { id: -100588, type: "supergroup" },
        from: { id: 1 },
        old_chat_member: { user: { id: 77 }, status: "member" },
        new_chat_member: {
          user: { id: 77, first_name: name },
          status: "administrator",
        },
      },
    });
    expect(stayed.status).toBe("event");
    if (stayed.status === "event") {
      expect(stayed.event.profile).toBeUndefined();
      expect(JSON.stringify(stayed.event)).not.toContain(name);
    }
  });

  it("records a group admin grant without the chat title", async () => {
    const title = "机密群名";
    const granted = await normalize({
      update_id: 34,
      my_chat_member: {
        chat: { id: -100586, type: "supergroup", title },
        from: { id: 7, first_name: title },
        date: 1761955200,
        old_chat_member: { user: { id: 99, is_bot: true }, status: "left" },
        new_chat_member: {
          user: { id: 99, is_bot: true, username: "tasb" },
          status: "administrator",
        },
      },
    });
    expect(granted.status).toBe("event");
    if (granted.status === "event") {
      expect(granted.event.kind).toBe("bot_membership");
      expect(granted.event.bot).toBe("admin");
      expect(granted.event.chatId).toBe("-100586");
      expect(granted.event.actor).toEqual({ id: "7", isAdmin: false });
      expect(granted.event.message).toBeUndefined();
      expect(JSON.stringify(granted.event)).not.toContain(title);
    }
    const left = await normalize({
      update_id: 35,
      my_chat_member: {
        chat: { id: -100586, type: "group", title },
        from: { id: 7 },
        new_chat_member: { user: { id: 99 }, status: "left" },
      },
    });
    expect(left.status).toBe("event");
    if (left.status === "event") {
      expect(left.event.bot).toBe("gone");
    }
    expect(
      (
        await normalize({
          update_id: 36,
          my_chat_member: {
            chat: { id: 7, type: "private" },
            from: { id: 7 },
            new_chat_member: { user: { id: 99 }, status: "member" },
          },
        })
      ).status,
    ).toBe("ignored");
    expect(
      (
        await normalize({
          update_id: 37,
          my_chat_member: {
            chat: { id: -100586, type: "channel", title },
            from: { id: 7 },
            new_chat_member: { user: { id: 99 }, status: "administrator" },
          },
        })
      ).status,
    ).toBe("ignored");
  });
});
