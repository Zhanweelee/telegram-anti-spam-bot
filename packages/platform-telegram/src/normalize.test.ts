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

  it("hashes a sticker file id and leaves the id out of the event", async () => {
    const phrase = "请免费领取礼品";
    const outcome = await normalize({
      update_id: 1101,
      message: {
        message_id: 21,
        date: 1761955200,
        chat: { id: -100123, type: "supergroup" },
        from: { id: 7, is_bot: false, first_name: "Bob" },
        sticker: {
          file_id: phrase,
          file_unique_id: phrase,
          width: 64,
          height: 64,
        },
      },
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    expect(outcome.event.message).toEqual({
      id: "21",
      text: "",
      textSha256: EMPTY_HASH,
      media: "sticker",
      mediaSha256: await sha256Hex(`sticker\n${phrase}`),
    });
    expect(JSON.stringify(outcome.event)).not.toContain(phrase);
  });

  it("keeps the first media class and skips an oversized file id", async () => {
    const longId = "x".repeat(257);
    const outcome = await normalize({
      update_id: 1102,
      message: {
        message_id: 22,
        date: 1761955200,
        chat: { id: -100123, type: "supergroup" },
        from: { id: 7, is_bot: false, first_name: "Bob" },
        animation: { file_unique_id: longId },
        photo: [{ file_unique_id: "photo-1" }],
      },
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    expect(outcome.event.message?.media).toBe("animation");
    expect(outcome.event.message?.mediaSha256).toBeUndefined();
    expect(JSON.stringify(outcome.event)).not.toContain(longId);
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
      media: "photo",
    });
    expect(JSON.stringify(outcome.event)).not.toContain("abc");
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

  it("keeps only the hostname of an inline button url", async () => {
    const phrase = "请免费领取礼品";
    const code = "INVITEBUTTON99";
    const outcome = await normalize({
      update_id: 2101,
      message: {
        message_id: 31,
        date: 1761955200,
        chat: { id: -100700, type: "supergroup" },
        from: { id: 9 },
        text: "点下面",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: phrase,
                url: `https://bit.ly/path?q=${phrase}`,
              },
              {
                text: "callback",
                callback_data: "https://evil.example/skip",
              },
            ],
            [
              {
                text: "join",
                url: `https://t.me/+${code}`,
              },
            ],
          ],
        },
      },
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    expect(outcome.event.message?.text).toBe("点下面");
    expect(outcome.event.message?.hosts).toEqual(["bit.ly", "t.me"]);
    expect(outcome.event.message?.invites).toEqual(["t.me"]);
    const dumped = JSON.stringify(outcome.event);
    expect(dumped).not.toContain(phrase);
    expect(dumped).not.toContain(code);
    expect(dumped).not.toContain("evil.example");
  });

  it("keeps only the hostname when copy_text is one url", async () => {
    const phrase = "请免费领取礼品";
    const code = "INVITECOPY99";
    const outcome = await normalize({
      update_id: 2102,
      message: {
        message_id: 32,
        date: 1761955200,
        chat: { id: -100701, type: "supergroup" },
        from: { id: 9 },
        text: "点下面",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "copy",
                copy_text: { text: `https://bit.ly/path?q=${phrase}` },
              },
              {
                text: phrase,
                copy_text: { text: `${phrase} https://evil.example/hide` },
              },
            ],
            [
              {
                text: "join",
                copy_text: { text: `https://t.me/+${code}` },
              },
              {
                text: "login",
                login_url: { url: "https://login.example/start" },
              },
              {
                text: "app",
                web_app: { url: "https://app.example/open" },
              },
            ],
          ],
        },
      },
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    expect(outcome.event.message?.text).toBe("点下面");
    expect(outcome.event.message?.hosts).toEqual([
      "bit.ly",
      "evil.example",
      "t.me",
      "login.example",
      "app.example",
    ]);
    expect(outcome.event.message?.invites).toEqual(["t.me"]);
    const dumped = JSON.stringify(outcome.event);
    expect(dumped).not.toContain(phrase);
    expect(dumped).not.toContain(code);
    expect(dumped).not.toContain("/hide");
    expect(dumped).not.toContain("/start");
    expect(dumped).not.toContain("/open");
  });

  it("folds gaps inside a structured invite before classifying it", async () => {
    const phrase = "请免费领取礼品";
    const zwsp = "INVITEFOLD33";
    const selector = "INVITEFE0F33";
    const nbsp = "INVITENBSP33";
    const outcome = await normalize({
      update_id: 3333,
      message: {
        message_id: 33,
        date: 1761955200,
        chat: { id: -100733, type: "supergroup" },
        from: { id: 9 },
        text: "点下面",
        entities: [
          {
            type: "text_link",
            offset: 0,
            length: 3,
            url: `https://telegram.me/joinchat/IN\uFE0F${selector}`,
          },
        ],
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: phrase,
                url: `https://t.me/+IN\u200b${zwsp}`,
              },
            ],
            [
              {
                text: "copy",
                copy_text: {
                  text: `https://telegram.dog/addlist/IN\u00A0${nbsp}`,
                },
              },
              {
                text: "spaced",
                url: "https://bit. ly/only",
              },
              {
                text: "short",
                url: "https://tinyurl\u00A0.com/only",
              },
            ],
          ],
        },
      },
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    expect(outcome.event.message?.text).toBe("点下面");
    expect(outcome.event.message?.hosts).toEqual([
      "telegram.me",
      "t.me",
      "telegram.dog",
      "tinyurl.com",
    ]);
    expect(outcome.event.message?.invites).toEqual([
      "telegram.me",
      "t.me",
      "telegram.dog",
    ]);
    const dumped = JSON.stringify(outcome.event);
    expect(dumped).not.toContain(phrase);
    expect(dumped).not.toContain(zwsp);
    expect(dumped).not.toContain(selector);
    expect(dumped).not.toContain(nbsp);
    expect(dumped).not.toContain("bit.ly");
    expect(dumped).not.toContain("\u200b");
    expect(dumped).not.toContain("\uFE0F");
    expect(dumped).not.toContain("\u00A0");
  });

  it("folds a percent-encoded invite before classifying it", async () => {
    const phrase = "请免费领取礼品";
    const zwsp = "ENCODEFOLD34";
    const selector = "ENCODEFE0F34";
    const nbsp = "ENCODENBSP34";
    const outcome = await normalize({
      update_id: 3434,
      message: {
        message_id: 34,
        date: 1761955200,
        chat: { id: -100734, type: "supergroup" },
        from: { id: 9 },
        text: "点下面",
        entities: [
          {
            type: "text_link",
            offset: 0,
            length: 3,
            url: `https://telegram.me/joinchat/IN%EF%B8%8F${selector}`,
          },
        ],
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: phrase,
                url: `https://t.me/+IN%E2%80%8B${zwsp}`,
              },
            ],
            [
              {
                text: "copy",
                copy_text: {
                  text: `https://telegram.dog/addlist/IN%C2%A0${nbsp}`,
                },
              },
              {
                text: "spaced",
                url: "https://bit.%20ly/only",
              },
              {
                text: "twice",
                url: "https://double.t.me/+IN%25E2%2580%258BDOUBLE34",
              },
            ],
          ],
        },
      },
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    expect(outcome.event.message?.text).toBe("点下面");
    expect(outcome.event.message?.hosts).toEqual([
      "telegram.me",
      "t.me",
      "telegram.dog",
      "double.t.me",
    ]);
    expect(outcome.event.message?.invites).toEqual([
      "telegram.me",
      "t.me",
      "telegram.dog",
      "double.t.me",
    ]);
    const dumped = JSON.stringify(outcome.event);
    expect(dumped).not.toContain(phrase);
    expect(dumped).not.toContain(zwsp);
    expect(dumped).not.toContain(selector);
    expect(dumped).not.toContain(nbsp);
    expect(dumped).not.toContain("DOUBLE34");
    expect(dumped).not.toContain("bit.ly");
  });

  it("folds a percent-encoded slash before classifying a structured link", async () => {
    const phrase = "请免费领取礼品";
    const code = "SLASHFOLD38";
    const join = "SLASHJOIN38";
    const outcome = await normalize({
      update_id: 3838,
      message: {
        message_id: 38,
        date: 1761955200,
        chat: { id: -100738, type: "supergroup" },
        from: { id: 9 },
        text: "点下面",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: phrase,
                url: `https://t.me%2F+${code}`,
              },
            ],
            [
              {
                text: "join",
                url: `https://telegram.me%2fjoinchat%2f${join}`,
              },
              {
                text: "public",
                url: "https://telegram.dog%2Fdurov",
              },
              {
                text: "short",
                url: "https://bit.ly%2Fonly",
              },
              {
                text: "twice",
                url: "https://double.t.me%252F+DOUBLE38",
              },
            ],
          ],
        },
      },
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    expect(outcome.event.message?.text).toBe("点下面");
    expect(outcome.event.message?.hosts).toEqual([
      "t.me",
      "telegram.me",
      "telegram.dog",
      "bit.ly",
    ]);
    expect(outcome.event.message?.invites).toEqual(["t.me", "telegram.me"]);
    const dumped = JSON.stringify(outcome.event);
    expect(dumped).not.toContain(phrase);
    expect(dumped).not.toContain(code);
    expect(dumped).not.toContain(join);
    expect(dumped).not.toContain("DOUBLE38");
    expect(dumped).not.toContain("durov");
    expect(dumped).not.toContain("/only");
  });

  it("folds a percent-encoded plus before classifying an invite", async () => {
    const phrase = "请免费领取礼品";
    const code = "PLUSFOLD39";
    const lower = "PLUSLOW39";
    const outcome = await normalize({
      update_id: 3839,
      message: {
        message_id: 39,
        date: 1761955200,
        chat: { id: -100739, type: "supergroup" },
        from: { id: 9 },
        text: "点下面",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: phrase,
                url: `https://t.me/%2B${code}`,
              },
            ],
            [
              {
                text: "lower",
                url: `https://telegram.me/%2b${lower}`,
              },
              {
                text: "public",
                url: "https://t.me/durov",
              },
              {
                text: "plain",
                url: "https://example.com/%2Bdocs",
              },
              {
                text: "twice",
                url: "https://double.t.me/%252BDOUBLE39",
              },
            ],
          ],
        },
      },
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    expect(outcome.event.message?.text).toBe("点下面");
    expect(outcome.event.message?.hosts).toEqual([
      "t.me",
      "telegram.me",
      "example.com",
      "double.t.me",
    ]);
    expect(outcome.event.message?.invites).toEqual(["t.me", "telegram.me"]);
    const dumped = JSON.stringify(outcome.event);
    expect(dumped).not.toContain(phrase);
    expect(dumped).not.toContain(code);
    expect(dumped).not.toContain(lower);
    expect(dumped).not.toContain("DOUBLE39");
    expect(dumped).not.toContain("durov");
    expect(dumped).not.toContain("%2Bdocs");
  });

  it("folds a percent-encoded letter before classifying a structured link", async () => {
    const phrase = "请免费领取礼品";
    const code = "LETTER40";
    const join = "JOIN40";
    const outcome = await normalize({
      update_id: 3840,
      message: {
        message_id: 40,
        date: 1761955200,
        chat: { id: -100740, type: "supergroup" },
        from: { id: 9 },
        text: "点下面",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: phrase,
                url: `https://t.me/+OFF%45${code}`,
              },
            ],
            [
              {
                text: "join",
                url: `https://telegram.me/joinchat/off%65${join}`,
              },
              {
                text: "public",
                url: "https://t.me/durov",
              },
              {
                text: "plain",
                url: "https://example%41.com/docs",
              },
              {
                text: "twice",
                url: "https://double.t.me/+OFF%2545DOUBLE40",
              },
              {
                text: "thrice",
                url: "https://triple.t.me/+OFF%252545TRIPLE40",
              },
            ],
          ],
        },
      },
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    expect(outcome.event.message?.text).toBe("点下面");
    expect(outcome.event.message?.hosts).toEqual([
      "t.me",
      "telegram.me",
      "examplea.com",
      "double.t.me",
      "triple.t.me",
    ]);
    expect(outcome.event.message?.invites).toEqual([
      "t.me",
      "telegram.me",
      "double.t.me",
    ]);
    const dumped = JSON.stringify(outcome.event);
    expect(dumped).not.toContain(phrase);
    expect(dumped).not.toContain(code);
    expect(dumped).not.toContain(join);
    expect(dumped).not.toContain("DOUBLE40");
    expect(dumped).not.toContain("TRIPLE40");
    expect(dumped).not.toContain("durov");
    expect(dumped).not.toContain("/docs");
  });

  it("marks a hidden telegram invite without keeping the code", async () => {
    const code = "INVITESECRET99";
    const outcome = await normalize({
      update_id: 2004,
      message: {
        message_id: 12,
        date: 1761955200,
        chat: { id: -100590, type: "supergroup" },
        from: { id: 9 },
        text: "点这里",
        entities: [
          {
            type: "text_link",
            offset: 0,
            length: 3,
            url: `https://t.me/+${code}`,
          },
          {
            type: "text_link",
            offset: 0,
            length: 3,
            url: "https://t.me/durov",
          },
          {
            type: "text_link",
            offset: 0,
            length: 3,
            url: `https://telegram.me/joinchat/${code}`,
          },
        ],
      },
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    expect(outcome.event.message?.text).toBe("点这里");
    expect(outcome.event.message?.invites).toEqual(["t.me", "telegram.me"]);
    expect(outcome.event.message?.hosts).toEqual(["t.me", "telegram.me"]);
    const dumped = JSON.stringify(outcome.event);
    expect(dumped).not.toContain(code);
  });

  it("keeps a shared contact as a flag and drops the phone", async () => {
    const phone = "13800138000";
    const name = "机密姓名";
    const outcome = await normalize({
      update_id: 2008,
      message: {
        message_id: 13,
        date: 1761955200,
        chat: { id: -100593, type: "supergroup", title: "机密群名" },
        from: { id: 92 },
        contact: {
          phone_number: phone,
          first_name: name,
          last_name: "机密姓",
          user_id: 999001,
          vcard: "BEGIN:VCARD",
        },
      },
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    expect(outcome.event.message?.contact).toBe(true);
    expect(outcome.event.message?.text).toBe("");
    const dumped = JSON.stringify(outcome.event);
    expect(dumped).not.toContain(phone);
    expect(dumped).not.toContain(name);
    expect(dumped).not.toContain("机密姓");
    expect(dumped).not.toContain("VCARD");
    expect(dumped).not.toContain("999001");
    expect(dumped).not.toContain("机密群名");
  });

  it("keeps an inline bot as a flag and drops its username", async () => {
    const name = "机密代发";
    const outcome = await normalize({
      update_id: 2009,
      message: {
        message_id: 14,
        date: 1761955200,
        chat: { id: -100594, type: "supergroup", title: "机密群名" },
        from: { id: 93 },
        text: "今天站会",
        via_bot: {
          id: 999002,
          is_bot: true,
          first_name: name,
          username: name,
        },
      },
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    expect(outcome.event.message?.via).toBe(true);
    expect(outcome.event.message?.text).toBe("今天站会");
    const dumped = JSON.stringify(outcome.event);
    expect(dumped).not.toContain(name);
    expect(dumped).not.toContain("999002");
    expect(dumped).not.toContain("机密群名");
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

  it("uses a poll question when text and caption are missing", async () => {
    const phrase = "请免费领取礼品";
    const code = "INVITEPOLL99";
    const question = "免费领取";
    const outcome = await normalize({
      update_id: 2201,
      message: {
        message_id: 41,
        date: 1761955200,
        chat: { id: -100710, type: "supergroup" },
        from: { id: 9 },
        poll: {
          question,
          question_entities: [
            {
              type: "text_link",
              offset: 0,
              length: question.length,
              url: `https://bit.ly/path?q=${phrase}`,
            },
            {
              type: "text_link",
              offset: 0,
              length: 1,
              url: `https://t.me/+${code}`,
            },
          ],
          options: [{ text: phrase, voter_count: 0 }],
          explanation: phrase,
          total_voter_count: 0,
          is_closed: false,
          is_anonymous: true,
          type: "regular",
          allows_multiple_answers: false,
        },
      },
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    expect(outcome.event.message?.text).toBe(question);
    expect(outcome.event.message?.textSha256).toBe(await sha256Hex(question));
    expect(outcome.event.message?.hosts).toEqual(["bit.ly", "t.me"]);
    expect(outcome.event.message?.invites).toEqual(["t.me"]);
    const dumped = JSON.stringify(outcome.event);
    expect(dumped).not.toContain(phrase);
    expect(dumped).not.toContain(code);
  });

  it("keeps a caption when a poll is also present", async () => {
    const outcome = await normalize({
      update_id: 2202,
      message: {
        message_id: 42,
        date: 1761955200,
        chat: { id: -100711, type: "supergroup" },
        from: { id: 9 },
        caption: "caption-only",
        poll: { question: "免费领取", options: [] },
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

  it("uses a giveaway prize description when text is missing", async () => {
    const title = "请免费领取礼品";
    const prize = "免费领取";
    const outcome = await normalize({
      update_id: 2203,
      message: {
        message_id: 43,
        date: 1761955200,
        chat: { id: -100712, type: "supergroup" },
        from: { id: 9 },
        giveaway: {
          chats: [{ id: -1001, type: "channel", title }],
          winners_selection_date: 1762000000,
          winner_count: 1,
          prize_description: prize,
        },
      },
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    expect(outcome.event.message?.text).toBe(prize);
    expect(outcome.event.message?.textSha256).toBe(await sha256Hex(prize));
    const dumped = JSON.stringify(outcome.event);
    expect(dumped).not.toContain(title);
    expect(dumped).not.toContain("-1001");
  });

  it("uses a finished giveaway prize description and drops winner names", async () => {
    const name = "中奖用户名";
    const prize = "加微信";
    const outcome = await normalize({
      update_id: 2204,
      message: {
        message_id: 44,
        date: 1761955200,
        chat: { id: -100713, type: "supergroup" },
        from: { id: 9 },
        giveaway_winners: {
          chat: { id: -1002, type: "channel", title: name },
          winners_selection_date: 1762000000,
          winner_count: 1,
          winners: [{ id: 4242, is_bot: false, first_name: name }],
          prize_description: prize,
        },
      },
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    expect(outcome.event.message?.text).toBe(prize);
    expect(outcome.event.message?.textSha256).toBe(await sha256Hex(prize));
    const dumped = JSON.stringify(outcome.event);
    expect(dumped).not.toContain(name);
    expect(dumped).not.toContain("4242");
  });

  it("uses a checklist title when text and caption are missing", async () => {
    const phrase = "请免费领取礼品";
    const code = "INVITECHECK99";
    const title = "免费领取";
    const outcome = await normalize({
      update_id: 2301,
      message: {
        message_id: 51,
        date: 1761955200,
        chat: { id: -100720, type: "supergroup" },
        from: { id: 9 },
        checklist: {
          title,
          title_entities: [
            {
              type: "text_link",
              offset: 0,
              length: title.length,
              url: `https://bit.ly/path?q=${phrase}`,
            },
            {
              type: "text_link",
              offset: 0,
              length: 1,
              url: `https://t.me/+${code}`,
            },
          ],
          tasks: [
            {
              id: 7,
              text: `${phrase} https://cutt.ly/task44`,
              text_entities: [
                {
                  type: "text_link",
                  offset: 0,
                  length: 2,
                  url: "https://evil.example/task",
                },
              ],
              completed_by_user: { id: 8, is_bot: false, first_name: phrase },
            },
          ],
        },
      },
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    expect(outcome.event.message?.text).toBe(title);
    expect(outcome.event.message?.textSha256).toBe(await sha256Hex(title));
    expect(outcome.event.message?.hosts).toEqual([
      "bit.ly",
      "t.me",
      "cutt.ly",
      "evil.example",
    ]);
    expect(outcome.event.message?.invites).toEqual(["t.me"]);
    const dumped = JSON.stringify(outcome.event);
    expect(dumped).not.toContain(phrase);
    expect(dumped).not.toContain(code);
    expect(dumped).not.toContain("/task");
  });

  it("keeps hostnames from question, prize, and checklist titles", async () => {
    const phrase = "请免费领取礼品";
    const code = "PLAIN52";
    const poll = await normalize({
      update_id: 2310,
      message: {
        message_id: 54,
        date: 1761955200,
        chat: { id: -100723, type: "supergroup" },
        from: { id: 9 },
        text: "今天站会",
        poll: {
          question: `${phrase} https://bit.ly/q52 https://t.me/+${code}.`,
          options: [
            {
              text: phrase,
              voter_count: 0,
              added_by_user: { id: 52, first_name: phrase },
            },
          ],
        },
      },
    });
    expect(poll.status).toBe("event");
    if (poll.status !== "event") {
      return;
    }
    expect(poll.event.message?.text).toBe("今天站会");
    expect(poll.event.message?.textSha256).toBe(await sha256Hex("今天站会"));
    expect(poll.event.message?.hosts).toEqual(["bit.ly", "t.me"]);
    expect(poll.event.message?.invites).toEqual(["t.me"]);
    const pollDump = JSON.stringify(poll.event);
    expect(pollDump).not.toContain(phrase);
    expect(pollDump).not.toContain(code);
    expect(pollDump).not.toContain("/q52");

    const giveaway = await normalize({
      update_id: 2311,
      message: {
        message_id: 55,
        date: 1761955200,
        chat: { id: -100724, type: "supergroup" },
        from: { id: 9 },
        text: "今天站会",
        giveaway: {
          chats: [{ id: -1001, type: "channel", title: phrase }],
          winners_selection_date: 1762000000,
          winner_count: 1,
          prize_description: `www.tinyurl.com/p52 https://t.me/%2B${code}`,
        },
      },
    });
    expect(giveaway.status).toBe("event");
    if (giveaway.status !== "event") {
      return;
    }
    expect(giveaway.event.message?.text).toBe("今天站会");
    expect(giveaway.event.message?.hosts).toEqual(["www.tinyurl.com", "t.me"]);
    expect(giveaway.event.message?.invites).toEqual(["t.me"]);
    const giveawayDump = JSON.stringify(giveaway.event);
    expect(giveawayDump).not.toContain(phrase);
    expect(giveawayDump).not.toContain(code);
    expect(giveawayDump).not.toContain("/p52");
    expect(giveawayDump).not.toContain("-1001");

    const winners = await normalize({
      update_id: 2312,
      message: {
        message_id: 56,
        date: 1761955200,
        chat: { id: -100725, type: "supergroup" },
        from: { id: 9 },
        caption: "今天站会",
        giveaway_winners: {
          chat: { id: -1002, type: "channel", title: phrase },
          winners_selection_date: 1762000000,
          winner_count: 1,
          winners: [{ id: 5252, is_bot: false, first_name: phrase }],
          prize_description: `https://cutt.ly/win52`,
        },
      },
    });
    expect(winners.status).toBe("event");
    if (winners.status !== "event") {
      return;
    }
    expect(winners.event.message?.text).toBe("今天站会");
    expect(winners.event.message?.hosts).toEqual(["cutt.ly"]);
    const winnersDump = JSON.stringify(winners.event);
    expect(winnersDump).not.toContain(phrase);
    expect(winnersDump).not.toContain("/win52");
    expect(winnersDump).not.toContain("5252");

    const checklist = await normalize({
      update_id: 2313,
      message: {
        message_id: 57,
        date: 1761955200,
        chat: { id: -100726, type: "supergroup" },
        from: { id: 9 },
        text: "今天站会",
        checklist: {
          title: `${phrase} https://is.gd/list52`,
          title_entities: [{ type: "bold", offset: 0, length: 2 }],
          tasks: [
            {
              id: 1,
              text: phrase,
              completed_by_user: { id: 52, first_name: phrase },
            },
          ],
        },
      },
    });
    expect(checklist.status).toBe("event");
    if (checklist.status !== "event") {
      return;
    }
    expect(checklist.event.message?.text).toBe("今天站会");
    expect(checklist.event.message?.hosts).toEqual(["is.gd"]);
    const checklistDump = JSON.stringify(checklist.event);
    expect(checklistDump).not.toContain(phrase);
    expect(checklistDump).not.toContain("/list52");

    const asBody = `免费领取 https://bit.ly/body52`;
    const body = await normalize({
      update_id: 2314,
      message: {
        message_id: 58,
        date: 1761955200,
        chat: { id: -100727, type: "supergroup" },
        from: { id: 9 },
        poll: {
          question: asBody,
          options: [{ text: phrase, voter_count: 0 }],
        },
      },
    });
    expect(body.status).toBe("event");
    if (body.status !== "event") {
      return;
    }
    expect(body.event.message?.text).toBe(asBody);
    expect(body.event.message?.textSha256).toBe(await sha256Hex(asBody));
    expect(body.event.message?.hosts).toEqual(["bit.ly"]);
    expect(JSON.stringify(body.event)).not.toContain(phrase);
  });

  it("keeps hostnames from poll options and descriptions", async () => {
    const phrase = "请免费领取礼品";
    const code = "POLLSIDE44";
    const encoded = "POLLENC44";
    const outcome = await normalize({
      update_id: 2303,
      message: {
        message_id: 53,
        date: 1761955200,
        chat: { id: -100722, type: "supergroup" },
        from: { id: 9 },
        poll: {
          question: "今天站会",
          options: [
            {
              text: `${phrase} https://bit.ly/opt44`,
              voter_count: 0,
              added_by_user: { id: 44, first_name: phrase },
            },
            {
              text: "甲",
              voter_count: 0,
              text_entities: [
                {
                  type: "text_link",
                  offset: 0,
                  length: 1,
                  url: "https://is.gd/hidden44",
                },
              ],
            },
          ],
          explanation: `${phrase} https://t.me/+${code}.`,
          explanation_entities: [
            {
              type: "text_link",
              offset: 0,
              length: 2,
              url: "https://tinyurl.com/ex44",
            },
          ],
          description: `${phrase} https://example.com/desc44`,
          description_entities: [
            {
              type: "text_link",
              offset: 0,
              length: 2,
              url: `https://t.me/%2B${encoded}`,
            },
          ],
          total_voter_count: 0,
          is_closed: false,
          is_anonymous: true,
          type: "regular",
          allows_multiple_answers: false,
        },
      },
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    expect(outcome.event.message?.text).toBe("今天站会");
    expect(outcome.event.message?.textSha256).toBe(await sha256Hex("今天站会"));
    expect(outcome.event.message?.hosts).toEqual([
      "bit.ly",
      "is.gd",
      "t.me",
      "tinyurl.com",
      "example.com",
    ]);
    expect(outcome.event.message?.invites).toEqual(["t.me"]);
    const dumped = JSON.stringify(outcome.event);
    expect(dumped).not.toContain(phrase);
    expect(dumped).not.toContain(code);
    expect(dumped).not.toContain(encoded);
    expect(dumped).not.toContain("/opt44");
    expect(dumped).not.toContain("/hidden44");
    expect(dumped).not.toContain("/ex44");
    expect(dumped).not.toContain("/desc44");
  });

  it("keeps a poll question when a checklist is also present", async () => {
    const outcome = await normalize({
      update_id: 2302,
      message: {
        message_id: 52,
        date: 1761955200,
        chat: { id: -100721, type: "supergroup" },
        from: { id: 9 },
        poll: {
          question: "今天站会",
          options: [{ text: "甲", voter_count: 0 }],
        },
        checklist: { title: "免费领取", tasks: [] },
      },
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    expect(outcome.event.message?.text).toBe("今天站会");
    const dumped = JSON.stringify(outcome.event);
    expect(dumped).not.toContain("免费领取");
  });

  it("uses a game title when earlier text is missing", async () => {
    const phrase = "请免费领取礼品";
    const title = "免费领取";
    const fileId = "GAMEFILEUNIQUE99";
    const outcome = await normalize({
      update_id: 2401,
      message: {
        message_id: 61,
        date: 1761955200,
        chat: { id: -100730, type: "supergroup" },
        from: { id: 9 },
        game: {
          title,
          description: `${phrase} https://evil.example/hide`,
          text: `${phrase} https://t.me/+GAME45.`,
          text_entities: [
            {
              type: "text_link",
              offset: 0,
              length: 2,
              url: "https://bit.ly/game",
            },
          ],
          photo: [
            { file_id: "abc", file_unique_id: fileId, width: 1, height: 1 },
          ],
        },
      },
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    expect(outcome.event.message?.text).toBe(title);
    expect(outcome.event.message?.textSha256).toBe(await sha256Hex(title));
    expect(outcome.event.message?.hosts).toEqual([
      "evil.example",
      "t.me",
      "bit.ly",
    ]);
    expect(outcome.event.message?.invites).toEqual(["t.me"]);
    expect(outcome.event.message?.media).toBeUndefined();
    const dumped = JSON.stringify(outcome.event);
    expect(dumped).not.toContain(phrase);
    expect(dumped).not.toContain("GAME45");
    expect(dumped).not.toContain("/game");
    expect(dumped).not.toContain("/hide");
    expect(dumped).not.toContain(fileId);
  });

  it("uses an invoice title when earlier text is missing", async () => {
    const phrase = "请免费领取礼品";
    const title = "加微信";
    const outcome = await normalize({
      update_id: 2402,
      message: {
        message_id: 62,
        date: 1761955200,
        chat: { id: -100731, type: "supergroup" },
        from: { id: 9 },
        invoice: {
          title,
          description: `${phrase} https://tinyurl.com/inv45`,
          start_parameter: phrase,
          currency: "XTR",
          total_amount: 1,
        },
      },
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    expect(outcome.event.message?.text).toBe(title);
    expect(outcome.event.message?.textSha256).toBe(await sha256Hex(title));
    expect(outcome.event.message?.hosts).toEqual(["tinyurl.com"]);
    const dumped = JSON.stringify(outcome.event);
    expect(dumped).not.toContain(phrase);
    expect(dumped).not.toContain("XTR");
    expect(dumped).not.toContain("/inv45");
  });

  it("keeps hostnames from game and invoice titles", async () => {
    const phrase = "请免费领取礼品";
    const code = "TITLE51";
    const fileId = "GAMEFILE51";
    const game = await normalize({
      update_id: 2410,
      message: {
        message_id: 64,
        date: 1761955200,
        chat: { id: -100733, type: "supergroup" },
        from: { id: 9 },
        text: "今天站会",
        game: {
          title: `${phrase} https://bit.ly/title51 https://t.me/+${code}.`,
          description: phrase,
          text: phrase,
          photo: [
            { file_id: "abc", file_unique_id: fileId, width: 1, height: 1 },
          ],
        },
      },
    });
    expect(game.status).toBe("event");
    if (game.status !== "event") {
      return;
    }
    expect(game.event.message?.text).toBe("今天站会");
    expect(game.event.message?.textSha256).toBe(await sha256Hex("今天站会"));
    expect(game.event.message?.hosts).toEqual(["bit.ly", "t.me"]);
    expect(game.event.message?.invites).toEqual(["t.me"]);
    const gameDump = JSON.stringify(game.event);
    expect(gameDump).not.toContain(phrase);
    expect(gameDump).not.toContain(code);
    expect(gameDump).not.toContain("/title51");
    expect(gameDump).not.toContain(fileId);

    const invoice = await normalize({
      update_id: 2411,
      message: {
        message_id: 65,
        date: 1761955200,
        chat: { id: -100734, type: "supergroup" },
        from: { id: 9 },
        text: "今天站会",
        invoice: {
          title: `www.tinyurl.com/v51 https://t.me/%2B${code}`,
          description: phrase,
          start_parameter: phrase,
          currency: "XTR",
          total_amount: 1,
        },
      },
    });
    expect(invoice.status).toBe("event");
    if (invoice.status !== "event") {
      return;
    }
    expect(invoice.event.message?.text).toBe("今天站会");
    expect(invoice.event.message?.textSha256).toBe(await sha256Hex("今天站会"));
    expect(invoice.event.message?.hosts).toEqual(["www.tinyurl.com", "t.me"]);
    expect(invoice.event.message?.invites).toEqual(["t.me"]);
    const invoiceDump = JSON.stringify(invoice.event);
    expect(invoiceDump).not.toContain(phrase);
    expect(invoiceDump).not.toContain(code);
    expect(invoiceDump).not.toContain("/v51");
    expect(invoiceDump).not.toContain("XTR");

    const asBody = "免费领取 https://bit.ly/body51";
    const body = await normalize({
      update_id: 2412,
      message: {
        message_id: 66,
        date: 1761955200,
        chat: { id: -100735, type: "supergroup" },
        from: { id: 9 },
        game: {
          title: asBody,
          description: phrase,
          photo: [],
        },
      },
    });
    expect(body.status).toBe("event");
    if (body.status !== "event") {
      return;
    }
    expect(body.event.message?.text).toBe(asBody);
    expect(body.event.message?.textSha256).toBe(await sha256Hex(asBody));
    expect(body.event.message?.hosts).toEqual(["bit.ly"]);
    const bodyDump = JSON.stringify(body.event);
    expect(bodyDump).not.toContain(phrase);
  });

  it("keeps a checklist title when a game is also present", async () => {
    const outcome = await normalize({
      update_id: 2403,
      message: {
        message_id: 63,
        date: 1761955200,
        chat: { id: -100732, type: "supergroup" },
        from: { id: 9 },
        checklist: { title: "今天站会", tasks: [] },
        game: { title: "免费领取", description: "说明", photo: [] },
      },
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    expect(outcome.event.message?.text).toBe("今天站会");
    const dumped = JSON.stringify(outcome.event);
    expect(dumped).not.toContain("免费领取");
  });

  it("keeps only the hostname of a link preview", async () => {
    const phrase = "请免费领取礼品";
    const code = "PREVIEW48";
    const outcome = await normalize({
      update_id: 2501,
      message: {
        message_id: 71,
        date: 1761955200,
        chat: { id: -100740, type: "supergroup" },
        from: { id: 9 },
        text: "今天站会",
        link_preview_options: {
          url: `https://bit.ly/preview?q=${phrase}`,
          prefer_small_media: true,
          show_above_text: true,
        },
      },
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    expect(outcome.event.message?.text).toBe("今天站会");
    expect(outcome.event.message?.textSha256).toBe(await sha256Hex("今天站会"));
    expect(outcome.event.message?.hosts).toEqual(["bit.ly"]);
    const dumped = JSON.stringify(outcome.event);
    expect(dumped).not.toContain(phrase);
    expect(dumped).not.toContain("/preview");
    expect(dumped).not.toContain("prefer_small_media");
    expect(dumped).not.toContain("show_above_text");

    const invite = await normalize({
      update_id: 2502,
      message: {
        message_id: 72,
        date: 1761955200,
        chat: { id: -100741, type: "supergroup" },
        from: { id: 9 },
        text: "今天站会",
        link_preview_options: {
          url: `https://t.me/%2B${code}`,
        },
        external_reply: {
          origin: { type: "hidden_user", sender_user_name: phrase },
          link_preview_options: { url: "https://tinyurl.com/other" },
        },
      },
    });
    expect(invite.status).toBe("event");
    if (invite.status !== "event") {
      return;
    }
    expect(invite.event.message?.text).toBe("今天站会");
    expect(invite.event.message?.hosts).toEqual(["t.me"]);
    expect(invite.event.message?.invites).toEqual(["t.me"]);
    const inviteDump = JSON.stringify(invite.event);
    expect(inviteDump).not.toContain(phrase);
    expect(inviteDump).not.toContain(code);
    expect(inviteDump).not.toContain("tinyurl.com");
  });

  it("uses a venue title when earlier text is missing", async () => {
    const phrase = "请免费领取礼品";
    const title = "免费领取";
    const placeId = "PLACEIDSECRET99";
    const outcome = await normalize({
      update_id: 2501,
      message: {
        message_id: 71,
        date: 1761955200,
        chat: { id: -100740, type: "supergroup" },
        from: { id: 9 },
        venue: {
          location: { latitude: 31.2304, longitude: 121.4737 },
          title,
          address: phrase,
          google_place_id: placeId,
          foursquare_id: placeId,
        },
      },
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    expect(outcome.event.message?.text).toBe(title);
    expect(outcome.event.message?.textSha256).toBe(await sha256Hex(title));
    const dumped = JSON.stringify(outcome.event);
    expect(dumped).not.toContain(phrase);
    expect(dumped).not.toContain(placeId);
    expect(dumped).not.toContain("31.2304");
    expect(dumped).not.toContain("121.4737");
  });

  it("leaves a bare location without coordinates in the event", async () => {
    const outcome = await normalize({
      update_id: 2502,
      message: {
        message_id: 72,
        date: 1761955200,
        chat: { id: -100741, type: "supergroup" },
        from: { id: 9 },
        location: { latitude: 31.2304, longitude: 121.4737 },
      },
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    expect(outcome.event.message?.text).toBe("");
    const dumped = JSON.stringify(outcome.event);
    expect(dumped).not.toContain("31.2304");
    expect(dumped).not.toContain("121.4737");
  });

  it("keeps only the hostname from a venue address", async () => {
    const phrase = "请免费领取礼品";
    const code = "VENUE48";
    const placeId = "PLACEIDSECRET48";
    const outcome = await normalize({
      update_id: 2510,
      message: {
        message_id: 74,
        date: 1761955200,
        chat: { id: -100745, type: "supergroup" },
        from: { id: 9 },
        text: "今天站会",
        venue: {
          location: { latitude: 31.2304, longitude: 121.4737 },
          title: "免费领取",
          address: `${phrase} https://bit.ly/addr48 https://t.me/+${code}.`,
          google_place_id: placeId,
          foursquare_id: placeId,
          foursquare_type: "https://tinyurl.com/type48",
          google_place_type: "https://is.gd/type48",
        },
      },
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    expect(outcome.event.message?.text).toBe("今天站会");
    expect(outcome.event.message?.textSha256).toBe(await sha256Hex("今天站会"));
    expect(outcome.event.message?.hosts).toEqual(["bit.ly", "t.me"]);
    expect(outcome.event.message?.invites).toEqual(["t.me"]);
    const dumped = JSON.stringify(outcome.event);
    expect(dumped).not.toContain(phrase);
    expect(dumped).not.toContain(code);
    expect(dumped).not.toContain("/addr48");
    expect(dumped).not.toContain(placeId);
    expect(dumped).not.toContain("31.2304");
    expect(dumped).not.toContain("tinyurl.com");
    expect(dumped).not.toContain("is.gd");

    const encoded = await normalize({
      update_id: 2511,
      message: {
        message_id: 75,
        date: 1761955200,
        chat: { id: -100746, type: "supergroup" },
        from: { id: 9 },
        venue: {
          location: { latitude: 1.5, longitude: 2.5 },
          title: "今天站会",
          address: `${phrase} www.tinyurl.com/v48 https://t.me/%2B${code}`,
        },
      },
    });
    expect(encoded.status).toBe("event");
    if (encoded.status !== "event") {
      return;
    }
    expect(encoded.event.message?.text).toBe("今天站会");
    expect(encoded.event.message?.textSha256).toBe(await sha256Hex("今天站会"));
    expect(encoded.event.message?.hosts).toEqual(["www.tinyurl.com", "t.me"]);
    expect(encoded.event.message?.invites).toEqual(["t.me"]);
    const encodedDump = JSON.stringify(encoded.event);
    expect(encodedDump).not.toContain(phrase);
    expect(encodedDump).not.toContain(code);
    expect(encodedDump).not.toContain("/v48");
    expect(encodedDump).not.toContain("1.5");
  });

  it("keeps only the hostname from a venue title", async () => {
    const phrase = "请免费领取礼品";
    const code = "TITLE50";
    const placeId = "PLACEIDSECRET50";
    const outcome = await normalize({
      update_id: 2512,
      message: {
        message_id: 76,
        date: 1761955200,
        chat: { id: -100747, type: "supergroup" },
        from: { id: 9 },
        text: "今天站会",
        venue: {
          location: { latitude: 31.2304, longitude: 121.4737 },
          title: `${phrase} https://bit.ly/title50 https://t.me/+${code}.`,
          address: `${phrase} 南京东路 1 号`,
          google_place_id: placeId,
          foursquare_id: placeId,
          foursquare_type: "https://tinyurl.com/type50",
        },
      },
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    expect(outcome.event.message?.text).toBe("今天站会");
    expect(outcome.event.message?.textSha256).toBe(await sha256Hex("今天站会"));
    expect(outcome.event.message?.hosts).toEqual(["bit.ly", "t.me"]);
    expect(outcome.event.message?.invites).toEqual(["t.me"]);
    const dumped = JSON.stringify(outcome.event);
    expect(dumped).not.toContain(phrase);
    expect(dumped).not.toContain(code);
    expect(dumped).not.toContain("/title50");
    expect(dumped).not.toContain(placeId);
    expect(dumped).not.toContain("31.2304");
    expect(dumped).not.toContain("南京东路");
    expect(dumped).not.toContain("tinyurl.com");

    const encoded = await normalize({
      update_id: 2513,
      message: {
        message_id: 77,
        date: 1761955200,
        chat: { id: -100748, type: "supergroup" },
        from: { id: 9 },
        text: "今天站会",
        venue: {
          location: { latitude: 1.5, longitude: 2.5 },
          title: `www.tinyurl.com/v50 https://t.me/%2B${code}`,
          address: phrase,
          google_place_type: "https://is.gd/type50",
        },
      },
    });
    expect(encoded.status).toBe("event");
    if (encoded.status !== "event") {
      return;
    }
    expect(encoded.event.message?.text).toBe("今天站会");
    expect(encoded.event.message?.textSha256).toBe(await sha256Hex("今天站会"));
    expect(encoded.event.message?.hosts).toEqual(["www.tinyurl.com", "t.me"]);
    expect(encoded.event.message?.invites).toEqual(["t.me"]);
    const encodedDump = JSON.stringify(encoded.event);
    expect(encodedDump).not.toContain(phrase);
    expect(encodedDump).not.toContain(code);
    expect(encodedDump).not.toContain("/v50");
    expect(encodedDump).not.toContain("is.gd");
    expect(encodedDump).not.toContain("1.5");
  });

  it("keeps an invoice title when a venue is also present", async () => {
    const outcome = await normalize({
      update_id: 2503,
      message: {
        message_id: 73,
        date: 1761955200,
        chat: { id: -100742, type: "supergroup" },
        from: { id: 9 },
        invoice: {
          title: "今天站会",
          description: "说明",
          start_parameter: "meet",
          currency: "XTR",
          total_amount: 1,
        },
        venue: {
          location: { latitude: 1, longitude: 2 },
          title: "免费领取",
          address: "路",
        },
      },
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    expect(outcome.event.message?.text).toBe("今天站会");
    const dumped = JSON.stringify(outcome.event);
    expect(dumped).not.toContain("免费领取");
  });

  it("uses a manual quote when earlier text is missing", async () => {
    const phrase = "请免费领取礼品";
    const code = "INVITEQUOTE99";
    const quoted = "免费领取";
    const outcome = await normalize({
      update_id: 2601,
      message: {
        message_id: 81,
        date: 1761955200,
        chat: { id: -100750, type: "supergroup" },
        from: { id: 9 },
        quote: {
          text: quoted,
          position: 3,
          is_manual: true,
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: quoted.length,
              url: `https://bit.ly/path?q=${phrase}`,
            },
            {
              type: "text_link",
              offset: 0,
              length: 1,
              url: `https://t.me/+${code}`,
            },
          ],
        },
      },
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    expect(outcome.event.message?.text).toBe(quoted);
    expect(outcome.event.message?.textSha256).toBe(await sha256Hex(quoted));
    expect(outcome.event.message?.hosts).toEqual(["bit.ly", "t.me"]);
    expect(outcome.event.message?.invites).toEqual(["t.me"]);
    const dumped = JSON.stringify(outcome.event);
    expect(dumped).not.toContain(phrase);
    expect(dumped).not.toContain(code);
    expect(dumped).not.toContain('"position"');
  });

  it("leaves an automatic quote out of the event", async () => {
    const outcome = await normalize({
      update_id: 2602,
      message: {
        message_id: 82,
        date: 1761955200,
        chat: { id: -100751, type: "supergroup" },
        from: { id: 9 },
        quote: {
          text: "免费领取",
          position: 0,
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 2,
              url: "https://bit.ly/auto",
            },
          ],
        },
        reply_to_message: {
          message_id: 1,
          text: "免费领取",
        },
      },
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    expect(outcome.event.message?.text).toBe("");
    expect(outcome.event.message?.hosts).toBeUndefined();
    const dumped = JSON.stringify(outcome.event);
    expect(dumped).not.toContain("免费领取");
    expect(dumped).not.toContain("bit.ly");
  });

  it("keeps the message text when a manual quote is also present", async () => {
    const outcome = await normalize({
      update_id: 2603,
      message: {
        message_id: 83,
        date: 1761955200,
        chat: { id: -100752, type: "supergroup" },
        from: { id: 9 },
        text: "今天站会",
        quote: {
          text: "免费领取",
          position: 0,
          is_manual: true,
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 2,
              url: "https://bit.ly/quoted",
            },
          ],
        },
      },
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    expect(outcome.event.message?.text).toBe("今天站会");
    expect(outcome.event.message?.hosts).toEqual(["bit.ly"]);
    const dumped = JSON.stringify(outcome.event);
    expect(dumped).not.toContain("免费领取");
    expect(dumped).not.toContain("/quoted");
  });

  it("keeps hostnames from a manual quote when text exists", async () => {
    const phrase = "请免费领取礼品";
    const code = "QUOTE54";
    const manual = await normalize({
      update_id: 2610,
      message: {
        message_id: 84,
        date: 1761955200,
        chat: { id: -100753, type: "supergroup" },
        from: { id: 9 },
        text: "今天站会",
        quote: {
          text: `${phrase} https://bit.ly/q54 https://t.me/+${code}.`,
          position: 4,
          is_manual: true,
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 2,
              url: "https://www.tinyurl.com/qt54",
            },
          ],
        },
        reply_to_message: {
          message_id: 1,
          text: `${phrase} https://example.com/reply54`,
        },
      },
    });
    expect(manual.status).toBe("event");
    if (manual.status !== "event") {
      return;
    }
    expect(manual.event.message?.text).toBe("今天站会");
    expect(manual.event.message?.textSha256).toBe(await sha256Hex("今天站会"));
    expect(manual.event.message?.hosts).toEqual([
      "bit.ly",
      "t.me",
      "www.tinyurl.com",
    ]);
    expect(manual.event.message?.invites).toEqual(["t.me"]);
    const manualDump = JSON.stringify(manual.event);
    expect(manualDump).not.toContain(phrase);
    expect(manualDump).not.toContain(code);
    expect(manualDump).not.toContain("/q54");
    expect(manualDump).not.toContain("/qt54");
    expect(manualDump).not.toContain("example.com");
    expect(manualDump).not.toContain('"position"');

    const automatic = await normalize({
      update_id: 2611,
      message: {
        message_id: 85,
        date: 1761955200,
        chat: { id: -100754, type: "supergroup" },
        from: { id: 9 },
        text: "今天站会",
        quote: {
          text: `${phrase} https://bit.ly/auto54`,
          position: 0,
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 2,
              url: "https://tinyurl.com/auto54",
            },
          ],
        },
        external_reply: {
          origin: { type: "user", sender_user_name: phrase },
          quote: {
            text: "https://is.gd/ext54",
            is_manual: true,
          },
        },
      },
    });
    expect(automatic.status).toBe("event");
    if (automatic.status !== "event") {
      return;
    }
    expect(automatic.event.message?.text).toBe("今天站会");
    expect(automatic.event.message?.hosts).toBeUndefined();
    const automaticDump = JSON.stringify(automatic.event);
    expect(automaticDump).not.toContain(phrase);
    expect(automaticDump).not.toContain("bit.ly");
    expect(automaticDump).not.toContain("tinyurl.com");
    expect(automaticDump).not.toContain("is.gd");

    const asBody = "免费领取 https://bit.ly/body54";
    const body = await normalize({
      update_id: 2612,
      message: {
        message_id: 86,
        date: 1761955200,
        chat: { id: -100755, type: "supergroup" },
        from: { id: 9 },
        quote: {
          text: asBody,
          position: 1,
          is_manual: true,
        },
      },
    });
    expect(body.status).toBe("event");
    if (body.status !== "event") {
      return;
    }
    expect(body.event.message?.text).toBe(asBody);
    expect(body.event.message?.textSha256).toBe(await sha256Hex(asBody));
    expect(body.event.message?.hosts).toEqual(["bit.ly"]);
  });

  it("keeps hostnames from media file names and audio titles", async () => {
    const phrase = "请免费领取礼品";
    const code = "FILE53";
    const fileId = "DOCFILE53";
    const document = await normalize({
      update_id: 2710,
      message: {
        message_id: 92,
        date: 1761955200,
        chat: { id: -100761, type: "supergroup" },
        from: { id: 9 },
        text: "今天站会",
        document: {
          file_id: fileId,
          file_unique_id: fileId,
          mime_type: phrase,
          file_name: `${phrase} https://bit.ly/doc53.pdf https://t.me/+${code}.`,
        },
      },
    });
    expect(document.status).toBe("event");
    if (document.status !== "event") {
      return;
    }
    expect(document.event.message?.text).toBe("今天站会");
    expect(document.event.message?.textSha256).toBe(
      await sha256Hex("今天站会"),
    );
    expect(document.event.message?.hosts).toEqual(["bit.ly", "t.me"]);
    expect(document.event.message?.invites).toEqual(["t.me"]);
    const documentDump = JSON.stringify(document.event);
    expect(documentDump).not.toContain(phrase);
    expect(documentDump).not.toContain(code);
    expect(documentDump).not.toContain("/doc53");
    expect(documentDump).not.toContain(fileId);

    const audio = await normalize({
      update_id: 2711,
      message: {
        message_id: 93,
        date: 1761955200,
        chat: { id: -100762, type: "supergroup" },
        from: { id: 9 },
        text: "今天站会",
        audio: {
          file_id: fileId,
          file_unique_id: fileId,
          duration: 3,
          title: `www.tinyurl.com/a53`,
          file_name: `https://t.me/%2B${code}`,
          performer: `https://is.gd/perf53`,
        },
      },
    });
    expect(audio.status).toBe("event");
    if (audio.status !== "event") {
      return;
    }
    expect(audio.event.message?.text).toBe("今天站会");
    expect(audio.event.message?.hosts).toEqual([
      "www.tinyurl.com",
      "t.me",
      "is.gd",
    ]);
    expect(audio.event.message?.invites).toEqual(["t.me"]);
    const audioDump = JSON.stringify(audio.event);
    expect(audioDump).not.toContain(code);
    expect(audioDump).not.toContain("/a53");
    expect(audioDump).not.toContain("perf53");
    expect(audioDump).not.toContain(fileId);

    const clips = await normalize({
      update_id: 2712,
      message: {
        message_id: 94,
        date: 1761955200,
        chat: { id: -100763, type: "supergroup" },
        from: { id: 9 },
        caption: "今天站会",
        animation: {
          file_id: fileId,
          file_unique_id: fileId,
          width: 1,
          height: 1,
          duration: 1,
          file_name: "https://cutt.ly/anim53.gif",
        },
        video: {
          file_id: fileId,
          file_unique_id: fileId,
          width: 1,
          height: 1,
          duration: 1,
          file_name: "https://example.com/vid53.mp4",
        },
      },
    });
    expect(clips.status).toBe("event");
    if (clips.status !== "event") {
      return;
    }
    expect(clips.event.message?.text).toBe("今天站会");
    expect(clips.event.message?.hosts).toEqual(["cutt.ly", "example.com"]);
    const clipsDump = JSON.stringify(clips.event);
    expect(clipsDump).not.toContain("/anim53");
    expect(clipsDump).not.toContain("/vid53");
    expect(clipsDump).not.toContain(fileId);

    const asBody = "免费领取 https://bit.ly/body53.pdf";
    const body = await normalize({
      update_id: 2713,
      message: {
        message_id: 95,
        date: 1761955200,
        chat: { id: -100764, type: "supergroup" },
        from: { id: 9 },
        document: {
          file_id: fileId,
          file_unique_id: fileId,
          file_name: asBody,
        },
      },
    });
    expect(body.status).toBe("event");
    if (body.status !== "event") {
      return;
    }
    expect(body.event.message?.text).toBe(asBody);
    expect(body.event.message?.textSha256).toBe(await sha256Hex(asBody));
    expect(body.event.message?.hosts).toEqual(["bit.ly"]);
    expect(JSON.stringify(body.event)).not.toContain(fileId);

    const sticker = await normalize({
      update_id: 2714,
      message: {
        message_id: 96,
        date: 1761955200,
        chat: { id: -100765, type: "supergroup" },
        from: { id: 9 },
        text: "今天站会",
        sticker: {
          file_id: fileId,
          file_unique_id: fileId,
          type: "regular",
          width: 1,
          height: 1,
          is_animated: false,
          is_video: false,
          set_name: "https://bit.ly/set53",
          emoji: phrase,
        },
      },
    });
    expect(sticker.status).toBe("event");
    if (sticker.status !== "event") {
      return;
    }
    expect(sticker.event.message?.text).toBe("今天站会");
    expect(sticker.event.message?.hosts).toBeUndefined();
    const stickerDump = JSON.stringify(sticker.event);
    expect(stickerDump).not.toContain("bit.ly");
    expect(stickerDump).not.toContain(phrase);
    expect(stickerDump).not.toContain("set53");
  });

  it("uses a document file name when earlier text is missing", async () => {
    const phrase = "请免费领取礼品";
    const fileName = "免费领取.pdf";
    const outcome = await normalize({
      update_id: 2701,
      message: {
        message_id: 91,
        date: 1761955200,
        chat: { id: -100760, type: "supergroup" },
        from: { id: 9 },
        document: {
          file_id: phrase,
          file_unique_id: "doc-91",
          mime_type: phrase,
          file_name: fileName,
          thumbnail: {
            file_id: phrase,
            file_unique_id: phrase,
            width: 1,
            height: 1,
          },
        },
      },
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    expect(outcome.event.message?.text).toBe(fileName);
    expect(outcome.event.message?.textSha256).toBe(await sha256Hex(fileName));
    expect(outcome.event.message?.media).toBe("document");
    expect(outcome.event.message?.mediaSha256).toBe(
      await sha256Hex("document\ndoc-91"),
    );
    const dumped = JSON.stringify(outcome.event);
    expect(dumped).not.toContain(phrase);
    expect(dumped).not.toContain("doc-91");
  });

  it("uses an audio title and leaves the performer out", async () => {
    const phrase = "请免费领取礼品";
    const outcome = await normalize({
      update_id: 2702,
      message: {
        message_id: 92,
        date: 1761955200,
        chat: { id: -100761, type: "supergroup" },
        from: { id: 9 },
        audio: {
          duration: 3,
          title: "免费领取",
          file_name: "加微信.mp3",
          performer: phrase,
          mime_type: "audio/mpeg",
          file_id: phrase,
          file_unique_id: "aud-92",
        },
      },
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    expect(outcome.event.message?.text).toBe("免费领取");
    expect(outcome.event.message?.textSha256).toBe(await sha256Hex("免费领取"));
    const dumped = JSON.stringify(outcome.event);
    expect(dumped).not.toContain("加微信");
    expect(dumped).not.toContain(phrase);
    expect(dumped).not.toContain("aud-92");
  });

  it("uses an audio file name when the title is missing", async () => {
    const outcome = await normalize({
      update_id: 2703,
      message: {
        message_id: 93,
        date: 1761955200,
        chat: { id: -100762, type: "supergroup" },
        from: { id: 9 },
        audio: {
          duration: 3,
          file_name: "免费领取.mp3",
          performer: "请免费领取礼品",
          file_unique_id: "aud-93",
        },
      },
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    expect(outcome.event.message?.text).toBe("免费领取.mp3");
    const dumped = JSON.stringify(outcome.event);
    expect(dumped).not.toContain("请免费领取礼品");
  });

  it("keeps the caption when a document file name is also present", async () => {
    const outcome = await normalize({
      update_id: 2704,
      message: {
        message_id: 94,
        date: 1761955200,
        chat: { id: -100763, type: "supergroup" },
        from: { id: 9 },
        caption: "今天站会",
        document: {
          file_name: "免费领取.pdf",
          file_unique_id: "doc-94",
        },
      },
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    expect(outcome.event.message?.text).toBe("今天站会");
    const dumped = JSON.stringify(outcome.event);
    expect(dumped).not.toContain("免费领取");
  });

  it("uses a file name before a manual quote", async () => {
    const outcome = await normalize({
      update_id: 2705,
      message: {
        message_id: 95,
        date: 1761955200,
        chat: { id: -100764, type: "supergroup" },
        from: { id: 9 },
        document: {
          file_name: "今天站会.pdf",
          file_unique_id: "doc-95",
        },
        quote: {
          text: "免费领取",
          position: 0,
          is_manual: true,
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 2,
              url: "https://bit.ly/quoted",
            },
          ],
        },
      },
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    expect(outcome.event.message?.text).toBe("今天站会.pdf");
    expect(outcome.event.message?.hosts).toEqual(["bit.ly"]);
    const dumped = JSON.stringify(outcome.event);
    expect(dumped).not.toContain("免费领取");
    expect(dumped).not.toContain("/quoted");
  });

  it("keeps a venue title when a document file name is also present", async () => {
    const outcome = await normalize({
      update_id: 2706,
      message: {
        message_id: 96,
        date: 1761955200,
        chat: { id: -100765, type: "supergroup" },
        from: { id: 9 },
        venue: {
          location: { latitude: 1, longitude: 2 },
          title: "今天站会",
          address: "路",
        },
        document: {
          file_name: "免费领取.pdf",
          file_unique_id: "doc-96",
        },
      },
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    expect(outcome.event.message?.text).toBe("今天站会");
    const dumped = JSON.stringify(outcome.event);
    expect(dumped).not.toContain("免费领取");
  });

  it("uses an animation file name before a video file name", async () => {
    const outcome = await normalize({
      update_id: 2709,
      message: {
        message_id: 99,
        date: 1761955200,
        chat: { id: -100768, type: "supergroup" },
        from: { id: 9 },
        animation: {
          file_name: "免费领取.mp4",
          file_unique_id: "an-99",
        },
        video: {
          file_name: "加微信.mp4",
          file_unique_id: "vid-99",
        },
      },
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    expect(outcome.event.message?.text).toBe("免费领取.mp4");
    expect(outcome.event.message?.media).toBe("animation");
    const dumped = JSON.stringify(outcome.event);
    expect(dumped).not.toContain("加微信");
    expect(dumped).not.toContain("an-99");
    expect(dumped).not.toContain("vid-99");
  });

  it("leaves sticker names and unlabeled voice out of the text", async () => {
    const sticker = await normalize({
      update_id: 2707,
      message: {
        message_id: 97,
        date: 1761955200,
        chat: { id: -100766, type: "supergroup" },
        from: { id: 9 },
        sticker: {
          file_unique_id: "stk-97",
          width: 64,
          height: 64,
          emoji: "😀",
          set_name: "免费领取",
        },
      },
    });
    const voice = await normalize({
      update_id: 2708,
      message: {
        message_id: 98,
        date: 1761955200,
        chat: { id: -100767, type: "supergroup" },
        from: { id: 9 },
        voice: { duration: 1, file_unique_id: "voice-98" },
      },
    });
    expect(sticker.status).toBe("event");
    expect(voice.status).toBe("event");
    if (sticker.status !== "event" || voice.status !== "event") {
      return;
    }
    expect(sticker.event.message?.text).toBe("");
    expect(voice.event.message?.text).toBe("");
    expect(JSON.stringify(sticker.event)).not.toContain("免费领取");
    expect(JSON.stringify(sticker.event)).not.toContain("stk-97");
  });

  it("keeps hostnames from inline button labels", async () => {
    const phrase = "请免费领取礼品";
    const code = "BTN55";
    const labeled = await normalize({
      update_id: 2810,
      message: {
        message_id: 106,
        date: 1761955200,
        chat: { id: -100775, type: "supergroup" },
        from: { id: 9 },
        text: "今天站会",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: `${phrase} https://bit.ly/btn55 https://t.me/+${code}.`,
                url: "https://example.com/ok55",
              },
              {
                text: "跳过",
                callback_data: "https://tinyurl.com/cb55",
              },
            ],
          ],
          keyboard: [[{ text: "https://is.gd/key55" }]],
        },
      },
    });
    expect(labeled.status).toBe("event");
    if (labeled.status !== "event") {
      return;
    }
    expect(labeled.event.message?.text).toBe("今天站会");
    expect(labeled.event.message?.textSha256).toBe(await sha256Hex("今天站会"));
    expect(labeled.event.message?.hosts).toEqual([
      "bit.ly",
      "t.me",
      "example.com",
    ]);
    expect(labeled.event.message?.invites).toEqual(["t.me"]);
    const labeledDump = JSON.stringify(labeled.event);
    expect(labeledDump).not.toContain(phrase);
    expect(labeledDump).not.toContain(code);
    expect(labeledDump).not.toContain("/btn55");
    expect(labeledDump).not.toContain("/ok55");
    expect(labeledDump).not.toContain("tinyurl.com");
    expect(labeledDump).not.toContain("is.gd");

    const hidden = await normalize({
      update_id: 2811,
      message: {
        message_id: 107,
        date: 1761955200,
        chat: { id: -100776, type: "supergroup" },
        from: { id: 9 },
        text: "今天站会",
        reply_markup: {
          inline_keyboard: [
            [{ text: phrase, callback_data: "https://bit.ly/onlycb55" }],
          ],
          keyboard: [[{ text: `https://tinyurl.com/${code}` }]],
        },
      },
    });
    expect(hidden.status).toBe("event");
    if (hidden.status !== "event") {
      return;
    }
    expect(hidden.event.message?.text).toBe("今天站会");
    expect(hidden.event.message?.hosts).toBeUndefined();
    const hiddenDump = JSON.stringify(hidden.event);
    expect(hiddenDump).not.toContain(phrase);
    expect(hiddenDump).not.toContain("bit.ly");
    expect(hiddenDump).not.toContain("tinyurl.com");
    expect(hiddenDump).not.toContain(code);

    const asBody = "免费领取 https://bit.ly/body55";
    const body = await normalize({
      update_id: 2812,
      message: {
        message_id: 108,
        date: 1761955200,
        chat: { id: -100777, type: "supergroup" },
        from: { id: 9 },
        reply_markup: {
          inline_keyboard: [[{ text: asBody }, { text: "今天站会" }]],
        },
      },
    });
    expect(body.status).toBe("event");
    if (body.status !== "event") {
      return;
    }
    expect(body.event.message?.text).toBe(`${asBody} 今天站会`);
    expect(body.event.message?.textSha256).toBe(
      await sha256Hex(`${asBody} 今天站会`),
    );
    expect(body.event.message?.hosts).toEqual(["bit.ly"]);
  });

  it("keeps hostnames from gift messages", async () => {
    const phrase = "请免费领取礼品";
    const code = "GIFT56";
    const labeled = await normalize({
      update_id: 2910,
      message: {
        message_id: 110,
        date: 1761955200,
        chat: { id: -100785, type: "supergroup" },
        from: { id: 9 },
        text: "今天站会",
        gift: {
          gift: {
            id: "g56",
            sticker: {
              file_id: "FILE56",
              file_unique_id: "UNIQ56",
              set_name: "https://tinyurl.com/stk56",
            },
            star_count: 56,
          },
          text: `${phrase} https://bit.ly/gift56 https://t.me/+${code}.`,
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 1,
              url: "https://example.com/ent56",
            },
          ],
        },
      },
    });
    expect(labeled.status).toBe("event");
    if (labeled.status !== "event") {
      return;
    }
    expect(labeled.event.message?.text).toBe("今天站会");
    expect(labeled.event.message?.textSha256).toBe(await sha256Hex("今天站会"));
    expect(labeled.event.message?.hosts).toEqual([
      "bit.ly",
      "t.me",
      "example.com",
    ]);
    expect(labeled.event.message?.invites).toEqual(["t.me"]);
    const labeledDump = JSON.stringify(labeled.event);
    expect(labeledDump).not.toContain(phrase);
    expect(labeledDump).not.toContain(code);
    expect(labeledDump).not.toContain("gift56");
    expect(labeledDump).not.toContain("ent56");
    expect(labeledDump).not.toContain("tinyurl.com");
    expect(labeledDump).not.toContain("FILE56");
    expect(labeledDump).not.toContain("UNIQ56");

    const upgraded = await normalize({
      update_id: 2911,
      message: {
        message_id: 111,
        date: 1761955200,
        chat: { id: -100786, type: "supergroup" },
        from: { id: 9 },
        text: "今天站会",
        unique_gift: {
          gift: { name: "NFT56" },
          origin: "transfer",
          text: phrase,
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 1,
              url: "https://t.me/%2BGIFT56",
            },
          ],
          last_resale_currency: "XTR",
          last_resale_amount: 56,
        },
      },
    });
    expect(upgraded.status).toBe("event");
    if (upgraded.status !== "event") {
      return;
    }
    expect(upgraded.event.message?.text).toBe("今天站会");
    expect(upgraded.event.message?.textSha256).toBe(
      await sha256Hex("今天站会"),
    );
    expect(upgraded.event.message?.hosts).toEqual(["t.me"]);
    expect(upgraded.event.message?.invites).toEqual(["t.me"]);
    const upgradedDump = JSON.stringify(upgraded.event);
    expect(upgradedDump).not.toContain(phrase);
    expect(upgradedDump).not.toContain(code);
    expect(upgradedDump).not.toContain("NFT56");
    expect(upgradedDump).not.toContain("XTR");

    const ordinary = await normalize({
      update_id: 2912,
      message: {
        message_id: 112,
        date: 1761955200,
        chat: { id: -100787, type: "supergroup" },
        from: { id: 9 },
        text: "今天站会",
        gift_upgrade_sent: {
          text: `${phrase} https://example.com/page56`,
        },
      },
    });
    expect(ordinary.status).toBe("event");
    if (ordinary.status !== "event") {
      return;
    }
    expect(ordinary.event.message?.text).toBe("今天站会");
    expect(ordinary.event.message?.hosts).toEqual(["example.com"]);
    const ordinaryDump = JSON.stringify(ordinary.event);
    expect(ordinaryDump).not.toContain(phrase);
    expect(ordinaryDump).not.toContain("page56");

    const asBody = "免费领取 https://bit.ly/body56";
    const body = await normalize({
      update_id: 2913,
      message: {
        message_id: 113,
        date: 1761955200,
        chat: { id: -100788, type: "supergroup" },
        from: { id: 9 },
        gift: { text: asBody, is_private: true },
      },
    });
    expect(body.status).toBe("event");
    if (body.status !== "event") {
      return;
    }
    expect(body.event.message?.text).toBe(asBody);
    expect(body.event.message?.textSha256).toBe(await sha256Hex(asBody));
    expect(body.event.message?.hosts).toEqual(["bit.ly"]);
  });

  it("keeps hostnames from forum topic names", async () => {
    const phrase = "请免费领取礼品";
    const code = "TOPIC57";
    const created = await normalize({
      update_id: 3010,
      message: {
        message_id: 120,
        date: 1761955200,
        chat: { id: -100800, type: "supergroup" },
        from: { id: 9 },
        text: "今天站会",
        forum_topic_created: {
          name: `${phrase} https://bit.ly/topic57 https://t.me/+${code}.`,
          icon_color: 9367192,
          icon_custom_emoji_id: "https://tinyurl.com/icon57",
        },
      },
    });
    expect(created.status).toBe("event");
    if (created.status !== "event") {
      return;
    }
    expect(created.event.message?.text).toBe("今天站会");
    expect(created.event.message?.textSha256).toBe(await sha256Hex("今天站会"));
    expect(created.event.message?.hosts).toEqual(["bit.ly", "t.me"]);
    expect(created.event.message?.invites).toEqual(["t.me"]);
    const createdDump = JSON.stringify(created.event);
    expect(createdDump).not.toContain(phrase);
    expect(createdDump).not.toContain(code);
    expect(createdDump).not.toContain("topic57");
    expect(createdDump).not.toContain("tinyurl.com");
    expect(createdDump).not.toContain("icon57");

    const edited = await normalize({
      update_id: 3011,
      message: {
        message_id: 121,
        date: 1761955200,
        chat: { id: -100801, type: "supergroup" },
        from: { id: 9 },
        text: "今天站会",
        forum_topic_edited: {
          name: `${phrase} https://example.com/page57`,
          icon_custom_emoji_id: "emoji57",
        },
      },
    });
    expect(edited.status).toBe("event");
    if (edited.status !== "event") {
      return;
    }
    expect(edited.event.message?.text).toBe("今天站会");
    expect(edited.event.message?.textSha256).toBe(await sha256Hex("今天站会"));
    expect(edited.event.message?.hosts).toEqual(["example.com"]);
    const editedDump = JSON.stringify(edited.event);
    expect(editedDump).not.toContain(phrase);
    expect(editedDump).not.toContain("page57");
    expect(editedDump).not.toContain("emoji57");

    const iconOnly = await normalize({
      update_id: 3012,
      message: {
        message_id: 122,
        date: 1761955200,
        chat: { id: -100802, type: "supergroup" },
        from: { id: 9 },
        text: "今天站会",
        forum_topic_edited: {
          icon_custom_emoji_id: "https://bit.ly/icon57",
        },
      },
    });
    expect(iconOnly.status).toBe("event");
    if (iconOnly.status !== "event") {
      return;
    }
    expect(iconOnly.event.message?.text).toBe("今天站会");
    expect(iconOnly.event.message?.hosts).toBeUndefined();
    expect(JSON.stringify(iconOnly.event)).not.toContain("bit.ly");

    const asBody = "免费领取 https://bit.ly/body57";
    const body = await normalize({
      update_id: 3013,
      message: {
        message_id: 123,
        date: 1761955200,
        chat: { id: -100803, type: "supergroup" },
        from: { id: 9 },
        forum_topic_created: {
          name: asBody,
          icon_color: 1,
          is_name_implicit: true,
        },
      },
    });
    expect(body.status).toBe("event");
    if (body.status !== "event") {
      return;
    }
    expect(body.event.message?.text).toBe(asBody);
    expect(body.event.message?.textSha256).toBe(await sha256Hex(asBody));
    expect(body.event.message?.hosts).toEqual(["bit.ly"]);
  });

  it("keeps hostnames from added poll options and checklist tasks", async () => {
    const phrase = "请免费领取礼品";
    const code = "OPT58";
    const added = await normalize({
      update_id: 3110,
      message: {
        message_id: 130,
        date: 1761955200,
        chat: { id: -100810, type: "supergroup" },
        from: { id: 9 },
        text: "今天站会",
        poll_option_added: {
          option_persistent_id: "pid58",
          option_text: `${phrase} https://bit.ly/opt58 https://t.me/+${code}.`,
          option_text_entities: [
            {
              type: "text_link",
              offset: 0,
              length: 1,
              url: "https://example.com/ent58",
            },
          ],
          poll_message: {
            message_id: 1,
            date: 1761955200,
            chat: { id: -100810, type: "supergroup" },
            text: "https://tinyurl.com/old58",
          },
        },
      },
    });
    expect(added.status).toBe("event");
    if (added.status !== "event") {
      return;
    }
    expect(added.event.message?.text).toBe("今天站会");
    expect(added.event.message?.textSha256).toBe(await sha256Hex("今天站会"));
    expect(added.event.message?.hosts).toEqual([
      "bit.ly",
      "t.me",
      "example.com",
    ]);
    expect(added.event.message?.invites).toEqual(["t.me"]);
    const addedDump = JSON.stringify(added.event);
    expect(addedDump).not.toContain(phrase);
    expect(addedDump).not.toContain(code);
    expect(addedDump).not.toContain("opt58");
    expect(addedDump).not.toContain("ent58");
    expect(addedDump).not.toContain("pid58");
    expect(addedDump).not.toContain("tinyurl.com");
    expect(addedDump).not.toContain("old58");

    const removed = await normalize({
      update_id: 3111,
      message: {
        message_id: 131,
        date: 1761955200,
        chat: { id: -100811, type: "supergroup" },
        from: { id: 9 },
        text: "今天站会",
        poll_option_deleted: {
          option_persistent_id: "https://bit.ly/pid58",
          option_text: phrase,
          option_text_entities: [
            {
              type: "text_link",
              offset: 0,
              length: 1,
              url: "https://t.me/%2BOPT58",
            },
          ],
        },
      },
    });
    expect(removed.status).toBe("event");
    if (removed.status !== "event") {
      return;
    }
    expect(removed.event.message?.text).toBe("今天站会");
    expect(removed.event.message?.textSha256).toBe(await sha256Hex("今天站会"));
    expect(removed.event.message?.hosts).toEqual(["t.me"]);
    expect(removed.event.message?.invites).toEqual(["t.me"]);
    const removedDump = JSON.stringify(removed.event);
    expect(removedDump).not.toContain(phrase);
    expect(removedDump).not.toContain(code);
    expect(removedDump).not.toContain("bit.ly");
    expect(removedDump).not.toContain("pid58");

    const tasks = await normalize({
      update_id: 3112,
      message: {
        message_id: 132,
        date: 1761955200,
        chat: { id: -100812, type: "supergroup" },
        from: { id: 9 },
        text: "今天站会",
        checklist_tasks_added: {
          tasks: [
            {
              id: 58,
              text: `${phrase} https://example.com/page58`,
              completed_by_user: { id: 8, first_name: "Ada58" },
              completed_by_chat: {
                id: -1001,
                title: "CHAT58",
                type: "channel",
              },
            },
          ],
          checklist_message: {
            message_id: 2,
            date: 1761955200,
            chat: { id: -100812, type: "supergroup" },
            text: "https://bit.ly/old58",
          },
        },
      },
    });
    expect(tasks.status).toBe("event");
    if (tasks.status !== "event") {
      return;
    }
    expect(tasks.event.message?.text).toBe("今天站会");
    expect(tasks.event.message?.hosts).toEqual(["example.com"]);
    const tasksDump = JSON.stringify(tasks.event);
    expect(tasksDump).not.toContain(phrase);
    expect(tasksDump).not.toContain("page58");
    expect(tasksDump).not.toContain("bit.ly");
    expect(tasksDump).not.toContain("old58");
    expect(tasksDump).not.toContain("Ada58");
    expect(tasksDump).not.toContain("CHAT58");

    const asBody = "免费领取 https://bit.ly/body58";
    const body = await normalize({
      update_id: 3113,
      message: {
        message_id: 133,
        date: 1761955200,
        chat: { id: -100813, type: "supergroup" },
        from: { id: 9 },
        checklist_tasks_added: {
          tasks: [
            { id: 1, text: asBody },
            { id: 2, text: "今天站会" },
          ],
        },
      },
    });
    expect(body.status).toBe("event");
    if (body.status !== "event") {
      return;
    }
    expect(body.event.message?.text).toBe(`${asBody} 今天站会`);
    expect(body.event.message?.textSha256).toBe(
      await sha256Hex(`${asBody} 今天站会`),
    );
    expect(body.event.message?.hosts).toEqual(["bit.ly"]);
  });

  it("keeps hostnames from paid media file names", async () => {
    const phrase = "请免费领取礼品";
    const code = "PAID59";
    const labeled = await normalize({
      update_id: 3210,
      message: {
        message_id: 140,
        date: 1761955200,
        chat: { id: -100820, type: "supergroup" },
        from: { id: 9 },
        text: "今天站会",
        paid_media: {
          star_count: 59,
          paid_media: [
            {
              type: "photo",
              photo: [{ file_id: "FILE59", file_unique_id: "UNIQ59" }],
            },
            {
              type: "video",
              video: {
                file_id: "VID59",
                file_unique_id: "VUNIQ59",
                mime_type: "video/mp4",
                file_name: `${phrase} https://bit.ly/paid59 https://t.me/+${code}.`,
              },
            },
            {
              type: "live_photo",
              live_photo: {
                file_id: "https://tinyurl.com/live59",
                file_unique_id: "LIVE59",
              },
            },
          ],
        },
      },
    });
    expect(labeled.status).toBe("event");
    if (labeled.status !== "event") {
      return;
    }
    expect(labeled.event.message?.text).toBe("今天站会");
    expect(labeled.event.message?.textSha256).toBe(await sha256Hex("今天站会"));
    expect(labeled.event.message?.hosts).toEqual(["bit.ly", "t.me"]);
    expect(labeled.event.message?.invites).toEqual(["t.me"]);
    const labeledDump = JSON.stringify(labeled.event);
    expect(labeledDump).not.toContain(phrase);
    expect(labeledDump).not.toContain(code);
    expect(labeledDump).not.toContain("paid59");
    expect(labeledDump).not.toContain("tinyurl.com");
    expect(labeledDump).not.toContain("FILE59");
    expect(labeledDump).not.toContain("VID59");
    expect(labeledDump).not.toContain("live59");

    const ordinary = await normalize({
      update_id: 3211,
      message: {
        message_id: 141,
        date: 1761955200,
        chat: { id: -100821, type: "supergroup" },
        from: { id: 9 },
        text: "今天站会",
        paid_media: {
          star_count: 1,
          paid_media: [
            {
              type: "video",
              video: {
                file_id: "VID59B",
                file_name: `${phrase} https://example.com/page59`,
                mime_type: "https://is.gd/mime59",
              },
            },
          ],
        },
      },
    });
    expect(ordinary.status).toBe("event");
    if (ordinary.status !== "event") {
      return;
    }
    expect(ordinary.event.message?.text).toBe("今天站会");
    expect(ordinary.event.message?.hosts).toEqual(["example.com"]);
    const ordinaryDump = JSON.stringify(ordinary.event);
    expect(ordinaryDump).not.toContain(phrase);
    expect(ordinaryDump).not.toContain("page59");
    expect(ordinaryDump).not.toContain("is.gd");
    expect(ordinaryDump).not.toContain("mime59");

    const hidden = await normalize({
      update_id: 3212,
      message: {
        message_id: 142,
        date: 1761955200,
        chat: { id: -100822, type: "supergroup" },
        from: { id: 9 },
        text: "今天站会",
        paid_media: {
          star_count: 1,
          paid_media: [
            {
              type: "live_photo",
              live_photo: { file_id: "https://bit.ly/live59" },
            },
            { type: "preview", width: 1, height: 1 },
          ],
        },
      },
    });
    expect(hidden.status).toBe("event");
    if (hidden.status !== "event") {
      return;
    }
    expect(hidden.event.message?.text).toBe("今天站会");
    expect(hidden.event.message?.hosts).toBeUndefined();
    expect(JSON.stringify(hidden.event)).not.toContain("bit.ly");

    const paidBody = "免费领取 https://bit.ly/body59";
    const paid = await normalize({
      update_id: 3213,
      message: {
        message_id: 143,
        date: 1761955200,
        chat: { id: -100823, type: "supergroup" },
        from: { id: 9 },
        paid_media: {
          star_count: 1,
          paid_media: [
            {
              type: "video",
              video: { file_id: "VID59C", file_name: paidBody },
            },
          ],
        },
      },
    });
    expect(paid.status).toBe("event");
    if (paid.status !== "event") {
      return;
    }
    expect(paid.event.message?.text).toBe(paidBody);
    expect(paid.event.message?.textSha256).toBe(await sha256Hex(paidBody));
    expect(paid.event.message?.hosts).toEqual(["bit.ly"]);
  });

  it("keeps hostnames from hidden forward names", async () => {
    const phrase = "请免费领取礼品";
    const code = "HIDE60";
    const labeled = await normalize({
      update_id: 3310,
      message: {
        message_id: 150,
        date: 1761955200,
        chat: { id: -100830, type: "supergroup" },
        from: { id: 9 },
        text: "今天站会",
        forward_origin: {
          type: "hidden_user",
          date: 1761955200,
          sender_user_name: `${phrase} https://bit.ly/hide60 https://t.me/+${code}.`,
        },
        external_reply: {
          origin: {
            type: "hidden_user",
            sender_user_name: "https://tinyurl.com/ext60",
          },
        },
      },
    });
    expect(labeled.status).toBe("event");
    if (labeled.status !== "event") {
      return;
    }
    expect(labeled.event.message?.text).toBe("今天站会");
    expect(labeled.event.message?.textSha256).toBe(await sha256Hex("今天站会"));
    expect(labeled.event.message?.forward).toBe("hidden");
    expect(labeled.event.message?.hosts).toEqual(["bit.ly", "t.me"]);
    expect(labeled.event.message?.invites).toEqual(["t.me"]);
    const labeledDump = JSON.stringify(labeled.event);
    expect(labeledDump).not.toContain(phrase);
    expect(labeledDump).not.toContain(code);
    expect(labeledDump).not.toContain("hide60");
    expect(labeledDump).not.toContain("tinyurl.com");
    expect(labeledDump).not.toContain("ext60");

    const legacy = await normalize({
      update_id: 3311,
      message: {
        message_id: 151,
        date: 1761955200,
        chat: { id: -100831, type: "supergroup" },
        from: { id: 9 },
        text: "今天站会",
        forward_sender_name: `${phrase} https://example.com/page60`,
        forward_from: {
          id: 8,
          is_bot: false,
          first_name: "https://bit.ly/user60",
        },
      },
    });
    expect(legacy.status).toBe("event");
    if (legacy.status !== "event") {
      return;
    }
    expect(legacy.event.message?.text).toBe("今天站会");
    expect(legacy.event.message?.forward).toBe("hidden");
    expect(legacy.event.message?.hosts).toEqual(["example.com"]);
    const legacyDump = JSON.stringify(legacy.event);
    expect(legacyDump).not.toContain(phrase);
    expect(legacyDump).not.toContain("page60");
    expect(legacyDump).not.toContain("bit.ly");
    expect(legacyDump).not.toContain("user60");

    const channel = await normalize({
      update_id: 3312,
      message: {
        message_id: 152,
        date: 1761955200,
        chat: { id: -100832, type: "supergroup" },
        from: { id: 9 },
        text: "今天站会",
        forward_origin: {
          type: "channel",
          date: 1761955200,
          chat: {
            id: -1001,
            title: "https://bit.ly/ch60",
            type: "channel",
          },
          author_signature: "https://tinyurl.com/sig60",
        },
      },
    });
    expect(channel.status).toBe("event");
    if (channel.status !== "event") {
      return;
    }
    expect(channel.event.message?.text).toBe("今天站会");
    expect(channel.event.message?.forward).toBe("channel");
    expect(channel.event.message?.hosts).toBeUndefined();
    const channelDump = JSON.stringify(channel.event);
    expect(channelDump).not.toContain("bit.ly");
    expect(channelDump).not.toContain("tinyurl.com");
    expect(channelDump).not.toContain("ch60");
    expect(channelDump).not.toContain("sig60");

    const asBody = "免费领取 https://bit.ly/body60";
    const body = await normalize({
      update_id: 3313,
      message: {
        message_id: 153,
        date: 1761955200,
        chat: { id: -100833, type: "supergroup" },
        from: { id: 9 },
        forward_origin: {
          type: "hidden_user",
          date: 1761955200,
          sender_user_name: asBody,
        },
      },
    });
    expect(body.status).toBe("event");
    if (body.status !== "event") {
      return;
    }
    expect(body.event.message?.text).toBe(asBody);
    expect(body.event.message?.textSha256).toBe(await sha256Hex(asBody));
    expect(body.event.message?.forward).toBe("hidden");
    expect(body.event.message?.hosts).toEqual(["bit.ly"]);
  });

  it("keeps hostnames from audio performers", async () => {
    const phrase = "请免费领取礼品";
    const code = "PERF61";
    const labeled = await normalize({
      update_id: 3410,
      message: {
        message_id: 160,
        date: 1761955200,
        chat: { id: -100840, type: "supergroup" },
        from: { id: 9 },
        text: "今天站会",
        audio: {
          file_id: "https://tinyurl.com/id61",
          file_unique_id: "aud-160",
          duration: 3,
          mime_type: phrase,
          performer: `${phrase} https://bit.ly/perf61 https://t.me/+${code}.`,
        },
      },
    });
    expect(labeled.status).toBe("event");
    if (labeled.status !== "event") {
      return;
    }
    expect(labeled.event.message?.text).toBe("今天站会");
    expect(labeled.event.message?.textSha256).toBe(await sha256Hex("今天站会"));
    expect(labeled.event.message?.hosts).toEqual(["bit.ly", "t.me"]);
    expect(labeled.event.message?.invites).toEqual(["t.me"]);
    const labeledDump = JSON.stringify(labeled.event);
    expect(labeledDump).not.toContain(phrase);
    expect(labeledDump).not.toContain(code);
    expect(labeledDump).not.toContain("perf61");
    expect(labeledDump).not.toContain("tinyurl.com");
    expect(labeledDump).not.toContain("id61");

    const ordinary = await normalize({
      update_id: 3411,
      message: {
        message_id: 161,
        date: 1761955200,
        chat: { id: -100841, type: "supergroup" },
        from: { id: 9 },
        text: "今天站会",
        audio: {
          file_id: "aud-161",
          file_unique_id: "aud-161",
          duration: 3,
          title: "会议录音",
          performer: `${phrase} https://example.com/page61`,
        },
      },
    });
    expect(ordinary.status).toBe("event");
    if (ordinary.status !== "event") {
      return;
    }
    expect(ordinary.event.message?.text).toBe("今天站会");
    expect(ordinary.event.message?.hosts).toEqual(["example.com"]);
    const ordinaryDump = JSON.stringify(ordinary.event);
    expect(ordinaryDump).not.toContain(phrase);
    expect(ordinaryDump).not.toContain("page61");
    expect(ordinaryDump).not.toContain("会议录音");

    const sticker = await normalize({
      update_id: 3412,
      message: {
        message_id: 162,
        date: 1761955200,
        chat: { id: -100842, type: "supergroup" },
        from: { id: 9 },
        text: "今天站会",
        sticker: {
          file_id: "stk-162",
          file_unique_id: "stk-162",
          type: "regular",
          width: 1,
          height: 1,
          is_animated: false,
          is_video: false,
          set_name: "https://bit.ly/set61",
          emoji: phrase,
        },
      },
    });
    expect(sticker.status).toBe("event");
    if (sticker.status !== "event") {
      return;
    }
    expect(sticker.event.message?.text).toBe("今天站会");
    expect(sticker.event.message?.hosts).toBeUndefined();
    const stickerDump = JSON.stringify(sticker.event);
    expect(stickerDump).not.toContain(phrase);
    expect(stickerDump).not.toContain("bit.ly");
    expect(stickerDump).not.toContain("set61");

    const asBody = "免费领取 https://bit.ly/body61";
    const body = await normalize({
      update_id: 3413,
      message: {
        message_id: 163,
        date: 1761955200,
        chat: { id: -100843, type: "supergroup" },
        from: { id: 9 },
        audio: {
          file_id: "aud-163",
          file_unique_id: "aud-163",
          duration: 3,
          performer: asBody,
        },
      },
    });
    expect(body.status).toBe("event");
    if (body.status !== "event") {
      return;
    }
    expect(body.event.message?.text).toBe(asBody);
    expect(body.event.message?.textSha256).toBe(await sha256Hex(asBody));
    expect(body.event.message?.hosts).toEqual(["bit.ly"]);
    expect(JSON.stringify(body.event)).not.toContain("aud-163");
  });

  it("folds a middle dot in a button url down to an ascii host", async () => {
    const outcome = await normalize({
      update_id: 3510,
      message: {
        message_id: 170,
        date: 1761955200,
        chat: { id: -100850, type: "supergroup" },
        from: { id: 9 },
        text: "今天站会",
        reply_markup: {
          inline_keyboard: [
            [{ text: "打开", url: "https://bit\u00B7ly/btn62" }],
          ],
        },
      },
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    expect(outcome.event.message?.text).toBe("今天站会");
    expect(outcome.event.message?.textSha256).toBe(await sha256Hex("今天站会"));
    expect(outcome.event.message?.hosts).toEqual(["bit.ly"]);
    const dumped = JSON.stringify(outcome.event);
    expect(dumped).not.toContain("btn62");
    expect(dumped).not.toContain("xn--");
  });

  it("folds fullwidth latin in button text down to an ascii host", async () => {
    const outcome = await normalize({
      update_id: 3610,
      message: {
        message_id: 180,
        date: 1761955200,
        chat: { id: -100860, type: "supergroup" },
        from: { id: 9 },
        text: "今天站会",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "\uFF42\uFF49\uFF54.ly/btn63",
                url: "https://example.com",
              },
            ],
          ],
        },
      },
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    expect(outcome.event.message?.text).toBe("今天站会");
    expect(outcome.event.message?.hosts).toEqual(["bit.ly", "example.com"]);
    const dumped = JSON.stringify(outcome.event);
    expect(dumped).not.toContain("btn63");
  });

  it("folds a cyrillic lookalike in button text down to an ascii host", async () => {
    const outcome = await normalize({
      update_id: 3611,
      message: {
        message_id: 181,
        date: 1761955200,
        chat: { id: -100870, type: "supergroup" },
        from: { id: 9 },
        text: "今天站会",
        reply_markup: {
          inline_keyboard: [
            [{ text: "bit.l\u0443/btn64", url: "https://example.com" }],
          ],
        },
      },
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    expect(outcome.event.message?.text).toBe("今天站会");
    expect(outcome.event.message?.hosts).toEqual(["bit.ly", "example.com"]);
    const dumped = JSON.stringify(outcome.event);
    expect(dumped).not.toContain("btn64");
  });

  it("folds ukrainian i in button text down to an ascii host", async () => {
    const outcome = await normalize({
      update_id: 3612,
      message: {
        message_id: 182,
        date: 1761955200,
        chat: { id: -100880, type: "supergroup" },
        from: { id: 9 },
        text: "今天站会",
        reply_markup: {
          inline_keyboard: [
            [{ text: "b\u0456t.ly/btn65", url: "https://example.com" }],
          ],
        },
      },
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    expect(outcome.event.message?.text).toBe("今天站会");
    expect(outcome.event.message?.hosts).toEqual(["bit.ly", "example.com"]);
    const dumped = JSON.stringify(outcome.event);
    expect(dumped).not.toContain("btn65");
  });

  it("drops a letter that splits a host in button text", async () => {
    const outcome = await normalize({
      update_id: 3613,
      message: {
        message_id: 183,
        date: 1761955200,
        chat: { id: -100890, type: "supergroup" },
        from: { id: 9 },
        text: "今天站会",
        reply_markup: {
          inline_keyboard: [
            [{ text: "b\u0442it.ly/btn66", url: "https://example.com" }],
          ],
        },
      },
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    expect(outcome.event.message?.text).toBe("今天站会");
    expect(outcome.event.message?.hosts).toEqual(["bit.ly", "example.com"]);
    const dumped = JSON.stringify(outcome.event);
    expect(dumped).not.toContain("btn66");
  });

  it("folds an encoded middle dot in button text down to an ascii host", async () => {
    const outcome = await normalize({
      update_id: 3614,
      message: {
        message_id: 184,
        date: 1761955200,
        chat: { id: -100900, type: "supergroup" },
        from: { id: 9 },
        text: "今天站会",
        reply_markup: {
          inline_keyboard: [
            [{ text: "bit%C2%B7ly/btn67", url: "https://example.com" }],
          ],
        },
      },
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    expect(outcome.event.message?.text).toBe("今天站会");
    expect(outcome.event.message?.hosts).toEqual(["bit.ly", "example.com"]);
    const dumped = JSON.stringify(outcome.event);
    expect(dumped).not.toContain("btn67");
    expect(dumped).not.toContain("%C2%B7");
  });

  it("folds an encoded katakana middle dot in button text", async () => {
    const outcome = await normalize({
      update_id: 3615,
      message: {
        message_id: 185,
        date: 1761955200,
        chat: { id: -100910, type: "supergroup" },
        from: { id: 9 },
        text: "今天站会",
        reply_markup: {
          inline_keyboard: [
            [{ text: "bit%E3%83%BBly/btn68", url: "https://example.com" }],
          ],
        },
      },
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    expect(outcome.event.message?.text).toBe("今天站会");
    expect(outcome.event.message?.hosts).toEqual(["bit.ly", "example.com"]);
    const dumped = JSON.stringify(outcome.event);
    expect(dumped).not.toContain("btn68");
  });

  it("drops an armenian letter that splits a host in button text", async () => {
    const outcome = await normalize({
      update_id: 3616,
      message: {
        message_id: 186,
        date: 1761955200,
        chat: { id: -100920, type: "supergroup" },
        from: { id: 9 },
        text: "今天站会",
        reply_markup: {
          inline_keyboard: [
            [{ text: "b\u0561it.ly/btn69", url: "https://example.com" }],
          ],
        },
      },
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    expect(outcome.event.message?.text).toBe("今天站会");
    expect(outcome.event.message?.hosts).toEqual(["bit.ly", "example.com"]);
    const dumped = JSON.stringify(outcome.event);
    expect(dumped).not.toContain("btn69");
  });

  it("uses inline button text when earlier text is missing", async () => {
    const phrase = "请免费领取礼品";
    const outcome = await normalize({
      update_id: 2801,
      message: {
        message_id: 101,
        date: 1761955200,
        chat: { id: -100770, type: "supergroup" },
        from: { id: 9 },
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "免费领取",
                url: `https://example.com/docs?token=${phrase}`,
              },
              {
                text: "callback",
                callback_data: phrase,
              },
            ],
          ],
        },
      },
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    expect(outcome.event.message?.text).toBe("免费领取 callback");
    expect(outcome.event.message?.textSha256).toBe(
      await sha256Hex("免费领取 callback"),
    );
    expect(outcome.event.message?.hosts).toEqual(["example.com"]);
    const dumped = JSON.stringify(outcome.event);
    expect(dumped).not.toContain(phrase);
  });

  it("joins button labels and leaves the copy payload out", async () => {
    const phrase = "请免费领取礼品";
    const outcome = await normalize({
      update_id: 2802,
      message: {
        message_id: 102,
        date: 1761955200,
        chat: { id: -100771, type: "supergroup" },
        from: { id: 9 },
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "今天站会",
                copy_text: { text: `${phrase} https://evil.example/hide` },
              },
              { text: "", url: "https://example.com/empty" },
              { text: "免费领取", url: "https://example.com/a" },
            ],
          ],
        },
      },
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    expect(outcome.event.message?.text).toBe("今天站会 免费领取");
    expect(outcome.event.message?.textSha256).toBe(
      await sha256Hex("今天站会 免费领取"),
    );
    expect(outcome.event.message?.hosts).toEqual([
      "evil.example",
      "example.com",
    ]);
    const dumped = JSON.stringify(outcome.event);
    expect(dumped).not.toContain(phrase);
    expect(dumped).not.toContain("/hide");
  });

  it("keeps hostnames found inside copied button text", async () => {
    const phrase = "请免费领取礼品";
    const code = "COPYSENT42";
    const encoded = "COPYENC42";
    const outcome = await normalize({
      update_id: 2805,
      message: {
        message_id: 105,
        date: 1761955200,
        chat: { id: -100774, type: "supergroup" },
        from: { id: 9 },
        text: "点这里",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "copy",
                copy_text: {
                  text: `${phrase} 打开 https://bit.ly/offer42 和 https://t.me/+${code}. 还有 bit.ly/bare 以及 www.tinyurl.com/y https://t.me/%2B${encoded} https://example.com/page`,
                },
              },
              {
                text: "skip",
                callback_data: `https://login.example/${phrase}`,
              },
            ],
          ],
        },
      },
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    expect(outcome.event.message?.text).toBe("点这里");
    expect(outcome.event.message?.textSha256).toBe(await sha256Hex("点这里"));
    expect(outcome.event.message?.hosts).toEqual([
      "bit.ly",
      "t.me",
      "www.tinyurl.com",
      "example.com",
    ]);
    expect(outcome.event.message?.invites).toEqual(["t.me"]);
    const dumped = JSON.stringify(outcome.event);
    expect(dumped).not.toContain(phrase);
    expect(dumped).not.toContain(code);
    expect(dumped).not.toContain(encoded);
    expect(dumped).not.toContain("/offer42");
    expect(dumped).not.toContain("/page");
    expect(dumped).not.toContain("/bare");
    expect(dumped).not.toContain("login.example");
  });

  it("keeps only the hostname of a login url and a web app", async () => {
    const phrase = "请免费领取礼品";
    const code = "LOGINHOST41";
    const outcome = await normalize({
      update_id: 2803,
      message: {
        message_id: 103,
        date: 1761955200,
        chat: { id: -100772, type: "supergroup" },
        from: { id: 9 },
        text: "点下面",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "免费领取",
                login_url: { url: `https://t.me/%2B${code}` },
              },
              {
                text: "加微信",
                web_app: { url: "https://bit.ly/only" },
              },
              {
                text: "skip",
                callback_data: `https://evil.example/${phrase}`,
              },
            ],
          ],
        },
      },
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    expect(outcome.event.message?.text).toBe("点下面");
    expect(outcome.event.message?.hosts).toEqual(["t.me", "bit.ly"]);
    expect(outcome.event.message?.invites).toEqual(["t.me"]);
    const dumped = JSON.stringify(outcome.event);
    expect(dumped).not.toContain(phrase);
    expect(dumped).not.toContain(code);
    expect(dumped).not.toContain("evil.example");
    expect(dumped).not.toContain("/only");
  });

  it("keeps a file name when a button label is also present", async () => {
    const outcome = await normalize({
      update_id: 2804,
      message: {
        message_id: 104,
        date: 1761955200,
        chat: { id: -100773, type: "supergroup" },
        from: { id: 9 },
        document: {
          file_name: "今天站会.pdf",
          file_unique_id: "doc-104",
        },
        reply_markup: {
          inline_keyboard: [
            [{ text: "免费领取", url: "https://example.com/a" }],
          ],
        },
      },
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    expect(outcome.event.message?.text).toBe("今天站会.pdf");
    expect(outcome.event.message?.hosts).toEqual(["example.com"]);
    const dumped = JSON.stringify(outcome.event);
    expect(dumped).not.toContain("免费领取");
  });

  it("uses button text before a manual quote", async () => {
    const outcome = await normalize({
      update_id: 2805,
      message: {
        message_id: 105,
        date: 1761955200,
        chat: { id: -100774, type: "supergroup" },
        from: { id: 9 },
        reply_markup: {
          inline_keyboard: [[{ text: "今天站会" }]],
        },
        quote: {
          text: "免费领取",
          position: 0,
          is_manual: true,
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 2,
              url: "https://bit.ly/quoted",
            },
          ],
        },
      },
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    expect(outcome.event.message?.text).toBe("今天站会");
    expect(outcome.event.message?.hosts).toEqual(["bit.ly"]);
    const dumped = JSON.stringify(outcome.event);
    expect(dumped).not.toContain("免费领取");
    expect(dumped).not.toContain("/quoted");
  });

  it("uses rich message text and keeps only link hostnames", async () => {
    const phrase = "请免费领取礼品";
    const code = "RICHLINK43";
    const outcome = await normalize({
      update_id: 2901,
      message: {
        message_id: 111,
        date: 1761955200,
        chat: { id: -100780, type: "supergroup" },
        from: { id: 9 },
        rich_message: {
          blocks: [
            {
              type: "paragraph",
              text: [
                "免",
                { type: "bold", text: "费领取" },
                {
                  type: "url",
                  text: "点",
                  url: `https://bit.ly/path?q=${phrase}`,
                },
                {
                  type: "url",
                  text: "邀",
                  url: `https://t.me/+${code}`,
                },
              ],
            },
            {
              type: "list",
              items: [
                {
                  label: "甲",
                  blocks: [{ type: "paragraph", text: "乙" }],
                },
              ],
            },
          ],
        },
      },
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    expect(outcome.event.message?.text).toBe("免费领取点邀 甲 乙");
    expect(outcome.event.message?.textSha256).toBe(
      await sha256Hex("免费领取点邀 甲 乙"),
    );
    expect(outcome.event.message?.hosts).toEqual(["bit.ly", "t.me"]);
    expect(outcome.event.message?.invites).toEqual(["t.me"]);
    const dumped = JSON.stringify(outcome.event);
    expect(dumped).not.toContain(phrase);
    expect(dumped).not.toContain(code);
    expect(dumped).not.toContain("/path");
  });

  it("keeps a caption when a rich message is also present", async () => {
    const phrase = "请免费领取礼品";
    const outcome = await normalize({
      update_id: 2902,
      message: {
        message_id: 112,
        date: 1761955200,
        chat: { id: -100781, type: "supergroup" },
        from: { id: 9 },
        caption: "caption-only",
        rich_message: {
          blocks: [
            {
              type: "paragraph",
              text: `${phrase} https://evil.example/hide`,
            },
            {
              type: "paragraph",
              text: {
                type: "url",
                text: "短链",
                url: "https://bit.ly/only",
              },
            },
          ],
        },
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
    expect(outcome.event.message?.hosts).toEqual(["evil.example", "bit.ly"]);
    const dumped = JSON.stringify(outcome.event);
    expect(dumped).not.toContain(phrase);
    expect(dumped).not.toContain("/hide");
    expect(dumped).not.toContain("/only");
  });

  it("uses rich button labels when the rich message has no text", async () => {
    const phrase = "请免费领取礼品";
    const code = "RICHBTN43";
    const outcome = await normalize({
      update_id: 2903,
      message: {
        message_id: 113,
        date: 1761955200,
        chat: { id: -100782, type: "supergroup" },
        from: { id: 9 },
        rich_message: {
          blocks: [
            {
              type: "buttons",
              buttons: [
                {
                  text: "免费领取",
                  url: `https://t.me/%2B${code}`,
                },
                {
                  text: "今天站会",
                  copy_text: { text: `${phrase} https://example.com/hide` },
                  web_app: { url: "https://tinyurl.com/only" },
                },
                {
                  text: "skip",
                  callback_data: "https://bit.ly/skip",
                },
              ],
            },
          ],
        },
      },
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    expect(outcome.event.message?.text).toBe("免费领取 今天站会 skip");
    expect(outcome.event.message?.hosts).toEqual([
      "t.me",
      "example.com",
      "tinyurl.com",
    ]);
    expect(outcome.event.message?.invites).toEqual(["t.me"]);
    const dumped = JSON.stringify(outcome.event);
    expect(dumped).not.toContain(phrase);
    expect(dumped).not.toContain(code);
    expect(dumped).not.toContain("bit.ly");
    expect(dumped).not.toContain("/hide");
    expect(dumped).not.toContain("/only");
    expect(dumped).not.toContain("/skip");
  });

  it("leaves rich mention ids and card numbers out of the event", async () => {
    const card = "4111111111111111";
    const mail = "secret@evil.example";
    const phone = "+10000000043";
    const latex = "LATEXSECRET43";
    const outcome = await normalize({
      update_id: 2904,
      message: {
        message_id: 114,
        date: 1761955200,
        chat: { id: -100783, type: "supergroup" },
        from: { id: 9 },
        rich_message: {
          blocks: [
            {
              type: "paragraph",
              text: [
                {
                  type: "text_mention",
                  text: "名字",
                  user: { id: 999001, first_name: "机密用户名" },
                },
                {
                  type: "bank_card_number",
                  text: "卡",
                  bank_card_number: card,
                },
                {
                  type: "email_address",
                  text: "邮",
                  email_address: mail,
                },
                {
                  type: "phone_number",
                  text: "电",
                  phone_number: phone,
                },
              ],
            },
            { type: "mathematical_expression", expression: latex },
          ],
        },
      },
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    expect(outcome.event.message?.text).toBe("名字卡邮电");
    const dumped = JSON.stringify(outcome.event);
    expect(dumped).not.toContain("999001");
    expect(dumped).not.toContain("机密用户名");
    expect(dumped).not.toContain(card);
    expect(dumped).not.toContain(mail);
    expect(dumped).not.toContain(phone);
    expect(dumped).not.toContain(latex);
    expect(dumped).not.toContain("evil.example");
  });

  it("leaves a reply keyboard out of the text", async () => {
    const outcome = await normalize({
      update_id: 2806,
      message: {
        message_id: 106,
        date: 1761955200,
        chat: { id: -100775, type: "supergroup" },
        from: { id: 9 },
        reply_markup: {
          keyboard: [[{ text: "免费领取" }]],
        },
      },
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    expect(outcome.event.message?.text).toBe("");
    expect(JSON.stringify(outcome.event)).not.toContain("免费领取");
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
      expect(bot.event.actor.bot).toBe(true);
      expect(bot.event.actor.isAdmin).toBe(false);
    }
    const promoted = await normalize({
      update_id: 2007,
      chat_member: {
        chat: { id: -100592, type: "supergroup", title: "机密群名" },
        date: 1761955200,
        old_chat_member: {
          user: { id: 91, is_bot: true, username: "已在群里" },
          status: "member",
        },
        new_chat_member: {
          user: { id: 91, is_bot: true, username: "已在群里" },
          status: "administrator",
        },
      },
    });
    expect(promoted.status).toBe("event");
    if (promoted.status === "event") {
      expect(promoted.event.actor.bot).toBeUndefined();
      expect(promoted.event.membership).toBeUndefined();
      expect(promoted.event.actor.isAdmin).toBe(true);
      expect(JSON.stringify(promoted.event)).not.toContain("已在群里");
      expect(JSON.stringify(promoted.event)).not.toContain("机密群名");
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

  it("keeps hostnames from the author signature", async () => {
    const phrase = "请免费领取礼品";
    const code = "SIG68";
    const labeled = await normalize({
      update_id: 3910,
      message: {
        message_id: 190,
        date: 1761955200,
        chat: {
          id: -100920,
          type: "supergroup",
          title: "https://bit.ly/room68",
        },
        from: { id: 9, first_name: "https://bit.ly/user68" },
        text: "今天站会",
        author_signature: `${phrase} https://bit.ly/sig68 https://t.me/+${code}.`,
        forward_origin: {
          type: "channel",
          date: 1761955200,
          chat: {
            id: -1001,
            title: "https://bit.ly/ch68",
            type: "channel",
          },
          author_signature: "https://tinyurl.com/fwd68",
        },
      },
    });
    expect(labeled.status).toBe("event");
    if (labeled.status !== "event") {
      return;
    }
    expect(labeled.event.message?.text).toBe("今天站会");
    expect(labeled.event.message?.textSha256).toBe(await sha256Hex("今天站会"));
    expect(labeled.event.message?.forward).toBe("channel");
    expect(labeled.event.message?.hosts).toEqual(["bit.ly", "t.me"]);
    expect(labeled.event.message?.invites).toEqual(["t.me"]);
    const labeledDump = JSON.stringify(labeled.event);
    expect(labeledDump).not.toContain(phrase);
    expect(labeledDump).not.toContain(code);
    expect(labeledDump).not.toContain("sig68");
    expect(labeledDump).not.toContain("tinyurl.com");
    expect(labeledDump).not.toContain("fwd68");
    expect(labeledDump).not.toContain("room68");
    expect(labeledDump).not.toContain("user68");
    expect(labeledDump).not.toContain("ch68");

    const earlier = await normalize({
      update_id: 3911,
      message: {
        message_id: 191,
        date: 1761955200,
        chat: { id: -100921, type: "supergroup" },
        from: { id: 9 },
        document: {
          file_id: "doc-191",
          file_unique_id: "doc-191",
          file_name: "会议录音",
        },
        author_signature: `${phrase} https://example.com/page68`,
      },
    });
    expect(earlier.status).toBe("event");
    if (earlier.status !== "event") {
      return;
    }
    expect(earlier.event.message?.text).toBe("会议录音");
    expect(earlier.event.message?.textSha256).toBe(await sha256Hex("会议录音"));
    expect(earlier.event.message?.hosts).toEqual(["example.com"]);
    const earlierDump = JSON.stringify(earlier.event);
    expect(earlierDump).not.toContain(phrase);
    expect(earlierDump).not.toContain("page68");
    expect(earlierDump).not.toContain("doc-191");

    const asBody = "免费领取 https://bit.ly/body68";
    const body = await normalize({
      update_id: 3912,
      message: {
        message_id: 192,
        date: 1761955200,
        chat: { id: -100922, type: "channel" },
        sender_chat: { id: -100922, type: "channel" },
        photo: [
          {
            file_id: "ph-192",
            file_unique_id: "ph-192",
            width: 1,
            height: 1,
          },
        ],
        author_signature: asBody,
      },
    });
    expect(body.status).toBe("event");
    if (body.status !== "event") {
      return;
    }
    expect(body.event.message?.text).toBe(asBody);
    expect(body.event.message?.textSha256).toBe(await sha256Hex(asBody));
    expect(body.event.message?.hosts).toEqual(["bit.ly"]);
    expect(JSON.stringify(body.event)).not.toContain("ph-192");
  });

  it("keeps a tg deep link as an invite host", async () => {
    const joinCode = "DEEPJOIN69";
    const folderCode = "DEEPFOLDER69";
    const signCode = "DEEPSIGN69";
    const outcome = await normalize({
      update_id: 4010,
      message: {
        message_id: 200,
        date: 1761955200,
        chat: { id: -100930, type: "supergroup" },
        from: { id: 9 },
        text: "点这里",
        author_signature: `tg://join?invite=${signCode}`,
        entities: [
          {
            type: "text_link",
            offset: 0,
            length: 3,
            url: `tg://join?invite=${joinCode}`,
          },
          {
            type: "text_link",
            offset: 0,
            length: 3,
            url: "tg://resolve?domain=notahost69",
          },
        ],
        reply_markup: {
          inline_keyboard: [
            [{ text: "文件夹", url: `tg://addlist?slug=${folderCode}` }],
          ],
        },
      },
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    expect(outcome.event.message?.text).toBe("点这里");
    expect(outcome.event.message?.textSha256).toBe(await sha256Hex("点这里"));
    expect(outcome.event.message?.hosts).toEqual(["t.me"]);
    expect(outcome.event.message?.invites).toEqual(["t.me"]);
    const dumped = JSON.stringify(outcome.event);
    expect(dumped).not.toContain(joinCode);
    expect(dumped).not.toContain(folderCode);
    expect(dumped).not.toContain(signCode);
    expect(dumped).not.toContain("notahost69");
    expect(dumped).not.toContain("resolve");
  });

  it("folds a bracketed dot in button text down to an ascii host", async () => {
    const outcome = await normalize({
      update_id: 4110,
      message: {
        message_id: 210,
        date: 1761955200,
        chat: { id: -100940, type: "supergroup" },
        from: { id: 9 },
        text: "今天站会",
        reply_markup: {
          inline_keyboard: [
            [{ text: "bit[.]ly/btn70", url: "https://example.com" }],
          ],
        },
      },
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    expect(outcome.event.message?.text).toBe("今天站会");
    expect(outcome.event.message?.textSha256).toBe(await sha256Hex("今天站会"));
    expect(outcome.event.message?.hosts).toEqual(["bit.ly", "example.com"]);
    const dumped = JSON.stringify(outcome.event);
    expect(dumped).not.toContain("btn70");
  });

  it("folds an encoded bracket dot in button text down to an ascii host", async () => {
    const outcome = await normalize({
      update_id: 4210,
      message: {
        message_id: 220,
        date: 1761955200,
        chat: { id: -100950, type: "supergroup" },
        from: { id: 9 },
        text: "今天站会",
        reply_markup: {
          inline_keyboard: [
            [{ text: "bit%5B.%5Dly/btn71", url: "https://example.com" }],
          ],
        },
      },
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    expect(outcome.event.message?.text).toBe("今天站会");
    expect(outcome.event.message?.textSha256).toBe(await sha256Hex("今天站会"));
    expect(outcome.event.message?.hosts).toEqual(["bit.ly", "example.com"]);
    const dumped = JSON.stringify(outcome.event);
    expect(dumped).not.toContain("btn71");
    expect(dumped).not.toContain("%5B");
  });

  it("folds a side label with the same host scan as the body", async () => {
    const code = "SIDE72";
    const outcome = await normalize({
      update_id: 4310,
      message: {
        message_id: 230,
        date: 1761955200,
        chat: { id: -100960, type: "supergroup" },
        from: { id: 9 },
        text: "今天站会",
        reply_markup: {
          inline_keyboard: [
            [{ text: "bit\u200b.ly/btn72", url: "https://example.com" }],
            [{ text: "b%69t.ly/enc72" }],
            [{ text: `t.me%2F+${code}` }],
            [{ text: "bit. ly/space72" }],
          ],
        },
      },
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    expect(outcome.event.message?.text).toBe("今天站会");
    expect(outcome.event.message?.textSha256).toBe(await sha256Hex("今天站会"));
    expect(outcome.event.message?.hosts).toEqual([
      "bit.ly",
      "example.com",
      "t.me",
    ]);
    expect(outcome.event.message?.invites).toEqual(["t.me"]);
    const dumped = JSON.stringify(outcome.event);
    expect(dumped).not.toContain("btn72");
    expect(dumped).not.toContain("enc72");
    expect(dumped).not.toContain(code);
    expect(dumped).not.toContain("space72");
    expect(dumped).not.toContain("%69");
    expect(dumped).not.toContain("%2F");
    expect(dumped).not.toContain("\u200b");
  });

  it("keeps only the hostname of a poll media link", async () => {
    const code = "POLL73";
    const outcome = await normalize({
      update_id: 4410,
      message: {
        message_id: 240,
        date: 1761955200,
        chat: { id: -100970, type: "supergroup" },
        from: { id: 9 },
        text: "今天站会",
        poll: {
          question: "今天站会",
          media: { link: { url: "https://bit.ly/media73?q=PATH73" } },
          explanation: "说明",
          explanation_media: { link: { url: `https://t.me/+${code}` } },
          options: [
            {
              text: "甲",
              voter_count: 0,
              media: { link: { url: "https://tinyurl.com/opt73" } },
            },
            {
              text: "乙",
              voter_count: 0,
              media: {
                photo: [
                  {
                    file_id: "https://bit.ly/hidden73",
                    file_unique_id: "x",
                    width: 1,
                    height: 1,
                  },
                ],
              },
            },
          ],
        },
      },
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    expect(outcome.event.message?.text).toBe("今天站会");
    expect(outcome.event.message?.textSha256).toBe(await sha256Hex("今天站会"));
    expect(outcome.event.message?.hosts).toEqual([
      "bit.ly",
      "t.me",
      "tinyurl.com",
    ]);
    expect(outcome.event.message?.invites).toEqual(["t.me"]);
    const dumped = JSON.stringify(outcome.event);
    expect(dumped).not.toContain("PATH73");
    expect(dumped).not.toContain(code);
    expect(dumped).not.toContain("opt73");
    expect(dumped).not.toContain("hidden73");
    expect(dumped).not.toContain("file_id");

    const photoOnly = await normalize({
      update_id: 4411,
      message: {
        message_id: 241,
        date: 1761955200,
        chat: { id: -100971, type: "supergroup" },
        from: { id: 9 },
        text: "今天站会",
        poll: {
          question: "选一个",
          options: [
            {
              text: "甲",
              voter_count: 0,
              media: {
                photo: [{ file_id: "https://bit.ly/hidden73" }],
              },
            },
          ],
          media: { location: { latitude: 1, longitude: 2 } },
        },
      },
    });
    expect(photoOnly.status).toBe("event");
    if (photoOnly.status !== "event") {
      return;
    }
    expect(photoOnly.event.message?.hosts).toBeUndefined();
    expect(photoOnly.event.message?.text).toBe("今天站会");
    const photoDump = JSON.stringify(photoOnly.event);
    expect(photoDump).not.toContain("bit.ly");
    expect(photoDump).not.toContain("hidden73");
    expect(photoDump).not.toContain("latitude");
  });

  it("keeps hostnames from a poll media name", async () => {
    const code = "POLL74";
    const outcome = await normalize({
      update_id: 4510,
      message: {
        message_id: 250,
        date: 1761955200,
        chat: { id: -100980, type: "supergroup" },
        from: { id: 9 },
        text: "今天站会",
        poll: {
          question: "今天站会",
          media: {
            animation: {
              file_name: "https://bit.ly/anim74",
              file_id: "https://bit.ly/id74",
              file_unique_id: "a",
              width: 1,
              height: 1,
              duration: 1,
            },
          },
          explanation_media: {
            venue: {
              title: "见面",
              address: `https://t.me/+${code}`,
              location: { latitude: 1, longitude: 2 },
              foursquare_id: "https://bit.ly/fsq74",
            },
          },
          options: [
            {
              text: "甲",
              voter_count: 0,
              media: {
                video: {
                  file_name: "https://tinyurl.com/vid74",
                  file_id: "https://cutt.ly/id74",
                  file_unique_id: "b",
                  width: 1,
                  height: 1,
                  duration: 1,
                },
              },
            },
            {
              text: "乙",
              voter_count: 0,
              media: {
                sticker: {
                  set_name: "https://bit.ly/set74",
                  file_id: "s",
                  file_unique_id: "c",
                  type: "regular",
                  width: 1,
                  height: 1,
                  is_animated: false,
                  is_video: false,
                },
              },
            },
          ],
        },
      },
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    expect(outcome.event.message?.text).toBe("今天站会");
    expect(outcome.event.message?.textSha256).toBe(await sha256Hex("今天站会"));
    expect(outcome.event.message?.hosts).toEqual([
      "bit.ly",
      "t.me",
      "tinyurl.com",
    ]);
    expect(outcome.event.message?.invites).toEqual(["t.me"]);
    const dumped = JSON.stringify(outcome.event);
    expect(dumped).not.toContain("anim74");
    expect(dumped).not.toContain(code);
    expect(dumped).not.toContain("vid74");
    expect(dumped).not.toContain("id74");
    expect(dumped).not.toContain("fsq74");
    expect(dumped).not.toContain("set74");
    expect(dumped).not.toContain("latitude");
    expect(dumped).not.toContain("file_id");

    const audio = await normalize({
      update_id: 4511,
      message: {
        message_id: 251,
        date: 1761955200,
        chat: { id: -100981, type: "supergroup" },
        from: { id: 9 },
        text: "今天站会",
        poll: {
          question: "听一段",
          options: [{ text: "甲", voter_count: 0 }],
          media: {
            audio: {
              title: "https://ow.ly/song74",
              performer: "歌手",
              file_id: "https://bit.ly/aid74",
              file_unique_id: "d",
              duration: 1,
            },
          },
        },
      },
    });
    expect(audio.status).toBe("event");
    if (audio.status !== "event") {
      return;
    }
    expect(audio.event.message?.text).toBe("今天站会");
    expect(audio.event.message?.hosts).toEqual(["ow.ly"]);
    const audioDump = JSON.stringify(audio.event);
    expect(audioDump).not.toContain("song74");
    expect(audioDump).not.toContain("aid74");
    expect(audioDump).not.toContain("歌手");
  });
});
