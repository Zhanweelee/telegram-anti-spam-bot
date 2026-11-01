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
    expect(outcome.event.message?.hosts).toEqual(["bit.ly", "t.me"]);
    expect(outcome.event.message?.invites).toEqual(["t.me"]);
    const dumped = JSON.stringify(outcome.event);
    expect(dumped).not.toContain(phrase);
    expect(dumped).not.toContain(code);
    expect(dumped).not.toContain("evil.example");
    expect(dumped).not.toContain("login.example");
    expect(dumped).not.toContain("app.example");
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
    ]);
    const dumped = JSON.stringify(outcome.event);
    expect(dumped).not.toContain(phrase);
    expect(dumped).not.toContain(zwsp);
    expect(dumped).not.toContain(selector);
    expect(dumped).not.toContain(nbsp);
    expect(dumped).not.toContain("DOUBLE34");
    expect(dumped).not.toContain("bit.ly");
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
              text: phrase,
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
    expect(outcome.event.message?.hosts).toEqual(["bit.ly", "t.me"]);
    expect(outcome.event.message?.invites).toEqual(["t.me"]);
    const dumped = JSON.stringify(outcome.event);
    expect(dumped).not.toContain(phrase);
    expect(dumped).not.toContain(code);
    expect(dumped).not.toContain("evil.example");
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
          description: phrase,
          text: phrase,
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
    expect(outcome.event.message?.hosts).toBeUndefined();
    expect(outcome.event.message?.media).toBeUndefined();
    const dumped = JSON.stringify(outcome.event);
    expect(dumped).not.toContain(phrase);
    expect(dumped).not.toContain("bit.ly");
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
          description: phrase,
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
    const dumped = JSON.stringify(outcome.event);
    expect(dumped).not.toContain(phrase);
    expect(dumped).not.toContain("XTR");
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
    expect(outcome.event.message?.hosts).toBeUndefined();
    const dumped = JSON.stringify(outcome.event);
    expect(dumped).not.toContain("免费领取");
    expect(dumped).not.toContain("bit.ly");
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
    expect(outcome.event.message?.hosts).toBeUndefined();
    const dumped = JSON.stringify(outcome.event);
    expect(dumped).not.toContain("免费领取");
    expect(dumped).not.toContain("bit.ly");
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
    expect(outcome.event.message?.hosts).toEqual(["example.com"]);
    const dumped = JSON.stringify(outcome.event);
    expect(dumped).not.toContain(phrase);
    expect(dumped).not.toContain("evil.example");
  });

  it("uses a login button label and leaves the login url unread", async () => {
    const outcome = await normalize({
      update_id: 2803,
      message: {
        message_id: 103,
        date: 1761955200,
        chat: { id: -100772, type: "supergroup" },
        from: { id: 9 },
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "免费领取",
                login_url: { url: "https://bit.ly/only" },
              },
              {
                text: "加微信",
                web_app: { url: "https://bit.ly/app" },
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
    expect(outcome.event.message?.text).toBe("免费领取 加微信");
    expect(outcome.event.message?.hosts).toBeUndefined();
    const dumped = JSON.stringify(outcome.event);
    expect(dumped).not.toContain("bit.ly");
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
    expect(outcome.event.message?.hosts).toBeUndefined();
    const dumped = JSON.stringify(outcome.event);
    expect(dumped).not.toContain("免费领取");
    expect(dumped).not.toContain("bit.ly");
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
});
