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

  it("clears recent reactions for a user or a sender chat", async () => {
    const token = "bot-token";
    const phrase = "请免费领取礼品";
    const calls: { method: string; body: string }[] = [];
    let called = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      called = true;
      calls.push({
        method: String(input),
        body: String(init?.body ?? ""),
      });
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
      });
    };
    const moderator = createTelegramModerator({ token, fetchImpl });
    await moderator.clearReactions({
      tenantId: "local",
      chatId: "-100",
      actorId: "77",
      kind: "user",
    });
    await moderator.clearReactions({
      tenantId: "local",
      chatId: "-100",
      actorId: "-1005",
      kind: "chat",
    });
    expect(calls.map((call) => call.method)).toEqual([
      `https://api.telegram.org/bot${token}/deleteAllMessageReactions`,
      `https://api.telegram.org/bot${token}/deleteAllMessageReactions`,
    ]);
    const userBody = JSON.parse(calls[0]?.body ?? "{}") as {
      user_id?: number;
      actor_chat_id?: number;
    };
    const chatBody = JSON.parse(calls[1]?.body ?? "{}") as {
      user_id?: number;
      actor_chat_id?: number;
    };
    expect(userBody.user_id).toBe(77);
    expect(userBody.actor_chat_id).toBeUndefined();
    expect(chatBody.actor_chat_id).toBe(-1005);
    expect(chatBody.user_id).toBeUndefined();
    expect(calls[0]?.body).toContain('"chat_id":-100');
    expect(calls[0]?.body).not.toContain("message_id");
    expect(calls[0]?.body).not.toContain(phrase);
    expect(calls[0]?.body).not.toContain(token);
    called = false;
    await expect(
      createTelegramModerator({
        token: " ",
        fetchImpl,
      }).clearReactions({
        tenantId: "local",
        chatId: "-100",
        actorId: "77",
        kind: "user",
      }),
    ).rejects.toThrow("reactions_unavailable");
    expect(called).toBe(false);
  });

  it("revokes one bot invite link and drops the returned link", async () => {
    const token = "bot-token";
    const phrase = "请免费领取礼品";
    const code = "AbCdEfGhIjKlMnOp";
    const link = `https://t.me/+${code}`;
    const calls: { method: string; body: string }[] = [];
    let called = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      called = true;
      calls.push({
        method: String(input),
        body: String(init?.body ?? ""),
      });
      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            invite_link: link,
            name: phrase,
            creator: { id: 1, is_bot: false, first_name: phrase },
            is_primary: true,
            is_revoked: true,
          },
        }),
        { status: 200 },
      );
    };
    const moderator = createTelegramModerator({ token, fetchImpl });
    await expect(
      moderator.revokeInvite({
        tenantId: "local",
        chatId: "-100",
        inviteLink: link,
      }),
    ).resolves.toBeUndefined();
    expect(calls.map((call) => call.method)).toEqual([
      `https://api.telegram.org/bot${token}/revokeChatInviteLink`,
    ]);
    const body = JSON.parse(calls[0]?.body ?? "{}") as {
      chat_id?: number;
      invite_link?: string;
      name?: string;
    };
    expect(body.chat_id).toBe(-100);
    expect(body.invite_link).toBe(link);
    expect(body.name).toBeUndefined();
    expect(calls[0]?.body).not.toContain("user_id");
    expect(calls[0]?.body).not.toContain(token);
    expect(calls[0]?.body).not.toContain(phrase);
    called = false;
    await expect(
      createTelegramModerator({ token, fetchImpl }).revokeInvite({
        tenantId: "local",
        chatId: "-100",
        inviteLink: phrase,
      }),
    ).rejects.toThrow("revoke_failed");
    expect(called).toBe(false);
    await expect(
      createTelegramModerator({ token: " ", fetchImpl }).revokeInvite({
        tenantId: "local",
        chatId: "-100",
        inviteLink: link,
      }),
    ).rejects.toThrow("revoke_unavailable");
    expect(called).toBe(false);
  });

  it("clears every chat pin without deleting messages", async () => {
    const token = "bot-token";
    const phrase = "请免费领取礼品";
    const calls: { method: string; body: string }[] = [];
    let called = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      called = true;
      calls.push({
        method: String(input),
        body: String(init?.body ?? ""),
      });
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
      });
    };
    const moderator = createTelegramModerator({ token, fetchImpl });
    await moderator.unpinChat({ tenantId: "local", chatId: "-100" });
    expect(calls.map((call) => call.method)).toEqual([
      `https://api.telegram.org/bot${token}/unpinAllChatMessages`,
    ]);
    const body = JSON.parse(calls[0]?.body ?? "{}") as {
      chat_id?: number;
      message_id?: number;
      message_thread_id?: number;
    };
    expect(body.chat_id).toBe(-100);
    expect(body.message_id).toBeUndefined();
    expect(body.message_thread_id).toBeUndefined();
    expect(calls[0]?.body).not.toContain(phrase);
    expect(calls[0]?.body).not.toContain(token);
    called = false;
    await expect(
      createTelegramModerator({ token: " ", fetchImpl }).unpinChat({
        tenantId: "local",
        chatId: "-100",
      }),
    ).rejects.toThrow("unpin_unavailable");
    expect(called).toBe(false);
  });

  it("lists administrators and drops names", async () => {
    const token = "bot-token";
    const phrase = "请免费领取礼品";
    const calls: { method: string; body: string }[] = [];
    let called = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      called = true;
      calls.push({
        method: String(input),
        body: String(init?.body ?? ""),
      });
      return new Response(
        JSON.stringify({
          ok: true,
          result: [
            {
              status: "creator",
              user: {
                id: 42,
                is_bot: true,
                first_name: phrase,
                username: "spam_bot",
              },
              is_anonymous: true,
              custom_title: phrase,
              can_delete_messages: true,
            },
            {
              status: "administrator",
              user: { id: 77, is_bot: false, first_name: phrase },
              can_be_edited: true,
              is_anonymous: false,
              can_delete_messages: true,
              can_restrict_members: false,
              can_invite_users: true,
              can_pin_messages: true,
              custom_title: phrase,
            },
            {
              status: "administrator",
              user: { id: 88, is_bot: true, first_name: phrase },
              can_be_edited: true,
              can_manage_chat: true,
              can_delete_messages: true,
              can_manage_video_chats: true,
              can_restrict_members: true,
              can_promote_members: true,
              can_change_info: true,
              can_invite_users: true,
              can_post_stories: true,
              can_edit_stories: true,
              can_delete_stories: true,
              can_post_messages: true,
              can_edit_messages: true,
              can_pin_messages: true,
              can_manage_topics: true,
              can_manage_direct_messages: true,
              can_manage_tags: true,
              can_send_welcome_messages: true,
              custom_title: phrase,
            },
          ],
        }),
        { status: 200 },
      );
    };
    const moderator = createTelegramModerator({ token, fetchImpl });
    const admins = await moderator.readAdministrators({
      tenantId: "local",
      chatId: "-100",
    });
    expect(calls.map((call) => call.method)).toEqual([
      `https://api.telegram.org/bot${token}/getChatAdministrators`,
    ]);
    const body = JSON.parse(calls[0]?.body ?? "{}") as {
      chat_id?: number;
      return_bots?: boolean;
    };
    expect(body.chat_id).toBe(-100);
    expect(body.return_bots).toBe(true);
    expect(calls[0]?.body).not.toContain(phrase);
    expect(calls[0]?.body).not.toContain(token);
    expect(JSON.stringify(admins)).not.toContain(phrase);
    expect(JSON.stringify(admins)).not.toContain("spam_bot");
    expect(admins).toEqual([
      {
        actorId: "42",
        bot: true,
        role: "creator",
        anonymous: true,
        rights: [],
      },
      {
        actorId: "77",
        bot: false,
        role: "administrator",
        anonymous: false,
        rights: ["deleteMessages", "inviteUsers", "pinMessages"],
      },
      {
        actorId: "88",
        bot: true,
        role: "administrator",
        anonymous: false,
        rights: [
          "manageChat",
          "deleteMessages",
          "manageVideoChats",
          "restrictMembers",
          "promoteMembers",
          "changeInfo",
          "inviteUsers",
          "postStories",
          "editStories",
          "deleteStories",
          "postMessages",
          "editMessages",
          "pinMessages",
          "manageTopics",
          "manageDirectMessages",
          "manageTags",
          "sendWelcomeMessages",
        ],
      },
    ]);
    called = false;
    await expect(
      createTelegramModerator({
        token,
        fetchImpl: async () =>
          new Response(
            JSON.stringify({ ok: true, result: { title: phrase } }),
            {
              status: 200,
            },
          ),
      }).readAdministrators({ tenantId: "local", chatId: "-100" }),
    ).rejects.toThrow("admins_failed");
    await expect(
      createTelegramModerator({ token: " ", fetchImpl }).readAdministrators({
        tenantId: "local",
        chatId: "-100",
      }),
    ).rejects.toThrow("admins_unavailable");
    expect(called).toBe(false);
  });

  it("clears pins in the General topic or one forum topic", async () => {
    const token = "bot-token";
    const phrase = "请免费领取礼品";
    const calls: { method: string; body: string }[] = [];
    let called = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      called = true;
      calls.push({
        method: String(input),
        body: String(init?.body ?? ""),
      });
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
      });
    };
    const moderator = createTelegramModerator({ token, fetchImpl });
    await moderator.unpinTopic({ tenantId: "local", chatId: "-100" });
    await moderator.unpinTopic({
      tenantId: "local",
      chatId: "-100",
      threadId: "55",
    });
    expect(calls.map((call) => call.method)).toEqual([
      `https://api.telegram.org/bot${token}/unpinAllGeneralForumTopicMessages`,
      `https://api.telegram.org/bot${token}/unpinAllForumTopicMessages`,
    ]);
    const general = JSON.parse(calls[0]?.body ?? "{}") as {
      chat_id?: number;
      message_thread_id?: number;
      message_id?: number;
    };
    const topic = JSON.parse(calls[1]?.body ?? "{}") as {
      chat_id?: number;
      message_thread_id?: number;
      message_id?: number;
    };
    expect(general.chat_id).toBe(-100);
    expect(general.message_thread_id).toBeUndefined();
    expect(general.message_id).toBeUndefined();
    expect(topic.chat_id).toBe(-100);
    expect(topic.message_thread_id).toBe(55);
    expect(topic.message_id).toBeUndefined();
    expect(calls[0]?.body).not.toContain(phrase);
    expect(calls[0]?.body).not.toContain(token);
    called = false;
    await expect(
      createTelegramModerator({ token: " ", fetchImpl }).unpinTopic({
        tenantId: "local",
        chatId: "-100",
      }),
    ).rejects.toThrow("untopic_unavailable");
    expect(called).toBe(false);
  });

  it("closes the General topic or one forum topic", async () => {
    const token = "bot-token";
    const phrase = "请免费领取礼品";
    const calls: { method: string; body: string }[] = [];
    let called = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      called = true;
      calls.push({
        method: String(input),
        body: String(init?.body ?? ""),
      });
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
      });
    };
    const moderator = createTelegramModerator({ token, fetchImpl });
    await moderator.closeTopic({ tenantId: "local", chatId: "-100" });
    await moderator.closeTopic({
      tenantId: "local",
      chatId: "-100",
      threadId: "1",
    });
    expect(calls.map((call) => call.method)).toEqual([
      `https://api.telegram.org/bot${token}/closeGeneralForumTopic`,
      `https://api.telegram.org/bot${token}/closeForumTopic`,
    ]);
    const general = JSON.parse(calls[0]?.body ?? "{}") as {
      chat_id?: number;
      message_thread_id?: number;
      message_id?: number;
    };
    const topic = JSON.parse(calls[1]?.body ?? "{}") as {
      chat_id?: number;
      message_thread_id?: number;
      message_id?: number;
    };
    expect(general.chat_id).toBe(-100);
    expect(general.message_thread_id).toBeUndefined();
    expect(general.message_id).toBeUndefined();
    expect(topic.chat_id).toBe(-100);
    expect(topic.message_thread_id).toBe(1);
    expect(topic.message_id).toBeUndefined();
    expect(calls[0]?.body).not.toContain(phrase);
    expect(calls[0]?.body).not.toContain(token);
    called = false;
    await expect(
      createTelegramModerator({ token: " ", fetchImpl }).closeTopic({
        tenantId: "local",
        chatId: "-100",
      }),
    ).rejects.toThrow("closetopic_unavailable");
    expect(called).toBe(false);
  });

  it("reopens the General topic or one forum topic", async () => {
    const token = "bot-token";
    const phrase = "请免费领取礼品";
    const calls: { method: string; body: string }[] = [];
    let called = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      called = true;
      calls.push({
        method: String(input),
        body: String(init?.body ?? ""),
      });
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
      });
    };
    const moderator = createTelegramModerator({ token, fetchImpl });
    await moderator.openTopic({ tenantId: "local", chatId: "-100" });
    await moderator.openTopic({
      tenantId: "local",
      chatId: "-100",
      threadId: "1",
    });
    expect(calls.map((call) => call.method)).toEqual([
      `https://api.telegram.org/bot${token}/reopenGeneralForumTopic`,
      `https://api.telegram.org/bot${token}/reopenForumTopic`,
    ]);
    const general = JSON.parse(calls[0]?.body ?? "{}") as {
      chat_id?: number;
      message_thread_id?: number;
      message_id?: number;
    };
    const topic = JSON.parse(calls[1]?.body ?? "{}") as {
      chat_id?: number;
      message_thread_id?: number;
      message_id?: number;
    };
    expect(general.chat_id).toBe(-100);
    expect(general.message_thread_id).toBeUndefined();
    expect(general.message_id).toBeUndefined();
    expect(topic.chat_id).toBe(-100);
    expect(topic.message_thread_id).toBe(1);
    expect(topic.message_id).toBeUndefined();
    expect(calls[0]?.body).not.toContain(phrase);
    expect(calls[0]?.body).not.toContain(token);
    called = false;
    await expect(
      createTelegramModerator({ token: " ", fetchImpl }).openTopic({
        tenantId: "local",
        chatId: "-100",
      }),
    ).rejects.toThrow("opentopic_unavailable");
    expect(called).toBe(false);
  });

  it("hides the General topic without a thread id", async () => {
    const token = "bot-token";
    const phrase = "请免费领取礼品";
    const calls: { method: string; body: string }[] = [];
    let called = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      called = true;
      calls.push({
        method: String(input),
        body: String(init?.body ?? ""),
      });
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
      });
    };
    const moderator = createTelegramModerator({ token, fetchImpl });
    await moderator.hideGeneral({ tenantId: "local", chatId: "-100" });
    expect(calls.map((call) => call.method)).toEqual([
      `https://api.telegram.org/bot${token}/hideGeneralForumTopic`,
    ]);
    const body = JSON.parse(calls[0]?.body ?? "{}") as {
      chat_id?: number;
      message_thread_id?: number;
      message_id?: number;
    };
    expect(body.chat_id).toBe(-100);
    expect(body.message_thread_id).toBeUndefined();
    expect(body.message_id).toBeUndefined();
    expect(calls[0]?.body).not.toContain(phrase);
    expect(calls[0]?.body).not.toContain(token);
    called = false;
    await expect(
      createTelegramModerator({ token: " ", fetchImpl }).hideGeneral({
        tenantId: "local",
        chatId: "-100",
      }),
    ).rejects.toThrow("hidegeneral_unavailable");
    expect(called).toBe(false);
  });

  it("shows the General topic without reopening it", async () => {
    const token = "bot-token";
    const phrase = "请免费领取礼品";
    const calls: { method: string; body: string }[] = [];
    let called = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      called = true;
      calls.push({
        method: String(input),
        body: String(init?.body ?? ""),
      });
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
      });
    };
    const moderator = createTelegramModerator({ token, fetchImpl });
    await moderator.showGeneral({ tenantId: "local", chatId: "-100" });
    expect(calls.map((call) => call.method)).toEqual([
      `https://api.telegram.org/bot${token}/unhideGeneralForumTopic`,
    ]);
    const body = JSON.parse(calls[0]?.body ?? "{}") as {
      chat_id?: number;
      message_thread_id?: number;
      message_id?: number;
    };
    expect(body.chat_id).toBe(-100);
    expect(body.message_thread_id).toBeUndefined();
    expect(body.message_id).toBeUndefined();
    expect(calls[0]?.method).not.toContain("reopen");
    expect(calls[0]?.body).not.toContain(phrase);
    expect(calls[0]?.body).not.toContain(token);
    called = false;
    await expect(
      createTelegramModerator({ token: " ", fetchImpl }).showGeneral({
        tenantId: "local",
        chatId: "-100",
      }),
    ).rejects.toThrow("showgeneral_unavailable");
    expect(called).toBe(false);
  });

  it("deletes one forum topic and the messages inside it", async () => {
    const token = "bot-token";
    const phrase = "请免费领取礼品";
    const calls: { method: string; body: string }[] = [];
    let called = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      called = true;
      calls.push({
        method: String(input),
        body: String(init?.body ?? ""),
      });
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
      });
    };
    const moderator = createTelegramModerator({ token, fetchImpl });
    await moderator.deleteTopic({
      tenantId: "local",
      chatId: "-100",
      threadId: "1",
    });
    expect(calls.map((call) => call.method)).toEqual([
      `https://api.telegram.org/bot${token}/deleteForumTopic`,
    ]);
    const body = JSON.parse(calls[0]?.body ?? "{}") as {
      chat_id?: number;
      message_thread_id?: number;
      message_id?: number;
    };
    expect(body.chat_id).toBe(-100);
    expect(body.message_thread_id).toBe(1);
    expect(body.message_id).toBeUndefined();
    expect(calls[0]?.body).not.toContain(phrase);
    expect(calls[0]?.body).not.toContain(token);
    called = false;
    await expect(
      createTelegramModerator({ token: " ", fetchImpl }).deleteTopic({
        tenantId: "local",
        chatId: "-100",
        threadId: "55",
      }),
    ).rejects.toThrow("deltopic_unavailable");
    expect(called).toBe(false);
  });

  it("reads a member count and drops every other chat field", async () => {
    const token = "bot-token";
    const phrase = "请免费领取礼品";
    const calls: { method: string; body: string }[] = [];
    let called = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      called = true;
      calls.push({
        method: String(input),
        body: String(init?.body ?? ""),
      });
      return new Response(JSON.stringify({ ok: true, result: 42 }), {
        status: 200,
      });
    };
    const moderator = createTelegramModerator({ token, fetchImpl });
    await expect(
      moderator.readMemberCount({ tenantId: "local", chatId: "-100" }),
    ).resolves.toBe(42);
    expect(calls.map((call) => call.method)).toEqual([
      `https://api.telegram.org/bot${token}/getChatMemberCount`,
    ]);
    const body = JSON.parse(calls[0]?.body ?? "{}") as {
      chat_id?: number;
      invite_link?: string;
    };
    expect(body.chat_id).toBe(-100);
    expect(body.invite_link).toBeUndefined();
    expect(calls[0]?.body).not.toContain(phrase);
    expect(calls[0]?.body).not.toContain(token);
    const fractional: typeof fetch = async () =>
      new Response(JSON.stringify({ ok: true, result: 1.5 }), { status: 200 });
    await expect(
      createTelegramModerator({ token, fetchImpl: fractional }).readMemberCount(
        { tenantId: "local", chatId: "-100" },
      ),
    ).rejects.toThrow("count_failed");
    const negative: typeof fetch = async () =>
      new Response(JSON.stringify({ ok: true, result: -1 }), { status: 200 });
    await expect(
      createTelegramModerator({ token, fetchImpl: negative }).readMemberCount({
        tenantId: "local",
        chatId: "-100",
      }),
    ).rejects.toThrow("count_failed");
    called = false;
    await expect(
      createTelegramModerator({ token: " ", fetchImpl }).readMemberCount({
        tenantId: "local",
        chatId: "-100",
      }),
    ).rejects.toThrow("count_unavailable");
    expect(called).toBe(false);
  });

  it("counts chat boosts and drops the booster name", async () => {
    const token = "bot-token";
    const phrase = "请免费领取礼品";
    const calls: { method: string; body: string }[] = [];
    let called = false;
    const boost = {
      boost_id: "boost-secret",
      add_date: 1,
      expiration_date: 2,
      source: {
        source: "premium",
        user: { id: 77, first_name: phrase },
      },
    };
    const fetchImpl: typeof fetch = async (input, init) => {
      called = true;
      calls.push({
        method: String(input),
        body: String(init?.body ?? ""),
      });
      return new Response(
        JSON.stringify({ ok: true, result: { boosts: [boost, boost] } }),
        { status: 200 },
      );
    };
    const moderator = createTelegramModerator({ token, fetchImpl });
    await expect(
      moderator.readBoostCount({
        tenantId: "local",
        chatId: "-100",
        actorId: "77",
      }),
    ).resolves.toBe(2);
    expect(calls.map((call) => call.method)).toEqual([
      `https://api.telegram.org/bot${token}/getUserChatBoosts`,
    ]);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      chat_id: -100,
      user_id: 77,
    });
    expect(calls[0]?.body).not.toContain(phrase);
    expect(calls[0]?.body).not.toContain(token);
    expect(calls[0]?.body).not.toContain("boost-secret");
    const empty: typeof fetch = async () =>
      new Response(JSON.stringify({ ok: true, result: { boosts: [] } }), {
        status: 200,
      });
    await expect(
      createTelegramModerator({ token, fetchImpl: empty }).readBoostCount({
        tenantId: "local",
        chatId: "-100",
        actorId: "77",
      }),
    ).resolves.toBe(0);
    const missing: typeof fetch = async () =>
      new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    await expect(
      createTelegramModerator({ token, fetchImpl: missing }).readBoostCount({
        tenantId: "local",
        chatId: "-100",
        actorId: "77",
      }),
    ).rejects.toThrow("boosts_failed");
    called = false;
    await expect(
      createTelegramModerator({ token: " ", fetchImpl }).readBoostCount({
        tenantId: "local",
        chatId: "-100",
        actorId: "77",
      }),
    ).rejects.toThrow("boosts_unavailable");
    expect(called).toBe(false);
  });

  it("pins one message without clearing the other pins", async () => {
    const token = "bot-token";
    const phrase = "请免费领取礼品";
    const calls: { method: string; body: string }[] = [];
    let called = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      called = true;
      calls.push({
        method: String(input),
        body: String(init?.body ?? ""),
      });
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
      });
    };
    const moderator = createTelegramModerator({ token, fetchImpl });
    await moderator.pinMessage({
      tenantId: "local",
      chatId: "-100",
      messageId: "1",
    });
    expect(calls.map((call) => call.method)).toEqual([
      `https://api.telegram.org/bot${token}/pinChatMessage`,
    ]);
    const body = JSON.parse(calls[0]?.body ?? "{}") as {
      chat_id?: number;
      message_id?: number;
      message_thread_id?: number;
      disable_notification?: boolean;
      business_connection_id?: string;
    };
    expect(body.chat_id).toBe(-100);
    expect(body.message_id).toBe(1);
    expect(body.message_thread_id).toBeUndefined();
    expect(body.disable_notification).toBeUndefined();
    expect(body.business_connection_id).toBeUndefined();
    expect(calls[0]?.method).not.toContain("unpin");
    expect(calls[0]?.method).not.toContain("delete");
    expect(calls[0]?.body).not.toContain(phrase);
    expect(calls[0]?.body).not.toContain(token);
    called = false;
    await expect(
      createTelegramModerator({ token: " ", fetchImpl }).pinMessage({
        tenantId: "local",
        chatId: "-100",
        messageId: "55",
      }),
    ).rejects.toThrow("pin_unavailable");
    expect(called).toBe(false);
  });

  it("unpins one message and leaves the other pins", async () => {
    const token = "bot-token";
    const phrase = "请免费领取礼品";
    const calls: { method: string; body: string }[] = [];
    let called = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      called = true;
      calls.push({
        method: String(input),
        body: String(init?.body ?? ""),
      });
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
      });
    };
    const moderator = createTelegramModerator({ token, fetchImpl });
    await moderator.unpinMessage({
      tenantId: "local",
      chatId: "-100",
      messageId: "1",
    });
    expect(calls.map((call) => call.method)).toEqual([
      `https://api.telegram.org/bot${token}/unpinChatMessage`,
    ]);
    const body = JSON.parse(calls[0]?.body ?? "{}") as {
      chat_id?: number;
      message_id?: number;
      business_connection_id?: string;
    };
    expect(body.chat_id).toBe(-100);
    expect(body.message_id).toBe(1);
    expect(body.business_connection_id).toBeUndefined();
    expect(calls[0]?.method).not.toContain("unpinAll");
    expect(calls[0]?.method).not.toContain("/pinChatMessage");
    expect(calls[0]?.method).not.toContain("delete");
    expect(calls[0]?.body).not.toContain(phrase);
    expect(calls[0]?.body).not.toContain(token);
    called = false;
    await expect(
      createTelegramModerator({ token: " ", fetchImpl }).unpinMessage({
        tenantId: "local",
        chatId: "-100",
        messageId: "55",
      }),
    ).rejects.toThrow("unpinmsg_unavailable");
    expect(called).toBe(false);
  });

  it("removes one actor reaction from one message", async () => {
    const token = "bot-token";
    const phrase = "请免费领取礼品";
    const calls: { method: string; body: string }[] = [];
    let called = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      called = true;
      calls.push({
        method: String(input),
        body: String(init?.body ?? ""),
      });
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
      });
    };
    const moderator = createTelegramModerator({ token, fetchImpl });
    await moderator.removeReaction({
      tenantId: "local",
      chatId: "-100",
      messageId: "1",
      actorId: "77",
      kind: "user",
    });
    await moderator.removeReaction({
      tenantId: "local",
      chatId: "-100",
      messageId: "55",
      actorId: "-1005",
      kind: "chat",
    });
    expect(calls.map((call) => call.method)).toEqual([
      `https://api.telegram.org/bot${token}/deleteMessageReaction`,
      `https://api.telegram.org/bot${token}/deleteMessageReaction`,
    ]);
    const userBody = JSON.parse(calls[0]?.body ?? "{}") as {
      chat_id?: number;
      message_id?: number;
      user_id?: number;
      actor_chat_id?: number;
    };
    expect(userBody.chat_id).toBe(-100);
    expect(userBody.message_id).toBe(1);
    expect(userBody.user_id).toBe(77);
    expect(userBody.actor_chat_id).toBeUndefined();
    const chatBody = JSON.parse(calls[1]?.body ?? "{}") as {
      chat_id?: number;
      message_id?: number;
      user_id?: number;
      actor_chat_id?: number;
    };
    expect(chatBody.chat_id).toBe(-100);
    expect(chatBody.message_id).toBe(55);
    expect(chatBody.actor_chat_id).toBe(-1005);
    expect(chatBody.user_id).toBeUndefined();
    expect(calls[0]?.method).not.toContain("deleteAll");
    expect(calls[0]?.body).not.toContain(phrase);
    expect(calls[0]?.body).not.toContain(token);
    called = false;
    await expect(
      createTelegramModerator({ token: " ", fetchImpl }).removeReaction({
        tenantId: "local",
        chatId: "-100",
        messageId: "55",
        actorId: "77",
        kind: "user",
      }),
    ).rejects.toThrow("unreact_unavailable");
    expect(called).toBe(false);
  });

  it("deletes a chat photo and drops the file id", async () => {
    const token = "bot-token";
    const phrase = "请免费领取礼品";
    const calls: { method: string; body: string }[] = [];
    let called = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      called = true;
      calls.push({
        method: String(input),
        body: String(init?.body ?? ""),
      });
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
      });
    };
    const moderator = createTelegramModerator({ token, fetchImpl });
    await moderator.deletePhoto({ tenantId: "local", chatId: "-100" });
    expect(calls.map((call) => call.method)).toEqual([
      `https://api.telegram.org/bot${token}/deleteChatPhoto`,
    ]);
    const body = JSON.parse(calls[0]?.body ?? "{}") as {
      chat_id?: number;
      photo?: string;
    };
    expect(body.chat_id).toBe(-100);
    expect(body.photo).toBeUndefined();
    expect(calls[0]?.method).not.toContain("setChatPhoto");
    expect(calls[0]?.body).not.toContain(phrase);
    expect(calls[0]?.body).not.toContain(token);
    called = false;
    await expect(
      createTelegramModerator({ token: " ", fetchImpl }).deletePhoto({
        tenantId: "local",
        chatId: "-100",
      }),
    ).rejects.toThrow("delphoto_unavailable");
    expect(called).toBe(false);
  });

  it("leaves a chat and drops the title", async () => {
    const token = "bot-token";
    const phrase = "请免费领取礼品";
    const calls: { method: string; body: string }[] = [];
    let called = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      called = true;
      calls.push({
        method: String(input),
        body: String(init?.body ?? ""),
      });
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
      });
    };
    const moderator = createTelegramModerator({ token, fetchImpl });
    await moderator.leaveChat({ tenantId: "local", chatId: "-100" });
    expect(calls.map((call) => call.method)).toEqual([
      `https://api.telegram.org/bot${token}/leaveChat`,
    ]);
    const body = JSON.parse(calls[0]?.body ?? "{}") as {
      chat_id?: number;
      title?: string;
    };
    expect(body.chat_id).toBe(-100);
    expect(body.title).toBeUndefined();
    expect(calls[0]?.method).not.toContain("getChat");
    expect(calls[0]?.body).not.toContain(phrase);
    expect(calls[0]?.body).not.toContain(token);
    called = false;
    await expect(
      createTelegramModerator({ token: " ", fetchImpl }).leaveChat({
        tenantId: "local",
        chatId: "-100",
      }),
    ).rejects.toThrow("leave_unavailable");
    expect(called).toBe(false);
  });

  it("sets a member tag and keeps the name out of the body extras", async () => {
    const token = "bot-token";
    const phrase = "请免费领取礼品";
    const calls: { method: string; body: string }[] = [];
    let called = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      called = true;
      calls.push({
        method: String(input),
        body: String(init?.body ?? ""),
      });
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
      });
    };
    const moderator = createTelegramModerator({ token, fetchImpl });
    await moderator.setMemberTag({
      tenantId: "local",
      chatId: "-100",
      actorId: "77",
      tag: "",
    });
    await moderator.setMemberTag({
      tenantId: "local",
      chatId: "-100",
      actorId: "77",
      tag: "ops",
    });
    expect(calls.map((call) => call.method)).toEqual([
      `https://api.telegram.org/bot${token}/setChatMemberTag`,
      `https://api.telegram.org/bot${token}/setChatMemberTag`,
    ]);
    const cleared = JSON.parse(calls[0]?.body ?? "{}") as {
      chat_id?: number;
      user_id?: number;
      tag?: string;
      first_name?: string;
    };
    expect(cleared).toEqual({ chat_id: -100, user_id: 77, tag: "" });
    const set = JSON.parse(calls[1]?.body ?? "{}") as { tag?: string };
    expect(set.tag).toBe("ops");
    expect(calls[0]?.method).not.toContain("getChatMember");
    expect(calls[0]?.body).not.toContain(phrase);
    expect(calls[0]?.body).not.toContain(token);
    called = false;
    await expect(
      createTelegramModerator({ token: " ", fetchImpl }).setMemberTag({
        tenantId: "local",
        chatId: "-100",
        actorId: "77",
        tag: "ops",
      }),
    ).rejects.toThrow("tag_unavailable");
    expect(called).toBe(false);
  });

  it("deletes a group sticker set and drops the set name", async () => {
    const token = "bot-token";
    const phrase = "请免费领取礼品";
    const calls: { method: string; body: string }[] = [];
    let called = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      called = true;
      calls.push({
        method: String(input),
        body: String(init?.body ?? ""),
      });
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
      });
    };
    const moderator = createTelegramModerator({ token, fetchImpl });
    await moderator.deleteStickerSet({ tenantId: "local", chatId: "-100" });
    expect(calls.map((call) => call.method)).toEqual([
      `https://api.telegram.org/bot${token}/deleteChatStickerSet`,
    ]);
    const body = JSON.parse(calls[0]?.body ?? "{}") as {
      chat_id?: number;
      sticker_set_name?: string;
    };
    expect(body.chat_id).toBe(-100);
    expect(body.sticker_set_name).toBeUndefined();
    expect(calls[0]?.method).not.toContain("setChatStickerSet");
    expect(calls[0]?.body).not.toContain(phrase);
    expect(calls[0]?.body).not.toContain(token);
    called = false;
    await expect(
      createTelegramModerator({ token: " ", fetchImpl }).deleteStickerSet({
        tenantId: "local",
        chatId: "-100",
      }),
    ).rejects.toThrow("delstickers_unavailable");
    expect(called).toBe(false);
  });

  it("sets a group sticker set and drops the name", async () => {
    const token = "bot-token";
    const phrase = "请免费领取礼品";
    const name = "Animals_by_SomeBot";
    const calls: { method: string; body: string }[] = [];
    let called = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      called = true;
      calls.push({
        method: String(input),
        body: String(init?.body ?? ""),
      });
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
      });
    };
    const moderator = createTelegramModerator({ token, fetchImpl });
    await moderator.setStickerSet({
      tenantId: "local",
      chatId: "-100",
      name,
    });
    expect(calls.map((call) => call.method)).toEqual([
      `https://api.telegram.org/bot${token}/setChatStickerSet`,
    ]);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      chat_id: -100,
      sticker_set_name: name,
    });
    expect(calls[0]?.method).not.toContain("deleteChatStickerSet");
    expect(calls[0]?.method).not.toContain("getStickerSet");
    expect(calls[0]?.method).not.toContain("getChat");
    expect(calls[0]?.body).not.toContain(phrase);
    expect(calls[0]?.body).not.toContain(token);
    called = false;
    await expect(
      createTelegramModerator({ token: " ", fetchImpl }).setStickerSet({
        tenantId: "local",
        chatId: "-100",
        name,
      }),
    ).rejects.toThrow("stickers_unavailable");
    expect(called).toBe(false);
  });

  it("sets an admin title and drops the title", async () => {
    const token = "bot-token";
    const phrase = "请免费领取礼品";
    const calls: { method: string; body: string }[] = [];
    let called = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      called = true;
      calls.push({
        method: String(input),
        body: String(init?.body ?? ""),
      });
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
      });
    };
    const moderator = createTelegramModerator({ token, fetchImpl });
    await moderator.setAdminTitle({
      tenantId: "local",
      chatId: "-100",
      actorId: "77",
      title: phrase,
    });
    await moderator.setAdminTitle({
      tenantId: "local",
      chatId: "-100",
      actorId: "77",
      title: "",
    });
    expect(calls.map((call) => call.method)).toEqual([
      `https://api.telegram.org/bot${token}/setChatAdministratorCustomTitle`,
      `https://api.telegram.org/bot${token}/setChatAdministratorCustomTitle`,
    ]);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      chat_id: -100,
      user_id: 77,
      custom_title: phrase,
    });
    expect(JSON.parse(calls[1]?.body ?? "{}")).toEqual({
      chat_id: -100,
      user_id: 77,
      custom_title: "",
    });
    expect(calls[0]?.method).not.toContain("promoteChatMember");
    expect(calls[0]?.method).not.toContain("setChatMemberTag");
    expect(calls[0]?.method).not.toContain("getChat");
    expect(calls[0]?.body).not.toContain(token);
    called = false;
    await expect(
      createTelegramModerator({ token: " ", fetchImpl }).setAdminTitle({
        tenantId: "local",
        chatId: "-100",
        actorId: "77",
        title: phrase,
      }),
    ).rejects.toThrow("admintitle_unavailable");
    expect(called).toBe(false);
  });

  it("declines one suggested post and drops the comment", async () => {
    const token = "bot-token";
    const phrase = "请免费领取礼品";
    const calls: { method: string; body: string }[] = [];
    let called = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      called = true;
      calls.push({
        method: String(input),
        body: String(init?.body ?? ""),
      });
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
      });
    };
    const moderator = createTelegramModerator({ token, fetchImpl });
    await moderator.declinePost({
      tenantId: "local",
      chatId: "-100",
      messageId: "55",
    });
    await moderator.declinePost({
      tenantId: "local",
      chatId: "-100",
      messageId: "1",
      comment: phrase,
    });
    expect(calls.map((call) => call.method)).toEqual([
      `https://api.telegram.org/bot${token}/declineSuggestedPost`,
      `https://api.telegram.org/bot${token}/declineSuggestedPost`,
    ]);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      chat_id: -100,
      message_id: 55,
    });
    expect(calls[0]?.body).not.toContain("comment");
    expect(JSON.parse(calls[1]?.body ?? "{}")).toEqual({
      chat_id: -100,
      message_id: 1,
      comment: phrase,
    });
    expect(calls[0]?.method).not.toContain("approveSuggestedPost");
    expect(calls[0]?.method).not.toContain("declineChatJoinRequest");
    expect(calls[1]?.body).not.toContain("send_date");
    expect(calls[1]?.body).not.toContain(token);
    called = false;
    await expect(
      createTelegramModerator({ token: " ", fetchImpl }).declinePost({
        tenantId: "local",
        chatId: "-100",
        messageId: "55",
        comment: phrase,
      }),
    ).rejects.toThrow("declinepost_unavailable");
    expect(called).toBe(false);
  });

  it("reads the default bot name and drops extra fields", async () => {
    const token = "bot-token";
    const phrase = "请免费领取礼品";
    const calls: { method: string; body: string }[] = [];
    let called = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      called = true;
      calls.push({
        method: String(input),
        body: String(init?.body ?? ""),
      });
      return new Response(
        JSON.stringify({
          ok: true,
          result: { name: phrase, note: phrase },
        }),
        { status: 200 },
      );
    };
    const moderator = createTelegramModerator({ token, fetchImpl });
    await expect(moderator.readBotName({ tenantId: "local" })).resolves.toBe(
      phrase,
    );
    expect(calls.map((call) => call.method)).toEqual([
      `https://api.telegram.org/bot${token}/getMyName`,
    ]);
    expect(calls[0]?.method).not.toContain("setMyName");
    expect(JSON.parse(calls[0]?.body ?? "null")).toEqual({});
    expect(calls[0]?.body).not.toContain("language_code");
    expect(calls[0]?.body).not.toContain(phrase);
    expect(calls[0]?.body).not.toContain(token);
    await expect(
      createTelegramModerator({
        token,
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: true, result: { name: "" } }), {
            status: 200,
          }),
      }).readBotName({ tenantId: "local" }),
    ).resolves.toBe("");
    called = false;
    await expect(
      createTelegramModerator({ token: " ", fetchImpl }).readBotName({
        tenantId: "local",
      }),
    ).rejects.toThrow("myname_unavailable");
    expect(called).toBe(false);
    await expect(
      createTelegramModerator({
        token,
        fetchImpl: async () =>
          new Response(
            JSON.stringify({ ok: true, result: { name: `${phrase}\n` } }),
            { status: 200 },
          ),
      }).readBotName({ tenantId: "local" }),
    ).rejects.toThrow("myname_failed");
    await expect(
      createTelegramModerator({
        token,
        fetchImpl: async () =>
          new Response(
            JSON.stringify({ ok: true, result: { name: "x".repeat(65) } }),
            {
              status: 200,
            },
          ),
      }).readBotName({ tenantId: "local" }),
    ).rejects.toThrow("myname_failed");
  });

  it("sets the bot name without a language", async () => {
    const token = "bot-token";
    const phrase = "请免费领取礼品";
    const calls: { method: string; body: string }[] = [];
    let called = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      called = true;
      calls.push({
        method: String(input),
        body: String(init?.body ?? ""),
      });
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
      });
    };
    const moderator = createTelegramModerator({ token, fetchImpl });
    await moderator.setBotName({ tenantId: "local", name: phrase });
    await moderator.setBotName({ tenantId: "local", name: "" });
    expect(calls.map((call) => call.method)).toEqual([
      `https://api.telegram.org/bot${token}/setMyName`,
      `https://api.telegram.org/bot${token}/setMyName`,
    ]);
    expect(calls[0]?.method).not.toContain("getMyName");
    expect(JSON.parse(calls[0]?.body ?? "null")).toEqual({ name: phrase });
    expect(JSON.parse(calls[1]?.body ?? "null")).toEqual({ name: "" });
    expect(calls[0]?.body).not.toContain("language_code");
    expect(calls[0]?.body).not.toContain(token);
    called = false;
    await expect(
      createTelegramModerator({ token: " ", fetchImpl }).setBotName({
        tenantId: "local",
        name: phrase,
      }),
    ).rejects.toThrow("botname_unavailable");
    expect(called).toBe(false);
  });

  it("reads the default menu button and drops the web app", async () => {
    const token = "bot-token";
    const phrase = "请免费领取礼品";
    const calls: { method: string; body: string }[] = [];
    let called = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      called = true;
      calls.push({
        method: String(input),
        body: String(init?.body ?? ""),
      });
      return new Response(
        JSON.stringify({
          ok: true,
          result: { type: "commands", note: phrase },
        }),
        { status: 200 },
      );
    };
    const moderator = createTelegramModerator({ token, fetchImpl });
    await expect(moderator.readMenuButton({ tenantId: "local" })).resolves.toBe(
      "commands",
    );
    expect(calls.map((call) => call.method)).toEqual([
      `https://api.telegram.org/bot${token}/getChatMenuButton`,
    ]);
    expect(calls[0]?.method).not.toContain("setChatMenuButton");
    expect(JSON.parse(calls[0]?.body ?? "null")).toEqual({});
    expect(calls[0]?.body).not.toContain("chat_id");
    expect(calls[0]?.body).not.toContain(phrase);
    expect(calls[0]?.body).not.toContain(token);
    await expect(
      createTelegramModerator({
        token,
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              ok: true,
              result: {
                type: "web_app",
                text: phrase,
                web_app: { url: `https://evil.example/${phrase}` },
              },
            }),
            { status: 200 },
          ),
      }).readMenuButton({ tenantId: "local" }),
    ).resolves.toBe("web_app");
    await expect(
      createTelegramModerator({
        token,
        fetchImpl: async () =>
          new Response(
            JSON.stringify({ ok: true, result: { type: "default" } }),
            {
              status: 200,
            },
          ),
      }).readMenuButton({ tenantId: "local" }),
    ).resolves.toBe("default");
    called = false;
    await expect(
      createTelegramModerator({ token: " ", fetchImpl }).readMenuButton({
        tenantId: "local",
      }),
    ).rejects.toThrow("button_unavailable");
    expect(called).toBe(false);
    await expect(
      createTelegramModerator({
        token,
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: true, result: { type: "apps" } }), {
            status: 200,
          }),
      }).readMenuButton({ tenantId: "local" }),
    ).rejects.toThrow("button_failed");
    await expect(
      createTelegramModerator({
        token,
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: true, result: null }), {
            status: 200,
          }),
      }).readMenuButton({ tenantId: "local" }),
    ).rejects.toThrow("button_failed");
  });

  it("sets the default menu button without a web app", async () => {
    const token = "bot-token";
    const phrase = "请免费领取礼品";
    const calls: { method: string; body: string }[] = [];
    let called = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      called = true;
      calls.push({
        method: String(input),
        body: String(init?.body ?? ""),
      });
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
      });
    };
    const moderator = createTelegramModerator({ token, fetchImpl });
    await moderator.setMenuButton({ tenantId: "local", kind: "commands" });
    await moderator.setMenuButton({ tenantId: "local", kind: "default" });
    expect(calls.map((call) => call.method)).toEqual([
      `https://api.telegram.org/bot${token}/setChatMenuButton`,
      `https://api.telegram.org/bot${token}/setChatMenuButton`,
    ]);
    expect(JSON.parse(calls[0]?.body ?? "null")).toEqual({
      menu_button: { type: "commands" },
    });
    expect(JSON.parse(calls[1]?.body ?? "null")).toEqual({
      menu_button: { type: "default" },
    });
    expect(calls[0]?.body).not.toContain("chat_id");
    expect(calls[0]?.body).not.toContain("web_app");
    expect(calls[0]?.method).not.toContain("getChatMenuButton");
    expect(calls[0]?.body).not.toContain(phrase);
    expect(calls[0]?.body).not.toContain(token);
    called = false;
    await expect(
      createTelegramModerator({ token: " ", fetchImpl }).setMenuButton({
        tenantId: "local",
        kind: "commands",
      }),
    ).rejects.toThrow("menubutton_unavailable");
    expect(called).toBe(false);
  });

  it("clears the private command menu without a language", async () => {
    const token = "bot-token";
    const phrase = "请免费领取礼品";
    const calls: { method: string; body: string }[] = [];
    let called = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      called = true;
      calls.push({
        method: String(input),
        body: String(init?.body ?? ""),
      });
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
      });
    };
    const moderator = createTelegramModerator({ token, fetchImpl });
    await moderator.deleteCommandMenu({ tenantId: "local" });
    expect(calls.map((call) => call.method)).toEqual([
      `https://api.telegram.org/bot${token}/deleteMyCommands`,
    ]);
    expect(JSON.parse(calls[0]?.body ?? "null")).toEqual({
      scope: { type: "all_private_chats" },
    });
    expect(calls[0]?.body).not.toContain("language_code");
    expect(calls[0]?.body).not.toContain("chat_id");
    expect(calls[0]?.body).not.toContain("commands");
    expect(calls[0]?.method).not.toContain("setMyCommands");
    expect(calls[0]?.method).not.toContain("getMyCommands");
    expect(calls[0]?.body).not.toContain(phrase);
    expect(calls[0]?.body).not.toContain(token);
    called = false;
    await expect(
      createTelegramModerator({ token: " ", fetchImpl }).deleteCommandMenu({
        tenantId: "local",
      }),
    ).rejects.toThrow("delcommands_unavailable");
    expect(called).toBe(false);
  });

  it("reads the private command menu and drops extra fields", async () => {
    const token = "bot-token";
    const phrase = "请免费领取礼品";
    const calls: { method: string; body: string }[] = [];
    let called = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      called = true;
      calls.push({
        method: String(input),
        body: String(init?.body ?? ""),
      });
      return new Response(
        JSON.stringify({
          ok: true,
          result: [
            { command: "help", description: "/help", note: phrase },
            {
              command: "stickers",
              description: "/stickers <chatId> <name>",
              is_ephemeral: true,
            },
          ],
        }),
        { status: 200 },
      );
    };
    const moderator = createTelegramModerator({ token, fetchImpl });
    await expect(
      moderator.readCommandMenu({ tenantId: "local" }),
    ).resolves.toEqual([
      { command: "help", description: "/help", ephemeral: "unknown" },
      {
        command: "stickers",
        description: "/stickers <chatId> <name>",
        ephemeral: "on",
      },
    ]);
    expect(calls.map((call) => call.method)).toEqual([
      `https://api.telegram.org/bot${token}/getMyCommands`,
    ]);
    expect(JSON.parse(calls[0]?.body ?? "null")).toEqual({
      scope: { type: "all_private_chats" },
    });
    expect(calls[0]?.body).not.toContain("language_code");
    expect(calls[0]?.method).not.toContain("setMyCommands");
    expect(calls[0]?.method).not.toContain("deleteMyCommands");
    expect(calls[0]?.body).not.toContain(phrase);
    expect(calls[0]?.body).not.toContain(token);
    called = false;
    await expect(
      createTelegramModerator({ token: " ", fetchImpl }).readCommandMenu({
        tenantId: "local",
      }),
    ).rejects.toThrow("commands_unavailable");
    expect(called).toBe(false);
    await expect(
      createTelegramModerator({
        token,
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              ok: true,
              result: [{ command: "help", description: "" }],
            }),
            { status: 200 },
          ),
      }).readCommandMenu({ tenantId: "local" }),
    ).rejects.toThrow("commands_failed");
  });

  it("sets the private command menu without a language or a group scope", async () => {
    const token = "bot-token";
    const phrase = "请免费领取礼品";
    const calls: { method: string; body: string }[] = [];
    let called = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      called = true;
      calls.push({
        method: String(input),
        body: String(init?.body ?? ""),
      });
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
      });
    };
    const moderator = createTelegramModerator({ token, fetchImpl });
    await moderator.setCommandMenu({
      tenantId: "local",
      commands: [
        { command: "help", description: "/help" },
        { command: "setcommands", description: "/setcommands [private]" },
      ],
    });
    expect(calls.map((call) => call.method)).toEqual([
      `https://api.telegram.org/bot${token}/setMyCommands`,
    ]);
    expect(JSON.parse(calls[0]?.body ?? "null")).toEqual({
      commands: [
        { command: "help", description: "/help" },
        { command: "setcommands", description: "/setcommands [private]" },
      ],
      scope: { type: "all_private_chats" },
    });
    expect(calls[0]?.body).not.toContain("language_code");
    expect(calls[0]?.body).not.toContain("chat_id");
    expect(calls[0]?.body).not.toContain("is_ephemeral");
    expect(calls[0]?.method).not.toContain("deleteMyCommands");
    expect(calls[0]?.method).not.toContain("getMyCommands");
    expect(calls[0]?.body).not.toContain(phrase);
    expect(calls[0]?.body).not.toContain(token);
    called = false;
    await expect(
      createTelegramModerator({ token: " ", fetchImpl }).setCommandMenu({
        tenantId: "local",
        commands: [{ command: "help", description: "/help" }],
      }),
    ).rejects.toThrow("setcommands_unavailable");
    expect(called).toBe(false);
  });

  it("sets one emoji reaction and keeps the other reactions", async () => {
    const token = "bot-token";
    const phrase = "请免费领取礼品";
    const calls: { method: string; body: string }[] = [];
    let called = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      called = true;
      calls.push({
        method: String(input),
        body: String(init?.body ?? ""),
      });
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
      });
    };
    const moderator = createTelegramModerator({ token, fetchImpl });
    await moderator.setReaction({
      tenantId: "local",
      chatId: "-100",
      messageId: "55",
      emoji: "👍",
    });
    expect(calls.map((call) => call.method)).toEqual([
      `https://api.telegram.org/bot${token}/setMessageReaction`,
    ]);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      chat_id: -100,
      message_id: 55,
      reaction: [{ type: "emoji", emoji: "👍" }],
    });
    expect(calls[0]?.body).not.toContain("is_big");
    expect(calls[0]?.method).not.toContain("deleteMessageReaction");
    expect(calls[0]?.body).not.toContain(phrase);
    expect(calls[0]?.body).not.toContain(token);
    called = false;
    await expect(
      createTelegramModerator({ token: " ", fetchImpl }).setReaction({
        tenantId: "local",
        chatId: "-100",
        messageId: "55",
        emoji: "👍",
      }),
    ).rejects.toThrow("react_unavailable");
    expect(called).toBe(false);
  });

  it("changes a chat title and drops the description", async () => {
    const token = "bot-token";
    const phrase = "请免费领取礼品";
    const calls: { method: string; body: string }[] = [];
    let called = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      called = true;
      calls.push({
        method: String(input),
        body: String(init?.body ?? ""),
      });
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
      });
    };
    const moderator = createTelegramModerator({ token, fetchImpl });
    await moderator.setTitle({
      tenantId: "local",
      chatId: "-100",
      title: phrase,
    });
    expect(calls.map((call) => call.method)).toEqual([
      `https://api.telegram.org/bot${token}/setChatTitle`,
    ]);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      chat_id: -100,
      title: phrase,
    });
    expect(calls[0]?.method).not.toContain("setChatDescription");
    expect(calls[0]?.body).not.toContain("description");
    expect(calls[0]?.body).not.toContain(token);
    called = false;
    await expect(
      createTelegramModerator({ token: " ", fetchImpl }).setTitle({
        tenantId: "local",
        chatId: "-100",
        title: phrase,
      }),
    ).rejects.toThrow("title_unavailable");
    expect(called).toBe(false);
  });

  it("changes a chat description and drops the title", async () => {
    const token = "bot-token";
    const phrase = "请免费领取礼品";
    const calls: { method: string; body: string }[] = [];
    let called = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      called = true;
      calls.push({
        method: String(input),
        body: String(init?.body ?? ""),
      });
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
      });
    };
    const moderator = createTelegramModerator({ token, fetchImpl });
    await moderator.setDescription({
      tenantId: "local",
      chatId: "-100",
      description: "",
    });
    await moderator.setDescription({
      tenantId: "local",
      chatId: "-100",
      description: phrase,
    });
    expect(calls.map((call) => call.method)).toEqual([
      `https://api.telegram.org/bot${token}/setChatDescription`,
      `https://api.telegram.org/bot${token}/setChatDescription`,
    ]);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      chat_id: -100,
      description: "",
    });
    expect(JSON.parse(calls[1]?.body ?? "{}")).toEqual({
      chat_id: -100,
      description: phrase,
    });
    expect(calls[0]?.method).not.toContain("setChatTitle");
    expect(calls[0]?.body).not.toContain("title");
    expect(calls[0]?.body).not.toContain(token);
    called = false;
    await expect(
      createTelegramModerator({ token: " ", fetchImpl }).setDescription({
        tenantId: "local",
        chatId: "-100",
        description: phrase,
      }),
    ).rejects.toThrow("desc_unavailable");
    expect(called).toBe(false);
  });

  it("creates one forum topic and drops the name", async () => {
    const token = "bot-token";
    const phrase = "请免费领取礼品";
    const calls: { method: string; body: string }[] = [];
    let called = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      called = true;
      calls.push({
        method: String(input),
        body: String(init?.body ?? ""),
      });
      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            message_thread_id: 55,
            name: phrase,
            icon_color: 7322096,
            icon_custom_emoji_id: "emoji-secret",
          },
        }),
        { status: 200 },
      );
    };
    const moderator = createTelegramModerator({ token, fetchImpl });
    await expect(
      moderator.createTopic({
        tenantId: "local",
        chatId: "-100",
        name: phrase,
      }),
    ).resolves.toBe("55");
    expect(calls.map((call) => call.method)).toEqual([
      `https://api.telegram.org/bot${token}/createForumTopic`,
    ]);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      chat_id: -100,
      name: phrase,
    });
    expect(calls[0]?.method).not.toContain("editForumTopic");
    expect(calls[0]?.method).not.toContain("getForumTopicIconStickers");
    expect(calls[0]?.body).not.toContain("icon_color");
    expect(calls[0]?.body).not.toContain("emoji-secret");
    expect(calls[0]?.body).not.toContain(token);
    const missing: typeof fetch = async () =>
      new Response(JSON.stringify({ ok: true, result: { name: phrase } }), {
        status: 200,
      });
    await expect(
      createTelegramModerator({ token, fetchImpl: missing }).createTopic({
        tenantId: "local",
        chatId: "-100",
        name: phrase,
      }),
    ).rejects.toThrow("newtopic_failed");
    const zero: typeof fetch = async () =>
      new Response(
        JSON.stringify({ ok: true, result: { message_thread_id: 0 } }),
        { status: 200 },
      );
    await expect(
      createTelegramModerator({ token, fetchImpl: zero }).createTopic({
        tenantId: "local",
        chatId: "-100",
        name: phrase,
      }),
    ).rejects.toThrow("newtopic_failed");
    called = false;
    await expect(
      createTelegramModerator({ token: " ", fetchImpl }).createTopic({
        tenantId: "local",
        chatId: "-100",
        name: phrase,
      }),
    ).rejects.toThrow("newtopic_unavailable");
    expect(called).toBe(false);
  });

  it("renames one forum topic and drops the name", async () => {
    const token = "bot-token";
    const phrase = "请免费领取礼品";
    const calls: { method: string; body: string }[] = [];
    let called = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      called = true;
      calls.push({
        method: String(input),
        body: String(init?.body ?? ""),
      });
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
      });
    };
    const moderator = createTelegramModerator({ token, fetchImpl });
    await moderator.renameTopic({
      tenantId: "local",
      chatId: "-100",
      threadId: "1",
      name: phrase,
    });
    expect(calls.map((call) => call.method)).toEqual([
      `https://api.telegram.org/bot${token}/editForumTopic`,
    ]);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      chat_id: -100,
      message_thread_id: 1,
      name: phrase,
    });
    expect(calls[0]?.method).not.toContain("editGeneralForumTopic");
    expect(calls[0]?.body).not.toContain("icon_custom_emoji_id");
    expect(calls[0]?.body).not.toContain(token);
    called = false;
    await expect(
      createTelegramModerator({ token: " ", fetchImpl }).renameTopic({
        tenantId: "local",
        chatId: "-100",
        threadId: "1",
        name: phrase,
      }),
    ).rejects.toThrow("rentopic_unavailable");
    expect(called).toBe(false);
  });

  it("renames the General topic and drops the name", async () => {
    const token = "bot-token";
    const phrase = "请免费领取礼品";
    const calls: { method: string; body: string }[] = [];
    let called = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      called = true;
      calls.push({
        method: String(input),
        body: String(init?.body ?? ""),
      });
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
      });
    };
    const moderator = createTelegramModerator({ token, fetchImpl });
    await moderator.renameGeneral({
      tenantId: "local",
      chatId: "-100",
      name: phrase,
    });
    expect(calls.map((call) => call.method)).toEqual([
      `https://api.telegram.org/bot${token}/editGeneralForumTopic`,
    ]);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      chat_id: -100,
      name: phrase,
    });
    expect(calls[0]?.method).not.toContain("editForumTopic");
    expect(calls[0]?.method).not.toContain("createForumTopic");
    expect(calls[0]?.body).not.toContain("message_thread_id");
    expect(calls[0]?.body).not.toContain(token);
    called = false;
    await expect(
      createTelegramModerator({ token: " ", fetchImpl }).renameGeneral({
        tenantId: "local",
        chatId: "-100",
        name: phrase,
      }),
    ).rejects.toThrow("rengeneral_unavailable");
    expect(called).toBe(false);
  });

  it("reads default speaking permissions and drops the chat title", async () => {
    const token = "bot-token";
    const phrase = "请免费领取礼品";
    const calls: { method: string; body: string }[] = [];
    let called = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      called = true;
      calls.push({
        method: String(input),
        body: String(init?.body ?? ""),
      });
      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            id: -100,
            type: "supergroup",
            title: phrase,
            description: phrase,
            permissions: {
              can_send_messages: true,
              can_pin_messages: false,
              can_react_to_messages: false,
            },
          },
        }),
        { status: 200 },
      );
    };
    const moderator = createTelegramModerator({ token, fetchImpl });
    const permissions = await moderator.readPermissions({
      tenantId: "local",
      chatId: "-100",
    });
    expect(calls.map((call) => call.method)).toEqual([
      `https://api.telegram.org/bot${token}/getChat`,
    ]);
    expect(calls[0]?.body).toContain('"chat_id":-100');
    expect(calls[0]?.body).not.toContain("user_id");
    expect(calls[0]?.body).not.toContain(phrase);
    expect(calls[0]?.body).not.toContain(token);
    expect(JSON.stringify(permissions)).not.toContain(phrase);
    expect(permissions).toEqual({
      sendMessages: "on",
      sendAudios: "unknown",
      sendDocuments: "unknown",
      sendPhotos: "unknown",
      sendVideos: "unknown",
      sendVideoNotes: "unknown",
      sendVoiceNotes: "unknown",
      sendPolls: "unknown",
      sendOtherMessages: "unknown",
      addWebPagePreviews: "unknown",
      reactToMessages: "off",
      editTag: "off",
      changeInfo: "unknown",
      inviteUsers: "unknown",
      pinMessages: "off",
      manageTopics: "off",
    });
    called = false;
    await expect(
      createTelegramModerator({
        token,
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              ok: true,
              result: { id: -100, type: "channel", title: phrase },
            }),
            { status: 200 },
          ),
      }).readPermissions({ tenantId: "local", chatId: "-100" }),
    ).rejects.toThrow("perms_failed");
    await expect(
      createTelegramModerator({
        token: " ",
        fetchImpl,
      }).readPermissions({ tenantId: "local", chatId: "-100" }),
    ).rejects.toThrow("perms_unavailable");
    expect(called).toBe(false);
  });

  it("deletes several messages in one call", async () => {
    const token = "bot-token";
    const phrase = "请免费领取礼品";
    const calls: { method: string; body: string }[] = [];
    let called = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      called = true;
      calls.push({
        method: String(input),
        body: String(init?.body ?? ""),
      });
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
      });
    };
    const moderator = createTelegramModerator({ token, fetchImpl });
    await moderator.deleteMessages({
      tenantId: "local",
      chatId: "-100",
      messageIds: ["88", "89"],
    });
    expect(calls.map((call) => call.method)).toEqual([
      `https://api.telegram.org/bot${token}/deleteMessages`,
    ]);
    const body = JSON.parse(calls[0]?.body ?? "{}") as {
      message_ids?: number[];
      message_id?: number;
    };
    expect(body.message_ids).toEqual([88, 89]);
    expect(body.message_id).toBeUndefined();
    expect(calls[0]?.body).toContain('"chat_id":-100');
    expect(calls[0]?.body).not.toContain("receiver_user_id");
    expect(calls[0]?.body).not.toContain(phrase);
    expect(calls[0]?.body).not.toContain(token);
    called = false;
    await expect(
      moderator.deleteMessages({
        tenantId: "local",
        chatId: "-100",
        messageIds: [],
      }),
    ).rejects.toThrow("deletes_failed");
    await expect(
      moderator.deleteMessages({
        tenantId: "local",
        chatId: "-100",
        messageIds: Array.from({ length: 101 }, (_, index) =>
          String(index + 1),
        ),
      }),
    ).rejects.toThrow("deletes_failed");
    expect(called).toBe(false);
    await expect(
      createTelegramModerator({
        token: " ",
        fetchImpl,
      }).deleteMessages({
        tenantId: "local",
        chatId: "-100",
        messageIds: ["88"],
      }),
    ).rejects.toThrow("deletes_unavailable");
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

  it("opens default speaking permissions without a member id", async () => {
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
        return new Response(JSON.stringify({ ok: true, result: true }), {
          status: 200,
        });
      },
    });
    await moderator.unlockChat({ tenantId: "local", chatId: "-100" });
    expect(calls.map((call) => call.method)).toEqual([
      `https://api.telegram.org/bot${token}/setChatPermissions`,
    ]);
    const body = JSON.parse(calls[0]?.body ?? "{}") as {
      permissions?: Record<string, boolean>;
      use_independent_chat_permissions?: boolean;
    };
    expect(body.use_independent_chat_permissions).toBe(true);
    expect(calls[0]?.body).toContain('"chat_id":-100');
    expect(calls[0]?.body).not.toContain("user_id");
    expect(calls[0]?.body).not.toContain("until_date");
    expect(Object.values(body.permissions ?? {})).toEqual(Array(16).fill(true));
    expect(calls[0]?.body).not.toContain(phrase);
    expect(calls[0]?.body).not.toContain(token);
  });

  it("closes default speaking permissions without a member id", async () => {
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
        return new Response(JSON.stringify({ ok: true, result: true }), {
          status: 200,
        });
      },
    });
    await moderator.lockChat({ tenantId: "local", chatId: "-100" });
    expect(calls.map((call) => call.method)).toEqual([
      `https://api.telegram.org/bot${token}/setChatPermissions`,
    ]);
    const body = JSON.parse(calls[0]?.body ?? "{}") as {
      permissions?: Record<string, boolean>;
      use_independent_chat_permissions?: boolean;
    };
    expect(body.use_independent_chat_permissions).toBe(true);
    expect(calls[0]?.body).toContain('"chat_id":-100');
    expect(calls[0]?.body).not.toContain("user_id");
    expect(calls[0]?.body).not.toContain("until_date");
    expect(Object.values(body.permissions ?? {})).toEqual(
      Array(16).fill(false),
    );
    expect(calls[0]?.body).not.toContain(phrase);
    expect(calls[0]?.body).not.toContain(token);
  });

  it("lifts a sender-chat block without unbanning a user", async () => {
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
        return new Response(JSON.stringify({ ok: true, result: true }), {
          status: 200,
        });
      },
    });
    await moderator.unbanSenderChat({
      tenantId: "local",
      chatId: "-100",
      senderChatId: "-1005",
    });
    expect(calls.map((call) => call.method)).toEqual([
      `https://api.telegram.org/bot${token}/unbanChatSenderChat`,
    ]);
    expect(calls[0]?.body).toContain('"chat_id":-100');
    expect(calls[0]?.body).toContain('"sender_chat_id":-1005');
    expect(calls[0]?.body).not.toContain("user_id");
    expect(calls[0]?.body).not.toContain("only_if_banned");
    expect(calls[0]?.body).not.toContain(phrase);
    expect(calls[0]?.body).not.toContain(token);
  });

  it("bans a sender chat without banning a user", async () => {
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
        return new Response(JSON.stringify({ ok: true, result: true }), {
          status: 200,
        });
      },
    });
    await moderator.banSenderChat({
      tenantId: "local",
      chatId: "-100",
      senderChatId: "-1005",
    });
    expect(calls.map((call) => call.method)).toEqual([
      `https://api.telegram.org/bot${token}/banChatSenderChat`,
    ]);
    expect(calls[0]?.body).toContain('"chat_id":-100');
    expect(calls[0]?.body).toContain('"sender_chat_id":-1005');
    expect(calls[0]?.body).not.toContain("user_id");
    expect(calls[0]?.body).not.toContain("revoke_messages");
    expect(calls[0]?.body).not.toContain(phrase);
    expect(calls[0]?.body).not.toContain(token);
  });

  it("approves a join request without a query id", async () => {
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
        return new Response(JSON.stringify({ ok: true, result: true }), {
          status: 200,
        });
      },
    });
    await moderator.approveJoin({
      tenantId: "local",
      chatId: "-100",
      actorId: "83",
      queryId: "query83",
    });
    expect(calls.map((call) => call.method)).toEqual([
      `https://api.telegram.org/bot${token}/approveChatJoinRequest`,
    ]);
    expect(calls[0]?.body).toContain('"chat_id":-100');
    expect(calls[0]?.body).toContain('"user_id":83');
    expect(calls[0]?.body).not.toContain("query83");
    expect(calls[0]?.body).not.toContain(phrase);
    expect(calls[0]?.body).not.toContain(token);
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
