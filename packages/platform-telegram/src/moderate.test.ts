import { describe, expect, it } from "vitest";
import {
  captchaPrompt,
  createTelegramModerator,
  sendCaptchaButton,
} from "./moderate.js";

describe("telegram captcha transport", () => {
  it("restricts until a unix date and does not leak the token", async () => {
    const token = "bot-token";
    let url = "";
    let body = "";
    const moderator = createTelegramModerator({
      token,
      nowSeconds: () => 1_700_000_000,
      fetchImpl: async (input, init) => {
        url = String(input);
        body = String(init?.body ?? "");
        return new Response("no", { status: 400 });
      },
    });
    await expect(
      moderator.restrictActor({
        tenantId: "local",
        chatId: "-100",
        actorId: "77",
        durationSeconds: 300,
      }),
    ).rejects.toThrow("restrict_failed");
    expect(url).toBe(`https://api.telegram.org/bot${token}/restrictChatMember`);
    expect(body).toContain('"until_date":1700000300');
    expect(body).toContain('"can_send_messages":false');
    expect(body).toContain('"can_react_to_messages":false');
    expect(body).toContain('"can_edit_tag":false');
    expect("restrict_failed").not.toContain(token);
  });

  it("does not call Telegram when the token is missing", async () => {
    let called = false;
    const moderator = createTelegramModerator({
      token: " ",
      fetchImpl: async () => {
        called = true;
        return new Response("ok");
      },
    });
    await expect(
      moderator.restrictActor({
        tenantId: "local",
        chatId: "-100",
        actorId: "77",
        durationSeconds: 300,
      }),
    ).rejects.toThrow("restrict_unavailable");
    expect(called).toBe(false);
    await expect(
      moderator.deleteMessage({
        tenantId: "local",
        chatId: "-100",
        messageId: "1",
      }),
    ).rejects.toThrow("delete_unavailable");
    await expect(
      moderator.muteActor({
        tenantId: "local",
        chatId: "-100",
        actorId: "77",
        durationSeconds: 3600,
      }),
    ).rejects.toThrow("mute_unavailable");
    await expect(
      moderator.banActor({
        tenantId: "local",
        chatId: "-100",
        actorId: "77",
      }),
    ).rejects.toThrow("ban_unavailable");
    expect(called).toBe(false);
  });

  it("deletes, mutes, and bans with one call each and drops the response body", async () => {
    const token = "bot-token";
    const phrase = "请免费领取礼品";
    const calls: { method: string; body: string }[] = [];
    const moderator = createTelegramModerator({
      token,
      nowSeconds: () => 1_700_000_000,
      fetchImpl: async (input, init) => {
        const url = String(input);
        calls.push({
          method: url.slice(url.lastIndexOf("/") + 1),
          body: String(init?.body ?? ""),
        });
        return new Response(phrase, { status: 200 });
      },
    });
    await moderator.deleteMessage({
      tenantId: "local",
      chatId: "-100",
      messageId: "9",
    });
    await moderator.muteActor({
      tenantId: "local",
      chatId: "-100",
      actorId: "77",
      durationSeconds: 3600,
    });
    await moderator.banActor({
      tenantId: "local",
      chatId: "-100",
      actorId: "77",
    });
    expect(calls.map((call) => call.method)).toEqual([
      "deleteMessage",
      "restrictChatMember",
      "banChatMember",
    ]);
    expect(calls[0]?.body).toContain('"message_id":9');
    expect(calls[0]?.body).not.toContain(phrase);
    await moderator.deleteMessage({
      tenantId: "local",
      chatId: "-100",
      messageId: "63101",
      audienceId: "940",
    });
    expect(calls[3]?.method).toBe("deleteEphemeralMessage");
    expect(calls[3]?.body).toContain('"ephemeral_message_id":63101');
    expect(calls[3]?.body).toContain('"receiver_user_id":940');
    expect(calls[3]?.body).not.toContain('"message_id"');
    expect(calls[3]?.body).not.toContain(phrase);
    expect(calls[1]?.body).toContain('"until_date":1700003600');
    expect(calls[1]?.body).toContain('"can_send_messages":false');
    expect(calls[1]?.body).toContain('"can_react_to_messages":false');
    expect(calls[1]?.body).toContain('"can_edit_tag":false');
    expect(calls[2]?.body).toContain('"revoke_messages":false');
    expect(calls[2]?.body).not.toContain("message_id");
    await expect(
      createTelegramModerator({
        token,
        fetchImpl: async () => new Response(token + phrase, { status: 400 }),
      }).deleteMessage({
        tenantId: "local",
        chatId: "-100",
        messageId: "9",
      }),
    ).rejects.toThrow("delete_failed");
  });

  it("sends one button and releases with speaking permissions", async () => {
    const token = "bot-token";
    const bodies: string[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      bodies.push(String(init?.body ?? ""));
      return new Response("ok", { status: 200 });
    };
    expect(
      await sendCaptchaButton({
        token,
        chatId: "-100",
        nonce: "0123456789abcdef",
        fetchImpl,
      }),
    ).toBeNull();
    expect(bodies[0]).toContain(captchaPrompt);
    expect(bodies[0]).toContain("c:0123456789abcdef");
    expect(bodies[0]).toContain("我不是机器人");
    const moderator = createTelegramModerator({ token, fetchImpl });
    await moderator.releaseActor({
      tenantId: "local",
      chatId: "-100",
      actorId: "77",
    });
    expect(bodies[1]).toContain('"can_send_messages":true');
    expect(bodies[1]).toContain('"can_manage_topics":true');
    expect(bodies[1]).toContain('"can_pin_messages":true');
    expect(bodies[1]).toContain('"can_change_info":true');
    expect(bodies[1]).toContain('"can_react_to_messages":true');
    expect(bodies[1]).toContain('"can_edit_tag":true');
    expect(bodies[1]).not.toContain("until_date");
  });

  it("reads the captcha button id from the send response", async () => {
    expect(
      await sendCaptchaButton({
        token: "bot-token",
        chatId: "-100",
        nonce: "0123456789abcdef",
        fetchImpl: async () =>
          Response.json({ ok: true, result: { message_id: 42 } }),
      }),
    ).toBe("42");
    expect(
      await sendCaptchaButton({
        token: "bot-token",
        chatId: "-100",
        nonce: "0123456789abcdef",
        fetchImpl: async () =>
          Response.json({ ok: true, result: { message_id: 0 } }),
      }),
    ).toBeNull();
  });

  it("declines a join request without sending the bio", async () => {
    const token = "bot-token";
    const phrase = "请免费领取礼品";
    let method = "";
    let body = "";
    const moderator = createTelegramModerator({
      token,
      fetchImpl: async (input, init) => {
        method = String(input);
        body = String(init?.body ?? "");
        return new Response("ok", { status: 200 });
      },
    });
    await moderator.declineJoin({
      tenantId: "local",
      chatId: "-100",
      actorId: "83",
    });
    expect(method).toBe(
      `https://api.telegram.org/bot${token}/declineChatJoinRequest`,
    );
    expect(body).toContain('"chat_id":-100');
    expect(body).toContain('"user_id":83');
    expect(body).not.toContain(phrase);
    expect(body).not.toContain(token);
  });

  it("answers a guarded join query and leaves a clean one queued", async () => {
    const token = "bot-token";
    const phrase = "请免费领取礼品";
    const calls: { method: string; body: string }[] = [];
    const moderator = createTelegramModerator({
      token,
      fetchImpl: async (input, init) => {
        calls.push({
          method: String(input),
          body: String(init?.body ?? ""),
        });
        return new Response("ok", { status: 200 });
      },
    });
    await moderator.declineJoin({
      tenantId: "local",
      chatId: "-100",
      actorId: "83",
      queryId: "query83",
    });
    await moderator.deferJoin({
      tenantId: "local",
      chatId: "-100",
      actorId: "83",
      queryId: "query84",
    });
    expect(calls[0]?.method).toBe(
      `https://api.telegram.org/bot${token}/answerChatJoinRequestQuery`,
    );
    expect(calls[0]?.body).toContain('"chat_join_request_query_id":"query83"');
    expect(calls[0]?.body).toContain('"result":"decline"');
    expect(calls[0]?.body).not.toContain(phrase);
    expect(calls[0]?.body).not.toContain(token);
    expect(calls[0]?.body).not.toContain("declineChatJoinRequest");
    expect(calls[1]?.method).toBe(
      `https://api.telegram.org/bot${token}/answerChatJoinRequestQuery`,
    );
    expect(calls[1]?.body).toContain('"chat_join_request_query_id":"query84"');
    expect(calls[1]?.body).toContain('"result":"queue"');
    expect(calls[1]?.body).not.toContain('"result":"approve"');
    expect(calls[1]?.body).not.toContain(phrase);
  });

  it("keeps restrictions inside Telegram's temporary range", async () => {
    const bodies: string[] = [];
    const day = 24 * 60 * 60;
    const now = 1_700_000_000;
    const moderator = createTelegramModerator({
      token: "bot-token",
      nowSeconds: () => now,
      fetchImpl: async (_input, init) => {
        bodies.push(String(init?.body ?? ""));
        return new Response("ok", { status: 200 });
      },
    });
    const target = {
      tenantId: "local",
      chatId: "-100",
      actorId: "77",
    };
    await moderator.restrictActor({ ...target, durationSeconds: 1 });
    await moderator.muteActor({
      ...target,
      durationSeconds: 366 * day + 1,
    });
    await moderator.restrictActor({ ...target, durationSeconds: 30 });
    await moderator.muteActor({ ...target, durationSeconds: 366 * day });
    expect(bodies[0]).toContain(`"until_date":${now + 30}`);
    expect(bodies[1]).toContain(`"until_date":${now + 366 * day}`);
    expect(bodies[2]).toContain(`"until_date":${now + 30}`);
    expect(bodies[3]).toContain(`"until_date":${now + 366 * day}`);
    expect(bodies.join("")).not.toContain("bot-token");
  });
});
