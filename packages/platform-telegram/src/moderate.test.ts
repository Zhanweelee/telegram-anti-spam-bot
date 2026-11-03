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

  it("unbans only a user who is already banned", async () => {
    const calls: { method: string; body: string }[] = [];
    const moderator = createTelegramModerator({
      token: "bot-token",
      fetchImpl: async (input, init) => {
        const url = String(input);
        calls.push({
          method: url.slice(url.lastIndexOf("/") + 1),
          body: String(init?.body ?? ""),
        });
        return new Response("ok", { status: 200 });
      },
    });
    await moderator.unbanActor({
      tenantId: "local",
      chatId: "-100",
      actorId: "77",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("unbanChatMember");
    expect(calls[0]?.body).toContain('"chat_id":-100');
    expect(calls[0]?.body).toContain('"user_id":77');
    expect(calls[0]?.body).toContain('"only_if_banned":true');
    expect(calls[0]?.body).not.toContain("revoke_messages");
    await expect(
      createTelegramModerator({ token: "  " }).unbanActor({
        tenantId: "local",
        chatId: "-100",
        actorId: "77",
      }),
    ).rejects.toThrow("unban_unavailable");
  });

  it("reads member standing and drops names and subscription dates", async () => {
    const phrase = "请免费领取礼品";
    const cases: {
      readonly result: Record<string, unknown>;
      readonly standing: unknown;
    }[] = [
      {
        result: { status: "creator", user: { id: 77, first_name: phrase } },
        standing: { status: "creator" },
      },
      {
        result: {
          status: "member",
          until_date: 1_700_000_000,
          tag: phrase,
          user: { first_name: phrase },
        },
        standing: { status: "member" },
      },
      {
        result: {
          status: "kicked",
          until_date: 0,
          user: { first_name: phrase },
        },
        standing: { status: "kicked", untilDate: null },
      },
      {
        result: {
          status: "restricted",
          is_member: false,
          until_date: 1_700_000_000,
          user: { first_name: phrase },
        },
        standing: {
          status: "restricted",
          inChat: false,
          untilDate: 1_700_000_000,
        },
      },
    ];
    for (const item of cases) {
      const calls: string[] = [];
      const moderator = createTelegramModerator({
        token: "bot-token",
        fetchImpl: async (_input, init) => {
          calls.push(String(init?.body ?? ""));
          return new Response(
            JSON.stringify({ ok: true, result: item.result }),
            { status: 200 },
          );
        },
      });
      const standing = await moderator.readMember({
        tenantId: "local",
        chatId: "-100",
        actorId: "77",
      });
      expect(standing).toEqual(item.standing);
      expect(JSON.stringify(standing)).not.toContain(phrase);
      expect(calls).toEqual(['{"chat_id":-100,"user_id":77}']);
    }
    await expect(
      createTelegramModerator({
        token: "bot-token",
        fetchImpl: async () =>
          new Response(
            JSON.stringify({ ok: true, result: { status: "vip" } }),
            {
              status: 200,
            },
          ),
      }).readMember({ tenantId: "local", chatId: "-100", actorId: "77" }),
    ).rejects.toThrow("member_failed");
    const leaked = createTelegramModerator({
      token: "bot-token",
      fetchImpl: async () =>
        new Response(JSON.stringify({ ok: false, description: phrase }), {
          status: 400,
        }),
    });
    await expect(
      leaked.readMember({ tenantId: "local", chatId: "-100", actorId: "77" }),
    ).rejects.toThrow("member_failed");
    await leaked
      .readMember({ tenantId: "local", chatId: "-100", actorId: "77" })
      .catch((error: unknown) => {
        expect(error).toBeInstanceOf(Error);
        if (error instanceof Error) {
          expect(error.message).toBe("member_failed");
          expect(error.message).not.toContain(phrase);
        }
      });
    let called = false;
    await expect(
      createTelegramModerator({
        token: " ",
        fetchImpl: async () => {
          called = true;
          return new Response("ok", { status: 200 });
        },
      }).readMember({ tenantId: "local", chatId: "-100", actorId: "77" }),
    ).rejects.toThrow("member_unavailable");
    expect(called).toBe(false);
  });

  it("lifts restrictions only when the member is restricted", async () => {
    const phrase = "请免费领取礼品";
    const calls: { method: string; body: string }[] = [];
    let status = "restricted";
    let member = true;
    const moderator = createTelegramModerator({
      token: "bot-token",
      fetchImpl: async (input, init) => {
        const url = String(input);
        const method = url.slice(url.lastIndexOf("/") + 1);
        const body = String(init?.body ?? "");
        calls.push({ method, body });
        if (method === "getChatMember") {
          return new Response(
            JSON.stringify({
              ok: true,
              result: {
                status,
                is_member: member,
                user: { id: 77, first_name: phrase },
              },
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ ok: true, result: true }), {
          status: 200,
        });
      },
    });
    expect(
      await moderator.unmuteActor({
        tenantId: "local",
        chatId: "-100",
        actorId: "77",
      }),
    ).toBe("lifted");
    expect(calls.map((call) => call.method)).toEqual([
      "getChatMember",
      "restrictChatMember",
    ]);
    expect(calls[0]?.body).toContain('"user_id":77');
    expect(calls[1]?.body).toContain('"can_send_messages":true');
    expect(calls[1]?.body).toContain('"can_react_to_messages":true');
    expect(calls[1]?.body).toContain('"can_edit_tag":true');
    expect(calls[1]?.body).toContain('"use_independent_chat_permissions":true');
    expect(calls[1]?.body).not.toContain("until_date");
    expect(JSON.stringify(calls)).not.toContain(phrase);

    calls.length = 0;
    member = false;
    expect(
      await moderator.unmuteActor({
        tenantId: "local",
        chatId: "-100",
        actorId: "77",
      }),
    ).toBe("lifted");
    expect(calls.map((call) => call.method)).toEqual([
      "getChatMember",
      "restrictChatMember",
    ]);

    calls.length = 0;
    status = "member";
    expect(
      await moderator.unmuteActor({
        tenantId: "local",
        chatId: "-100",
        actorId: "77",
      }),
    ).toBe("absent");
    expect(calls.map((call) => call.method)).toEqual(["getChatMember"]);

    await expect(
      createTelegramModerator({
        token: "bot-token",
        fetchImpl: async () =>
          new Response(JSON.stringify({ description: phrase }), {
            status: 400,
          }),
      }).unmuteActor({
        tenantId: "local",
        chatId: "-100",
        actorId: "77",
      }),
    ).rejects.toThrow("unmute_failed");
    await createTelegramModerator({
      token: "bot-token",
      fetchImpl: async () =>
        new Response(JSON.stringify({ description: phrase }), { status: 400 }),
    })
      .unmuteActor({
        tenantId: "local",
        chatId: "-100",
        actorId: "77",
      })
      .catch((error: unknown) => {
        expect(error).toBeInstanceOf(Error);
        if (error instanceof Error) {
          expect(error.message).toBe("unmute_failed");
          expect(error.message).not.toContain(phrase);
        }
      });
    await expect(
      createTelegramModerator({ token: " " }).unmuteActor({
        tenantId: "local",
        chatId: "-100",
        actorId: "77",
      }),
    ).rejects.toThrow("unmute_unavailable");
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
