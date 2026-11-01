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
    expect(JSON.stringify(outcome.event)).not.toContain("Newbie");
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
    expect(
      (await normalize({ update_id: 3, message: { text: "no ids" } })).status,
    ).toBe("ignored");
  });
});
