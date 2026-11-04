import {
  createMemoryBlocklistStore,
  createMemoryCache,
  createMemoryCaptchaStore,
  createMemoryModerator,
  createMemoryPolicyStore,
  createMemoryReply,
  createMemoryReviewQueue,
  createMemoryRulePackArchive,
  createMemoryRuleSubscriptionStore,
  createMemoryRuntimeStore,
  createMemoryStorage,
} from "@tasb/adapter-memory";
import {
  createMemoryChatDirectory,
  createMemoryQuotaStore,
  defaultBasicDetectorIds,
  quotaPolicyFromEnv,
} from "@tasb/cloud";
import {
  type BlocklistStore,
  createFixedClock,
  createMemoryLogger,
  parseEvent,
} from "@tasb/core";
import { createMemoryRateWindow } from "@tasb/detector-rate";
import { sha256Hex } from "@tasb/platform-telegram";
import { describe, expect, it } from "vitest";
import { handleIncomingEvent } from "./operate.js";

const phrase = "请免费领取礼品";

async function incoming(input: {
  readonly text: string;
  readonly direct?: boolean;
  readonly chatId?: string;
  readonly actorId?: string;
}) {
  return parseEvent({
    id: "evt_op",
    tenantId: "local",
    chatId: input.chatId ?? "42",
    kind: "message",
    occurredAt: "2026-11-01T00:00:00.000Z",
    actor: { id: input.actorId ?? "42", isAdmin: false },
    ...(input.direct ? { direct: true } : {}),
    message: {
      id: "1",
      text: input.text,
      textSha256: await sha256Hex(input.text),
    },
  });
}

function deps() {
  return {
    logger: createMemoryLogger(),
    cache: createMemoryCache(),
    storage: createMemoryStorage(),
    policyStore: createMemoryPolicyStore(),
    runtime: createMemoryRuntimeStore(),
    reply: createMemoryReply(),
    adminActorIds: ["42"],
  };
}

describe("handleIncomingEvent", () => {
  it("lifts a restriction after checking the member", async () => {
    const kit = deps();
    const calls: { method: string; body: string }[] = [];
    await handleIncomingEvent(
      await incoming({ text: "/unmute -100 77", direct: true }),
      {
        ...kit,
        botToken: "bot-token",
        fetchImpl: async (input, init) => {
          const url = String(input);
          const method = url.slice(url.lastIndexOf("/") + 1);
          calls.push({ method, body: String(init?.body ?? "") });
          if (method === "getChatMember") {
            return new Response(
              JSON.stringify({
                ok: true,
                result: {
                  status: "restricted",
                  is_member: true,
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
      },
    );
    expect(kit.reply.sent.map((message) => message.text)).toEqual([
      "已解除禁言 -100 77",
    ]);
    expect(calls.map((call) => call.method)).toEqual([
      "getChatMember",
      "restrictChatMember",
    ]);
    expect(calls[1]?.body).toContain('"can_send_messages":true');
    expect(calls[1]?.body).not.toContain("until_date");
    expect(JSON.stringify(calls)).not.toContain(phrase);
    expect(JSON.stringify(kit.logger.entries)).not.toContain("bot-token");
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
    const offline = deps();
    await handleIncomingEvent(
      await incoming({ text: "/unmute -100 77", direct: true }),
      offline,
    );
    expect(offline.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
  });

  it("opens default speaking permissions for one chat", async () => {
    const kit = deps();
    const calls: { method: string; body: string }[] = [];
    await handleIncomingEvent(
      await incoming({ text: "/unlock -100", direct: true }),
      {
        ...kit,
        botToken: "bot-token",
        fetchImpl: async (input, init) => {
          const url = String(input);
          calls.push({
            method: url.slice(url.lastIndexOf("/") + 1),
            body: String(init?.body ?? ""),
          });
          return new Response(JSON.stringify({ ok: true, result: true }), {
            status: 200,
          });
        },
      },
    );
    expect(kit.reply.sent.map((message) => message.text)).toEqual([
      "已打开 -100 的默认发言权限。这可能比锁定前更宽。单人禁言仍在",
    ]);
    expect(calls.map((call) => call.method)).toEqual(["setChatPermissions"]);
    const body = JSON.parse(calls[0]?.body ?? "{}") as {
      chat_id?: number;
      permissions?: Record<string, boolean>;
      use_independent_chat_permissions?: boolean;
      user_id?: number;
      until_date?: number;
    };
    expect(body.chat_id).toBe(-100);
    expect(body.use_independent_chat_permissions).toBe(true);
    expect(body.user_id).toBeUndefined();
    expect(body.until_date).toBeUndefined();
    expect(body.permissions).toEqual({
      can_send_messages: true,
      can_send_audios: true,
      can_send_documents: true,
      can_send_photos: true,
      can_send_videos: true,
      can_send_video_notes: true,
      can_send_voice_notes: true,
      can_send_polls: true,
      can_send_other_messages: true,
      can_add_web_page_previews: true,
      can_react_to_messages: true,
      can_edit_tag: true,
      can_change_info: true,
      can_invite_users: true,
      can_pin_messages: true,
      can_manage_topics: true,
    });
    expect(JSON.stringify(calls)).not.toContain(phrase);
    expect(JSON.stringify(kit.logger.entries)).not.toContain("bot-token");
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
    const offline = deps();
    await handleIncomingEvent(
      await incoming({ text: "/unlock -100", direct: true }),
      offline,
    );
    expect(offline.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    const rejected = deps();
    await handleIncomingEvent(
      await incoming({ text: "/unlock -100", direct: true }),
      {
        ...rejected,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: false, description: phrase }), {
            status: 400,
          }),
      },
    );
    expect(rejected.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain("bot-token");
  });

  it("closes default speaking permissions for one chat", async () => {
    const kit = deps();
    const calls: { method: string; body: string }[] = [];
    await handleIncomingEvent(
      await incoming({ text: "/lock -100", direct: true }),
      {
        ...kit,
        botToken: "bot-token",
        fetchImpl: async (input, init) => {
          const url = String(input);
          calls.push({
            method: url.slice(url.lastIndexOf("/") + 1),
            body: String(init?.body ?? ""),
          });
          return new Response(JSON.stringify({ ok: true, result: true }), {
            status: 200,
          });
        },
      },
    );
    expect(kit.reply.sent.map((message) => message.text)).toEqual([
      "已关闭 -100 的默认发言权限。管理员仍可发言。此状态会保持到重新设置权限",
    ]);
    expect(calls.map((call) => call.method)).toEqual(["setChatPermissions"]);
    const body = JSON.parse(calls[0]?.body ?? "{}") as {
      chat_id?: number;
      permissions?: Record<string, boolean>;
      use_independent_chat_permissions?: boolean;
      user_id?: number;
      until_date?: number;
    };
    expect(body.chat_id).toBe(-100);
    expect(body.use_independent_chat_permissions).toBe(true);
    expect(body.user_id).toBeUndefined();
    expect(body.until_date).toBeUndefined();
    expect(body.permissions).toEqual({
      can_send_messages: false,
      can_send_audios: false,
      can_send_documents: false,
      can_send_photos: false,
      can_send_videos: false,
      can_send_video_notes: false,
      can_send_voice_notes: false,
      can_send_polls: false,
      can_send_other_messages: false,
      can_add_web_page_previews: false,
      can_react_to_messages: false,
      can_edit_tag: false,
      can_change_info: false,
      can_invite_users: false,
      can_pin_messages: false,
      can_manage_topics: false,
    });
    expect(JSON.stringify(calls)).not.toContain(phrase);
    expect(JSON.stringify(kit.logger.entries)).not.toContain("bot-token");
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
    const offline = deps();
    await handleIncomingEvent(
      await incoming({ text: "/lock -100", direct: true }),
      offline,
    );
    expect(offline.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    const rejected = deps();
    await handleIncomingEvent(
      await incoming({ text: "/lock -100", direct: true }),
      {
        ...rejected,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: false, description: phrase }), {
            status: 400,
          }),
      },
    );
    expect(rejected.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain("bot-token");
  });

  it("lifts a sender-chat block without unbanning a user", async () => {
    const kit = deps();
    const calls: { method: string; body: string }[] = [];
    await handleIncomingEvent(
      await incoming({ text: "/unbansender -100 -1005", direct: true }),
      {
        ...kit,
        botToken: "bot-token",
        fetchImpl: async (input, init) => {
          const url = String(input);
          calls.push({
            method: url.slice(url.lastIndexOf("/") + 1),
            body: String(init?.body ?? ""),
          });
          return new Response(JSON.stringify({ ok: true, result: true }), {
            status: 200,
          });
        },
      },
    );
    expect(kit.reply.sent.map((message) => message.text)).toEqual([
      "已解除 -1005 在 -100 的代发禁止",
    ]);
    expect(calls.map((call) => call.method)).toEqual(["unbanChatSenderChat"]);
    expect(calls[0]?.body).toContain('"chat_id":-100');
    expect(calls[0]?.body).toContain('"sender_chat_id":-1005');
    expect(calls[0]?.body).not.toContain("user_id");
    expect(calls[0]?.body).not.toContain("only_if_banned");
    expect(JSON.stringify(calls)).not.toContain(phrase);
    expect(JSON.stringify(kit.logger.entries)).not.toContain("bot-token");
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
    const offline = deps();
    await handleIncomingEvent(
      await incoming({ text: "/unbansender -100 -1005", direct: true }),
      offline,
    );
    expect(offline.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    const rejected = deps();
    await handleIncomingEvent(
      await incoming({ text: "/unbansender -100 -1005", direct: true }),
      {
        ...rejected,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: false, description: phrase }), {
            status: 400,
          }),
      },
    );
    expect(rejected.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain("bot-token");
  });

  it("blocks a sender chat without banning a user", async () => {
    const kit = deps();
    const calls: { method: string; body: string }[] = [];
    await handleIncomingEvent(
      await incoming({ text: "/bansender -100 -1005", direct: true }),
      {
        ...kit,
        botToken: "bot-token",
        fetchImpl: async (input, init) => {
          const url = String(input);
          calls.push({
            method: url.slice(url.lastIndexOf("/") + 1),
            body: String(init?.body ?? ""),
          });
          return new Response(JSON.stringify({ ok: true, result: true }), {
            status: 200,
          });
        },
      },
    );
    expect(kit.reply.sent.map((message) => message.text)).toEqual([
      "已禁止 -1005 在 -100 代发。频道主人的其它频道也会被挡住，直到解除",
    ]);
    expect(calls.map((call) => call.method)).toEqual(["banChatSenderChat"]);
    expect(calls[0]?.body).toContain('"chat_id":-100');
    expect(calls[0]?.body).toContain('"sender_chat_id":-1005');
    expect(calls[0]?.body).not.toContain("user_id");
    expect(calls[0]?.body).not.toContain("revoke_messages");
    expect(JSON.stringify(calls)).not.toContain(phrase);
    expect(JSON.stringify(kit.logger.entries)).not.toContain("bot-token");
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
    const offline = deps();
    await handleIncomingEvent(
      await incoming({ text: "/bansender -100 -1005", direct: true }),
      offline,
    );
    expect(offline.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    const rejected = deps();
    await handleIncomingEvent(
      await incoming({ text: "/bansender -100 -1005", direct: true }),
      {
        ...rejected,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: false, description: phrase }), {
            status: 400,
          }),
      },
    );
    expect(rejected.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain("bot-token");
  });

  it("approves a pending join and leaves ban and mute unchanged", async () => {
    const kit = deps();
    const calls: { method: string; body: string }[] = [];
    await handleIncomingEvent(
      await incoming({ text: "/approve -100 77", direct: true }),
      {
        ...kit,
        botToken: "bot-token",
        fetchImpl: async (input, init) => {
          const url = String(input);
          calls.push({
            method: url.slice(url.lastIndexOf("/") + 1),
            body: String(init?.body ?? ""),
          });
          return new Response(JSON.stringify({ ok: true, result: true }), {
            status: 200,
          });
        },
      },
    );
    expect(kit.reply.sent.map((message) => message.text)).toEqual([
      "已批准 -100 77",
    ]);
    expect(calls.map((call) => call.method)).toEqual([
      "approveChatJoinRequest",
    ]);
    expect(calls[0]?.body).toContain('"chat_id":-100');
    expect(calls[0]?.body).toContain('"user_id":77');
    expect(calls[0]?.body).not.toContain("query");
    expect(JSON.stringify(calls)).not.toContain("banChatMember");
    expect(JSON.stringify(calls)).not.toContain(phrase);
    expect(JSON.stringify(kit.logger.entries)).not.toContain("bot-token");
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
    const offline = deps();
    await handleIncomingEvent(
      await incoming({ text: "/approve -100 77", direct: true }),
      offline,
    );
    expect(offline.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    const rejected = deps();
    await handleIncomingEvent(
      await incoming({ text: "/approve -100 77", direct: true }),
      {
        ...rejected,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: false, description: phrase }), {
            status: 400,
          }),
      },
    );
    expect(rejected.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain("bot-token");
  });

  it("declines a pending join and leaves ban and mute unchanged", async () => {
    const kit = deps();
    const calls: { method: string; body: string }[] = [];
    await handleIncomingEvent(
      await incoming({ text: "/decline -100 77", direct: true }),
      {
        ...kit,
        botToken: "bot-token",
        fetchImpl: async (input, init) => {
          const url = String(input);
          calls.push({
            method: url.slice(url.lastIndexOf("/") + 1),
            body: String(init?.body ?? ""),
          });
          return new Response(JSON.stringify({ ok: true, result: true }), {
            status: 200,
          });
        },
      },
    );
    expect(kit.reply.sent.map((message) => message.text)).toEqual([
      "已拒绝 -100 77",
    ]);
    expect(calls.map((call) => call.method)).toEqual([
      "declineChatJoinRequest",
    ]);
    expect(calls[0]?.body).toContain('"chat_id":-100');
    expect(calls[0]?.body).toContain('"user_id":77');
    expect(calls[0]?.body).not.toContain("query");
    expect(JSON.stringify(calls)).not.toContain(phrase);
    expect(JSON.stringify(kit.logger.entries)).not.toContain("bot-token");
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
    const offline = deps();
    await handleIncomingEvent(
      await incoming({ text: "/decline -100 77", direct: true }),
      offline,
    );
    expect(offline.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    const rejected = deps();
    await handleIncomingEvent(
      await incoming({ text: "/decline -100 77", direct: true }),
      {
        ...rejected,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: false, description: phrase }), {
            status: 400,
          }),
      },
    );
    expect(rejected.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain("bot-token");
  });

  it("clears recent reactions from one actor", async () => {
    const kit = deps();
    const calls: { method: string; body: string }[] = [];
    await handleIncomingEvent(
      await incoming({ text: "/clearreact -100 77", direct: true }),
      {
        ...kit,
        botToken: "bot-token",
        fetchImpl: async (input, init) => {
          const url = String(input);
          calls.push({
            method: url.slice(url.lastIndexOf("/") + 1),
            body: String(init?.body ?? ""),
          });
          return new Response(JSON.stringify({ ok: true, result: true }), {
            status: 200,
          });
        },
      },
    );
    expect(kit.reply.sent.map((message) => message.text)).toEqual([
      "已请求清除 77 在 -100 的最近反应。一万条以前的可能还在",
    ]);
    expect(calls.map((call) => call.method)).toEqual([
      "deleteAllMessageReactions",
    ]);
    const body = JSON.parse(calls[0]?.body ?? "{}") as {
      chat_id?: number;
      user_id?: number;
      actor_chat_id?: number;
      message_id?: number;
    };
    expect(body.chat_id).toBe(-100);
    expect(body.user_id).toBe(77);
    expect(body.actor_chat_id).toBeUndefined();
    expect(body.message_id).toBeUndefined();
    expect(JSON.stringify(calls)).not.toContain(phrase);
    expect(JSON.stringify(kit.logger.entries)).not.toContain("bot-token");
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
    const offline = deps();
    await handleIncomingEvent(
      await incoming({ text: "/clearreact -100 77", direct: true }),
      offline,
    );
    expect(offline.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    const rejected = deps();
    await handleIncomingEvent(
      await incoming({ text: "/clearreact -100 77", direct: true }),
      {
        ...rejected,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: false, description: phrase }), {
            status: 400,
          }),
      },
    );
    expect(rejected.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain("bot-token");
  });

  it("revokes one bot invite link without echoing it", async () => {
    const kit = deps();
    const code = "AbCdEfGhIjKlMnOp";
    const link = `https://t.me/+${code}`;
    const calls: { method: string; body: string }[] = [];
    await handleIncomingEvent(
      await incoming({ text: `/revoke -100 ${link}`, direct: true }),
      {
        ...kit,
        botToken: "bot-token",
        fetchImpl: async (input, init) => {
          const url = String(input);
          calls.push({
            method: url.slice(url.lastIndexOf("/") + 1),
            body: String(init?.body ?? ""),
          });
          return new Response(
            JSON.stringify({
              ok: true,
              result: {
                invite_link: `https://t.me/+${code}NEW`,
                name: phrase,
                creator: { id: 1, is_bot: false, first_name: phrase },
              },
            }),
            { status: 200 },
          );
        },
      },
    );
    expect(kit.reply.sent.map((message) => message.text)).toEqual([
      "已请求撤销 -100 里机器人自己发的邀请链接。别人发的撤不掉，新的主链接也不在这里",
    ]);
    expect(JSON.stringify(kit.reply.sent)).not.toContain(code);
    expect(calls.map((call) => call.method)).toEqual(["revokeChatInviteLink"]);
    const body = JSON.parse(calls[0]?.body ?? "{}") as {
      chat_id?: number;
      invite_link?: string;
      user_id?: number;
    };
    expect(body.chat_id).toBe(-100);
    expect(body.invite_link).toBe(link);
    expect(body.user_id).toBeUndefined();
    expect(JSON.stringify(kit.logger.entries)).not.toContain(code);
    expect(JSON.stringify(kit.logger.entries)).not.toContain("bot-token");
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
    const offline = deps();
    await handleIncomingEvent(
      await incoming({ text: `/revoke -100 ${link}`, direct: true }),
      offline,
    );
    expect(offline.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(offline.reply.sent)).not.toContain(code);
    expect(JSON.stringify(offline.logger.entries)).not.toContain(code);
    const rejected = deps();
    await handleIncomingEvent(
      await incoming({ text: `/revoke -100 ${link}`, direct: true }),
      {
        ...rejected,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: false, description: phrase }), {
            status: 400,
          }),
      },
    );
    expect(rejected.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(rejected.reply.sent)).not.toContain(code);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain(code);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain("bot-token");
  });

  it("unpins every chat pin and leaves the messages", async () => {
    const kit = deps();
    const calls: { method: string; body: string }[] = [];
    await handleIncomingEvent(
      await incoming({ text: "/unpin -100", direct: true }),
      {
        ...kit,
        botToken: "bot-token",
        fetchImpl: async (input, init) => {
          const url = String(input);
          calls.push({
            method: url.slice(url.lastIndexOf("/") + 1),
            body: String(init?.body ?? ""),
          });
          return new Response(JSON.stringify({ ok: true, result: true }), {
            status: 200,
          });
        },
      },
    );
    expect(kit.reply.sent.map((message) => message.text)).toEqual([
      "已请求撤下 -100 的全部置顶。消息还在。话题里的置顶不在这次里",
    ]);
    expect(calls.map((call) => call.method)).toEqual(["unpinAllChatMessages"]);
    const body = JSON.parse(calls[0]?.body ?? "{}") as {
      chat_id?: number;
      message_id?: number;
      message_thread_id?: number;
    };
    expect(body.chat_id).toBe(-100);
    expect(body.message_id).toBeUndefined();
    expect(body.message_thread_id).toBeUndefined();
    expect(JSON.stringify(calls)).not.toContain(phrase);
    expect(JSON.stringify(kit.logger.entries)).not.toContain("bot-token");
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
    const offline = deps();
    await handleIncomingEvent(
      await incoming({ text: "/unpin -100", direct: true }),
      offline,
    );
    expect(offline.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    const rejected = deps();
    await handleIncomingEvent(
      await incoming({ text: "/unpin -100", direct: true }),
      {
        ...rejected,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: false, description: phrase }), {
            status: 400,
          }),
      },
    );
    expect(rejected.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain("bot-token");
  });

  it("lists administrators without their names", async () => {
    const kit = deps();
    const calls: { method: string; body: string }[] = [];
    await handleIncomingEvent(
      await incoming({ text: "/admins -100", direct: true }),
      {
        ...kit,
        botToken: "bot-token",
        fetchImpl: async (input, init) => {
          const url = String(input);
          calls.push({
            method: url.slice(url.lastIndexOf("/") + 1),
            body: String(init?.body ?? ""),
          });
          return new Response(
            JSON.stringify({
              ok: true,
              result: [
                {
                  status: "administrator",
                  user: { id: 77, is_bot: false, first_name: phrase },
                  can_delete_messages: true,
                  custom_title: phrase,
                },
              ],
            }),
            { status: 200 },
          );
        },
      },
    );
    expect(kit.reply.sent.map((message) => message.text)).toEqual([
      "admins -100\n77 管理员 删除",
    ]);
    expect(JSON.stringify(kit.reply.sent)).not.toContain(phrase);
    expect(calls.map((call) => call.method)).toEqual(["getChatAdministrators"]);
    const body = JSON.parse(calls[0]?.body ?? "{}") as {
      chat_id?: number;
      return_bots?: boolean;
    };
    expect(body.chat_id).toBe(-100);
    expect(body.return_bots).toBe(true);
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(kit.logger.entries)).not.toContain("bot-token");
    const offline = deps();
    await handleIncomingEvent(
      await incoming({ text: "/admins -100", direct: true }),
      offline,
    );
    expect(offline.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    const rejected = deps();
    await handleIncomingEvent(
      await incoming({ text: "/admins -100", direct: true }),
      {
        ...rejected,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: false, description: phrase }), {
            status: 400,
          }),
      },
    );
    expect(rejected.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain("bot-token");
  });

  it("unpins a forum topic and leaves the messages", async () => {
    const kit = deps();
    const calls: { method: string; body: string }[] = [];
    await handleIncomingEvent(
      await incoming({ text: "/untopic -100 55", direct: true }),
      {
        ...kit,
        botToken: "bot-token",
        fetchImpl: async (input, init) => {
          const url = String(input);
          calls.push({
            method: url.slice(url.lastIndexOf("/") + 1),
            body: String(init?.body ?? ""),
          });
          return new Response(JSON.stringify({ ok: true, result: true }), {
            status: 200,
          });
        },
      },
    );
    expect(kit.reply.sent.map((message) => message.text)).toEqual([
      "已请求撤下 -100 话题 55 的全部置顶。消息还在",
    ]);
    expect(calls.map((call) => call.method)).toEqual([
      "unpinAllForumTopicMessages",
    ]);
    const body = JSON.parse(calls[0]?.body ?? "{}") as {
      chat_id?: number;
      message_thread_id?: number;
      message_id?: number;
    };
    expect(body.chat_id).toBe(-100);
    expect(body.message_thread_id).toBe(55);
    expect(body.message_id).toBeUndefined();
    expect(JSON.stringify(calls)).not.toContain(phrase);
    expect(JSON.stringify(kit.logger.entries)).not.toContain("bot-token");
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
    const offline = deps();
    await handleIncomingEvent(
      await incoming({ text: "/untopic -100", direct: true }),
      offline,
    );
    expect(offline.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    const rejected = deps();
    await handleIncomingEvent(
      await incoming({ text: "/untopic -100 55", direct: true }),
      {
        ...rejected,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: false, description: phrase }), {
            status: 400,
          }),
      },
    );
    expect(rejected.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain("bot-token");
  });

  it("closes a forum topic and leaves the messages", async () => {
    const kit = deps();
    const calls: { method: string; body: string }[] = [];
    await handleIncomingEvent(
      await incoming({ text: "/closetopic -100 55", direct: true }),
      {
        ...kit,
        botToken: "bot-token",
        fetchImpl: async (input, init) => {
          const url = String(input);
          calls.push({
            method: url.slice(url.lastIndexOf("/") + 1),
            body: String(init?.body ?? ""),
          });
          return new Response(JSON.stringify({ ok: true, result: true }), {
            status: 200,
          });
        },
      },
    );
    expect(kit.reply.sent.map((message) => message.text)).toEqual([
      "已请求关闭 -100 话题 55。消息还在",
    ]);
    expect(calls.map((call) => call.method)).toEqual(["closeForumTopic"]);
    const body = JSON.parse(calls[0]?.body ?? "{}") as {
      chat_id?: number;
      message_thread_id?: number;
      message_id?: number;
    };
    expect(body.chat_id).toBe(-100);
    expect(body.message_thread_id).toBe(55);
    expect(body.message_id).toBeUndefined();
    expect(JSON.stringify(calls)).not.toContain(phrase);
    expect(JSON.stringify(kit.logger.entries)).not.toContain("bot-token");
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
    const offline = deps();
    await handleIncomingEvent(
      await incoming({ text: "/closetopic -100", direct: true }),
      offline,
    );
    expect(offline.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    const rejected = deps();
    await handleIncomingEvent(
      await incoming({ text: "/closetopic -100 55", direct: true }),
      {
        ...rejected,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: false, description: phrase }), {
            status: 400,
          }),
      },
    );
    expect(rejected.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain("bot-token");
  });

  it("reopens a forum topic and leaves the messages", async () => {
    const kit = deps();
    const calls: { method: string; body: string }[] = [];
    await handleIncomingEvent(
      await incoming({ text: "/opentopic -100 55", direct: true }),
      {
        ...kit,
        botToken: "bot-token",
        fetchImpl: async (input, init) => {
          const url = String(input);
          calls.push({
            method: url.slice(url.lastIndexOf("/") + 1),
            body: String(init?.body ?? ""),
          });
          return new Response(JSON.stringify({ ok: true, result: true }), {
            status: 200,
          });
        },
      },
    );
    expect(kit.reply.sent.map((message) => message.text)).toEqual([
      "已请求重新打开 -100 话题 55。消息还在",
    ]);
    expect(calls.map((call) => call.method)).toEqual(["reopenForumTopic"]);
    const body = JSON.parse(calls[0]?.body ?? "{}") as {
      chat_id?: number;
      message_thread_id?: number;
      message_id?: number;
    };
    expect(body.chat_id).toBe(-100);
    expect(body.message_thread_id).toBe(55);
    expect(body.message_id).toBeUndefined();
    expect(JSON.stringify(calls)).not.toContain(phrase);
    expect(JSON.stringify(kit.logger.entries)).not.toContain("bot-token");
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
    const offline = deps();
    await handleIncomingEvent(
      await incoming({ text: "/opentopic -100", direct: true }),
      offline,
    );
    expect(offline.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    const rejected = deps();
    await handleIncomingEvent(
      await incoming({ text: "/opentopic -100 55", direct: true }),
      {
        ...rejected,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: false, description: phrase }), {
            status: 400,
          }),
      },
    );
    expect(rejected.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain("bot-token");
  });

  it("hides the General topic and leaves the messages", async () => {
    const kit = deps();
    const calls: { method: string; body: string }[] = [];
    await handleIncomingEvent(
      await incoming({ text: "/hidegeneral -100", direct: true }),
      {
        ...kit,
        botToken: "bot-token",
        fetchImpl: async (input, init) => {
          const url = String(input);
          calls.push({
            method: url.slice(url.lastIndexOf("/") + 1),
            body: String(init?.body ?? ""),
          });
          return new Response(JSON.stringify({ ok: true, result: true }), {
            status: 200,
          });
        },
      },
    );
    expect(kit.reply.sent.map((message) => message.text)).toEqual([
      "已请求隐藏 -100 的通用话题。原先开着的话会一起关闭。消息还在。其它话题不在这次里",
    ]);
    expect(calls.map((call) => call.method)).toEqual(["hideGeneralForumTopic"]);
    const body = JSON.parse(calls[0]?.body ?? "{}") as {
      chat_id?: number;
      message_thread_id?: number;
      message_id?: number;
    };
    expect(body.chat_id).toBe(-100);
    expect(body.message_thread_id).toBeUndefined();
    expect(body.message_id).toBeUndefined();
    expect(JSON.stringify(calls)).not.toContain(phrase);
    expect(JSON.stringify(kit.logger.entries)).not.toContain("bot-token");
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
    const offline = deps();
    await handleIncomingEvent(
      await incoming({ text: "/hidegeneral -100", direct: true }),
      offline,
    );
    expect(offline.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    const rejected = deps();
    await handleIncomingEvent(
      await incoming({ text: "/hidegeneral -100", direct: true }),
      {
        ...rejected,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: false, description: phrase }), {
            status: 400,
          }),
      },
    );
    expect(rejected.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain("bot-token");
  });

  it("shows the General topic and leaves it closed", async () => {
    const kit = deps();
    const calls: { method: string; body: string }[] = [];
    await handleIncomingEvent(
      await incoming({ text: "/showgeneral -100", direct: true }),
      {
        ...kit,
        botToken: "bot-token",
        fetchImpl: async (input, init) => {
          const url = String(input);
          calls.push({
            method: url.slice(url.lastIndexOf("/") + 1),
            body: String(init?.body ?? ""),
          });
          return new Response(JSON.stringify({ ok: true, result: true }), {
            status: 200,
          });
        },
      },
    );
    expect(kit.reply.sent.map((message) => message.text)).toEqual([
      "已请求显示 -100 的通用话题。原先关着的话仍然关着。消息还在。其它话题不在这次里",
    ]);
    expect(calls.map((call) => call.method)).toEqual([
      "unhideGeneralForumTopic",
    ]);
    const body = JSON.parse(calls[0]?.body ?? "{}") as {
      chat_id?: number;
      message_thread_id?: number;
      message_id?: number;
    };
    expect(body.chat_id).toBe(-100);
    expect(body.message_thread_id).toBeUndefined();
    expect(body.message_id).toBeUndefined();
    expect(JSON.stringify(calls)).not.toContain("reopen");
    expect(JSON.stringify(calls)).not.toContain(phrase);
    expect(JSON.stringify(kit.logger.entries)).not.toContain("bot-token");
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
    const offline = deps();
    await handleIncomingEvent(
      await incoming({ text: "/showgeneral -100", direct: true }),
      offline,
    );
    expect(offline.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    const rejected = deps();
    await handleIncomingEvent(
      await incoming({ text: "/showgeneral -100", direct: true }),
      {
        ...rejected,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: false, description: phrase }), {
            status: 400,
          }),
      },
    );
    expect(rejected.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain("bot-token");
  });

  it("deletes one forum topic and the messages inside it", async () => {
    const kit = deps();
    const calls: { method: string; body: string }[] = [];
    await handleIncomingEvent(
      await incoming({ text: "/deltopic -100 55", direct: true }),
      {
        ...kit,
        botToken: "bot-token",
        fetchImpl: async (input, init) => {
          const url = String(input);
          calls.push({
            method: url.slice(url.lastIndexOf("/") + 1),
            body: String(init?.body ?? ""),
          });
          return new Response(JSON.stringify({ ok: true, result: true }), {
            status: 200,
          });
        },
      },
    );
    expect(kit.reply.sent.map((message) => message.text)).toEqual([
      "已请求删除 -100 话题 55 和里面的消息。其它话题不在这次里",
    ]);
    expect(calls.map((call) => call.method)).toEqual(["deleteForumTopic"]);
    const body = JSON.parse(calls[0]?.body ?? "{}") as {
      chat_id?: number;
      message_thread_id?: number;
      message_id?: number;
    };
    expect(body.chat_id).toBe(-100);
    expect(body.message_thread_id).toBe(55);
    expect(body.message_id).toBeUndefined();
    expect(JSON.stringify(calls)).not.toContain(phrase);
    expect(JSON.stringify(kit.logger.entries)).not.toContain("bot-token");
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
    const offline = deps();
    await handleIncomingEvent(
      await incoming({ text: "/deltopic -100 55", direct: true }),
      offline,
    );
    expect(offline.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    const rejected = deps();
    await handleIncomingEvent(
      await incoming({ text: "/deltopic -100 55", direct: true }),
      {
        ...rejected,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: false, description: phrase }), {
            status: 400,
          }),
      },
    );
    expect(rejected.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain("bot-token");
  });

  it("reports a chat member count", async () => {
    const kit = deps();
    const calls: { method: string; body: string }[] = [];
    await handleIncomingEvent(
      await incoming({ text: "/count -100", direct: true }),
      {
        ...kit,
        botToken: "bot-token",
        fetchImpl: async (input, init) => {
          const url = String(input);
          calls.push({
            method: url.slice(url.lastIndexOf("/") + 1),
            body: String(init?.body ?? ""),
          });
          return new Response(
            JSON.stringify({
              ok: true,
              result: 42,
              title: phrase,
              invite_link: "https://t.me/+AbCdEfGhIjKlMnOp",
            }),
            { status: 200 },
          );
        },
      },
    );
    expect(kit.reply.sent.map((message) => message.text)).toEqual([
      "-100 有 42 人",
    ]);
    expect(calls.map((call) => call.method)).toEqual(["getChatMemberCount"]);
    const body = JSON.parse(calls[0]?.body ?? "{}") as { chat_id?: number };
    expect(body.chat_id).toBe(-100);
    expect(JSON.stringify(kit.reply.sent)).not.toContain(phrase);
    expect(JSON.stringify(kit.reply.sent)).not.toContain("t.me/+");
    expect(JSON.stringify(kit.logger.entries)).not.toContain("bot-token");
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
    const offline = deps();
    await handleIncomingEvent(
      await incoming({ text: "/count -100", direct: true }),
      offline,
    );
    expect(offline.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    const rejected = deps();
    await handleIncomingEvent(
      await incoming({ text: "/count -100", direct: true }),
      {
        ...rejected,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: false, description: phrase }), {
            status: 400,
          }),
      },
    );
    expect(rejected.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain("bot-token");
  });

  it("pins one message and leaves the other pins", async () => {
    const kit = deps();
    const calls: { method: string; body: string }[] = [];
    await handleIncomingEvent(
      await incoming({ text: "/pin -100 55", direct: true }),
      {
        ...kit,
        botToken: "bot-token",
        fetchImpl: async (input, init) => {
          const url = String(input);
          calls.push({
            method: url.slice(url.lastIndexOf("/") + 1),
            body: String(init?.body ?? ""),
          });
          return new Response(
            JSON.stringify({
              ok: true,
              result: true,
              title: phrase,
              invite_link: "https://t.me/+AbCdEfGhIjKlMnOp",
            }),
            { status: 200 },
          );
        },
      },
    );
    expect(kit.reply.sent.map((message) => message.text)).toEqual([
      "已请求置顶 -100 的消息 55。群里可能收到通知。频道和私聊不会。消息还在。其它置顶还在。",
    ]);
    expect(calls.map((call) => call.method)).toEqual(["pinChatMessage"]);
    const body = JSON.parse(calls[0]?.body ?? "{}") as {
      chat_id?: number;
      message_id?: number;
      disable_notification?: boolean;
    };
    expect(body.chat_id).toBe(-100);
    expect(body.message_id).toBe(55);
    expect(body.disable_notification).toBeUndefined();
    expect(JSON.stringify(kit.reply.sent)).not.toContain(phrase);
    expect(JSON.stringify(kit.reply.sent)).not.toContain("t.me/+");
    expect(JSON.stringify(kit.logger.entries)).not.toContain("bot-token");
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
    const offline = deps();
    await handleIncomingEvent(
      await incoming({ text: "/pin -100 55", direct: true }),
      offline,
    );
    expect(offline.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    const rejected = deps();
    await handleIncomingEvent(
      await incoming({ text: "/pin -100 55", direct: true }),
      {
        ...rejected,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: false, description: phrase }), {
            status: 400,
          }),
      },
    );
    expect(rejected.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain("bot-token");
  });

  it("unpins one message and leaves the other pins", async () => {
    const kit = deps();
    const calls: { method: string; body: string }[] = [];
    await handleIncomingEvent(
      await incoming({ text: "/unpinmsg -100 55", direct: true }),
      {
        ...kit,
        botToken: "bot-token",
        fetchImpl: async (input, init) => {
          const url = String(input);
          calls.push({
            method: url.slice(url.lastIndexOf("/") + 1),
            body: String(init?.body ?? ""),
          });
          return new Response(
            JSON.stringify({
              ok: true,
              result: true,
              title: phrase,
              invite_link: "https://t.me/+AbCdEfGhIjKlMnOp",
            }),
            { status: 200 },
          );
        },
      },
    );
    expect(kit.reply.sent.map((message) => message.text)).toEqual([
      "已请求撤下 -100 的消息 55 的置顶。消息还在。其它置顶还在。",
    ]);
    expect(calls.map((call) => call.method)).toEqual(["unpinChatMessage"]);
    const body = JSON.parse(calls[0]?.body ?? "{}") as {
      chat_id?: number;
      message_id?: number;
      business_connection_id?: string;
    };
    expect(body.chat_id).toBe(-100);
    expect(body.message_id).toBe(55);
    expect(body.business_connection_id).toBeUndefined();
    expect(JSON.stringify(kit.reply.sent)).not.toContain(phrase);
    expect(JSON.stringify(kit.reply.sent)).not.toContain("t.me/+");
    expect(JSON.stringify(kit.logger.entries)).not.toContain("bot-token");
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
    const offline = deps();
    await handleIncomingEvent(
      await incoming({ text: "/unpinmsg -100 55", direct: true }),
      offline,
    );
    expect(offline.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    const rejected = deps();
    await handleIncomingEvent(
      await incoming({ text: "/unpinmsg -100 55", direct: true }),
      {
        ...rejected,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: false, description: phrase }), {
            status: 400,
          }),
      },
    );
    expect(rejected.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain("bot-token");
  });

  it("removes one actor reaction from one message", async () => {
    const kit = deps();
    const calls: { method: string; body: string }[] = [];
    await handleIncomingEvent(
      await incoming({ text: "/unreact -100 55 77", direct: true }),
      {
        ...kit,
        botToken: "bot-token",
        fetchImpl: async (input, init) => {
          const url = String(input);
          calls.push({
            method: url.slice(url.lastIndexOf("/") + 1),
            body: String(init?.body ?? ""),
          });
          return new Response(
            JSON.stringify({
              ok: true,
              result: true,
              title: phrase,
              invite_link: "https://t.me/+AbCdEfGhIjKlMnOp",
            }),
            { status: 200 },
          );
        },
      },
    );
    expect(kit.reply.sent.map((message) => message.text)).toEqual([
      "已请求撤下 77 在 -100 消息 55 上的反应。别人的反应还在。其它消息上的反应还在。",
    ]);
    expect(calls.map((call) => call.method)).toEqual(["deleteMessageReaction"]);
    const body = JSON.parse(calls[0]?.body ?? "{}") as {
      chat_id?: number;
      message_id?: number;
      user_id?: number;
      actor_chat_id?: number;
    };
    expect(body.chat_id).toBe(-100);
    expect(body.message_id).toBe(55);
    expect(body.user_id).toBe(77);
    expect(body.actor_chat_id).toBeUndefined();
    expect(JSON.stringify(kit.reply.sent)).not.toContain(phrase);
    expect(JSON.stringify(kit.reply.sent)).not.toContain("t.me/+");
    expect(JSON.stringify(kit.logger.entries)).not.toContain("bot-token");
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
    const offline = deps();
    await handleIncomingEvent(
      await incoming({ text: "/unreact -100 55 77", direct: true }),
      offline,
    );
    expect(offline.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    const rejected = deps();
    await handleIncomingEvent(
      await incoming({ text: "/unreact -100 55 77", direct: true }),
      {
        ...rejected,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: false, description: phrase }), {
            status: 400,
          }),
      },
    );
    expect(rejected.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain("bot-token");
  });

  it("deletes a chat photo and drops the file id", async () => {
    const kit = deps();
    const calls: { method: string; body: string }[] = [];
    const fileId = "AgADBAAD";
    await handleIncomingEvent(
      await incoming({ text: "/delphoto -100", direct: true }),
      {
        ...kit,
        botToken: "bot-token",
        fetchImpl: async (input, init) => {
          const url = String(input);
          calls.push({
            method: url.slice(url.lastIndexOf("/") + 1),
            body: String(init?.body ?? ""),
          });
          return new Response(
            JSON.stringify({
              ok: true,
              result: true,
              title: phrase,
              photo: [{ file_id: fileId }],
              invite_link: "https://t.me/+AbCdEfGhIjKlMnOp",
            }),
            { status: 200 },
          );
        },
      },
    );
    expect(kit.reply.sent.map((message) => message.text)).toEqual([
      "已请求删除 -100 的头像。标题和简介还在。",
    ]);
    expect(calls.map((call) => call.method)).toEqual(["deleteChatPhoto"]);
    const body = JSON.parse(calls[0]?.body ?? "{}") as {
      chat_id?: number;
      photo?: string;
    };
    expect(body.chat_id).toBe(-100);
    expect(body.photo).toBeUndefined();
    expect(JSON.stringify(kit.reply.sent)).not.toContain(phrase);
    expect(JSON.stringify(kit.reply.sent)).not.toContain(fileId);
    expect(JSON.stringify(kit.reply.sent)).not.toContain("t.me/+");
    expect(JSON.stringify(kit.logger.entries)).not.toContain("bot-token");
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(kit.logger.entries)).not.toContain(fileId);
    const offline = deps();
    await handleIncomingEvent(
      await incoming({ text: "/delphoto -100", direct: true }),
      offline,
    );
    expect(offline.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    const rejected = deps();
    await handleIncomingEvent(
      await incoming({ text: "/delphoto -100", direct: true }),
      {
        ...rejected,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: false, description: phrase }), {
            status: 400,
          }),
      },
    );
    expect(rejected.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain("bot-token");
  });

  it("leaves a chat and drops the title", async () => {
    const kit = deps();
    const calls: { method: string; body: string }[] = [];
    await handleIncomingEvent(
      await incoming({ text: "/leave -100", direct: true }),
      {
        ...kit,
        botToken: "bot-token",
        fetchImpl: async (input, init) => {
          const url = String(input);
          calls.push({
            method: url.slice(url.lastIndexOf("/") + 1),
            body: String(init?.body ?? ""),
          });
          return new Response(
            JSON.stringify({
              ok: true,
              result: true,
              title: phrase,
              invite_link: "https://t.me/+AbCdEfGhIjKlMnOp",
            }),
            { status: 200 },
          );
        },
      },
    );
    expect(kit.reply.sent.map((message) => message.text)).toEqual([
      "已请求退出 -100。之后这个 bot 不再处理它。消息还在。",
    ]);
    expect(calls.map((call) => call.method)).toEqual(["leaveChat"]);
    const body = JSON.parse(calls[0]?.body ?? "{}") as {
      chat_id?: number;
      title?: string;
    };
    expect(body.chat_id).toBe(-100);
    expect(body.title).toBeUndefined();
    expect(JSON.stringify(kit.reply.sent)).not.toContain(phrase);
    expect(JSON.stringify(kit.reply.sent)).not.toContain("t.me/+");
    expect(JSON.stringify(kit.logger.entries)).not.toContain("bot-token");
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
    const offline = deps();
    await handleIncomingEvent(
      await incoming({ text: "/leave -100", direct: true }),
      offline,
    );
    expect(offline.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    const rejected = deps();
    await handleIncomingEvent(
      await incoming({ text: "/leave -100", direct: true }),
      {
        ...rejected,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: false, description: phrase }), {
            status: 400,
          }),
      },
    );
    expect(rejected.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain("bot-token");
  });

  it("sets a member tag and drops the name", async () => {
    const kit = deps();
    const calls: { method: string; body: string }[] = [];
    await handleIncomingEvent(
      await incoming({ text: "/tag -100 77 ops", direct: true }),
      {
        ...kit,
        botToken: "bot-token",
        fetchImpl: async (input, init) => {
          const url = String(input);
          calls.push({
            method: url.slice(url.lastIndexOf("/") + 1),
            body: String(init?.body ?? ""),
          });
          return new Response(
            JSON.stringify({
              ok: true,
              result: true,
              first_name: phrase,
              invite_link: "https://t.me/+AbCdEfGhIjKlMnOp",
            }),
            { status: 200 },
          );
        },
      },
    );
    expect(kit.reply.sent.map((message) => message.text)).toEqual([
      "已请求设置 -100 里 77 的标签。名字还在。",
    ]);
    expect(calls.map((call) => call.method)).toEqual(["setChatMemberTag"]);
    const body = JSON.parse(calls[0]?.body ?? "{}") as {
      chat_id?: number;
      user_id?: number;
      tag?: string;
      first_name?: string;
    };
    expect(body).toEqual({ chat_id: -100, user_id: 77, tag: "ops" });
    expect(JSON.stringify(kit.reply.sent)).not.toContain(phrase);
    expect(JSON.stringify(kit.reply.sent)).not.toContain("t.me/+");
    expect(JSON.stringify(kit.logger.entries)).not.toContain("bot-token");
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(kit.logger.entries)).not.toContain("ops");
    const offline = deps();
    await handleIncomingEvent(
      await incoming({ text: "/tag -100 77 ops", direct: true }),
      offline,
    );
    expect(offline.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    const rejected = deps();
    await handleIncomingEvent(
      await incoming({ text: `/tag -100 77 ${phrase}`, direct: true }),
      {
        ...rejected,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: false, description: phrase }), {
            status: 400,
          }),
      },
    );
    expect(rejected.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain("bot-token");
  });

  it("deletes a group sticker set and drops the set name", async () => {
    const kit = deps();
    const calls: { method: string; body: string }[] = [];
    const setName = "spam_stickers_by_bot";
    await handleIncomingEvent(
      await incoming({ text: "/delstickers -100", direct: true }),
      {
        ...kit,
        botToken: "bot-token",
        fetchImpl: async (input, init) => {
          const url = String(input);
          calls.push({
            method: url.slice(url.lastIndexOf("/") + 1),
            body: String(init?.body ?? ""),
          });
          return new Response(
            JSON.stringify({
              ok: true,
              result: true,
              title: phrase,
              sticker_set_name: setName,
              invite_link: "https://t.me/+AbCdEfGhIjKlMnOp",
            }),
            { status: 200 },
          );
        },
      },
    );
    expect(kit.reply.sent.map((message) => message.text)).toEqual([
      "已请求删除 -100 的群贴纸包。消息还在。",
    ]);
    expect(calls.map((call) => call.method)).toEqual(["deleteChatStickerSet"]);
    const body = JSON.parse(calls[0]?.body ?? "{}") as {
      chat_id?: number;
      sticker_set_name?: string;
    };
    expect(body.chat_id).toBe(-100);
    expect(body.sticker_set_name).toBeUndefined();
    expect(JSON.stringify(kit.reply.sent)).not.toContain(phrase);
    expect(JSON.stringify(kit.reply.sent)).not.toContain(setName);
    expect(JSON.stringify(kit.reply.sent)).not.toContain("t.me/+");
    expect(JSON.stringify(kit.logger.entries)).not.toContain("bot-token");
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(kit.logger.entries)).not.toContain(setName);
    const offline = deps();
    await handleIncomingEvent(
      await incoming({ text: "/delstickers -100", direct: true }),
      offline,
    );
    expect(offline.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    const rejected = deps();
    await handleIncomingEvent(
      await incoming({ text: "/delstickers -100", direct: true }),
      {
        ...rejected,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: false, description: phrase }), {
            status: 400,
          }),
      },
    );
    expect(rejected.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain("bot-token");
  });

  it("counts chat boosts and drops the booster name", async () => {
    const kit = deps();
    const calls: { method: string; body: string }[] = [];
    await handleIncomingEvent(
      await incoming({ text: "/boosts -100 77", direct: true }),
      {
        ...kit,
        botToken: "bot-token",
        fetchImpl: async (input, init) => {
          const url = String(input);
          calls.push({
            method: url.slice(url.lastIndexOf("/") + 1),
            body: String(init?.body ?? ""),
          });
          return new Response(
            JSON.stringify({
              ok: true,
              result: {
                boosts: [
                  {
                    boost_id: "boost-secret",
                    source: { source: "premium", user: { first_name: phrase } },
                  },
                ],
              },
            }),
            { status: 200 },
          );
        },
      },
    );
    expect(kit.reply.sent.map((message) => message.text)).toEqual([
      "77 在 -100 有 1 次助推",
    ]);
    expect(calls.map((call) => call.method)).toEqual(["getUserChatBoosts"]);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      chat_id: -100,
      user_id: 77,
    });
    expect(JSON.stringify(kit.reply.sent)).not.toContain(phrase);
    expect(JSON.stringify(kit.reply.sent)).not.toContain("boost-secret");
    expect(JSON.stringify(kit.logger.entries)).not.toContain("bot-token");
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(kit.logger.entries)).not.toContain("boost-secret");
    const offline = deps();
    await handleIncomingEvent(
      await incoming({ text: "/boosts -100 77", direct: true }),
      offline,
    );
    expect(offline.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    const rejected = deps();
    await handleIncomingEvent(
      await incoming({ text: "/boosts -100 77", direct: true }),
      {
        ...rejected,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: false, description: phrase }), {
            status: 400,
          }),
      },
    );
    expect(rejected.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain("bot-token");
  });

  it("sets one emoji reaction and keeps other people's reactions", async () => {
    const kit = deps();
    const calls: { method: string; body: string }[] = [];
    await handleIncomingEvent(
      await incoming({ text: "/react -100 55 👍", direct: true }),
      {
        ...kit,
        botToken: "bot-token",
        fetchImpl: async (input, init) => {
          const url = String(input);
          calls.push({
            method: url.slice(url.lastIndexOf("/") + 1),
            body: String(init?.body ?? ""),
          });
          return new Response(
            JSON.stringify({
              ok: true,
              result: true,
              description: phrase,
            }),
            { status: 200 },
          );
        },
      },
    );
    expect(kit.reply.sent.map((message) => message.text)).toEqual([
      "已请求在 -100 的消息 55 上设置 👍。别人的反应还在。一组媒体里会落到还在的第一条。",
    ]);
    expect(calls.map((call) => call.method)).toEqual(["setMessageReaction"]);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      chat_id: -100,
      message_id: 55,
      reaction: [{ type: "emoji", emoji: "👍" }],
    });
    expect(calls[0]?.body).not.toContain("is_big");
    expect(JSON.stringify(kit.reply.sent)).not.toContain(phrase);
    expect(JSON.stringify(kit.logger.entries)).not.toContain("bot-token");
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
    const offline = deps();
    await handleIncomingEvent(
      await incoming({ text: "/react -100 55 👍", direct: true }),
      offline,
    );
    expect(offline.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    const rejected = deps();
    await handleIncomingEvent(
      await incoming({ text: "/react -100 55 👍", direct: true }),
      {
        ...rejected,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: false, description: phrase }), {
            status: 400,
          }),
      },
    );
    expect(rejected.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain("👍");
    expect(JSON.stringify(rejected.logger.entries)).not.toContain("bot-token");
  });

  it("changes a chat title and drops the description", async () => {
    const kit = deps();
    const calls: { method: string; body: string }[] = [];
    await handleIncomingEvent(
      await incoming({ text: "/title -100 hello", direct: true }),
      {
        ...kit,
        botToken: "bot-token",
        fetchImpl: async (input, init) => {
          const url = String(input);
          calls.push({
            method: url.slice(url.lastIndexOf("/") + 1),
            body: String(init?.body ?? ""),
          });
          return new Response(
            JSON.stringify({
              ok: true,
              result: true,
              description: phrase,
              photo: { small_file_id: "photo-secret" },
            }),
            { status: 200 },
          );
        },
      },
    );
    expect(kit.reply.sent.map((message) => message.text)).toEqual([
      "已请求修改 -100 的标题。简介和头像还在。",
    ]);
    expect(calls.map((call) => call.method)).toEqual(["setChatTitle"]);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      chat_id: -100,
      title: "hello",
    });
    expect(JSON.stringify(kit.reply.sent)).not.toContain("hello");
    expect(JSON.stringify(kit.reply.sent)).not.toContain(phrase);
    expect(JSON.stringify(kit.reply.sent)).not.toContain("photo-secret");
    expect(JSON.stringify(kit.logger.entries)).not.toContain("bot-token");
    expect(JSON.stringify(kit.logger.entries)).not.toContain("hello");
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
    const offline = deps();
    await handleIncomingEvent(
      await incoming({ text: "/title -100 hello", direct: true }),
      offline,
    );
    expect(offline.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    const rejected = deps();
    await handleIncomingEvent(
      await incoming({ text: `/title -100 ${phrase}`, direct: true }),
      {
        ...rejected,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: false, description: phrase }), {
            status: 400,
          }),
      },
    );
    expect(rejected.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain("bot-token");
  });

  it("changes a chat description and drops the title", async () => {
    const kit = deps();
    const calls: { method: string; body: string }[] = [];
    await handleIncomingEvent(
      await incoming({ text: "/desc -100 hello", direct: true }),
      {
        ...kit,
        botToken: "bot-token",
        fetchImpl: async (input, init) => {
          const url = String(input);
          calls.push({
            method: url.slice(url.lastIndexOf("/") + 1),
            body: String(init?.body ?? ""),
          });
          return new Response(
            JSON.stringify({
              ok: true,
              result: true,
              title: phrase,
              photo: { small_file_id: "photo-secret" },
            }),
            { status: 200 },
          );
        },
      },
    );
    expect(kit.reply.sent.map((message) => message.text)).toEqual([
      "已请求修改 -100 的简介。标题和头像还在。",
    ]);
    expect(calls.map((call) => call.method)).toEqual(["setChatDescription"]);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      chat_id: -100,
      description: "hello",
    });
    expect(JSON.stringify(kit.reply.sent)).not.toContain("hello");
    expect(JSON.stringify(kit.reply.sent)).not.toContain(phrase);
    expect(JSON.stringify(kit.reply.sent)).not.toContain("photo-secret");
    expect(JSON.stringify(kit.logger.entries)).not.toContain("bot-token");
    expect(JSON.stringify(kit.logger.entries)).not.toContain("hello");
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
    const offline = deps();
    await handleIncomingEvent(
      await incoming({ text: "/desc -100 hello", direct: true }),
      offline,
    );
    expect(offline.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    const rejected = deps();
    await handleIncomingEvent(
      await incoming({ text: `/desc -100 ${phrase}`, direct: true }),
      {
        ...rejected,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: false, description: phrase }), {
            status: 400,
          }),
      },
    );
    expect(rejected.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain("bot-token");
  });

  it("creates one forum topic and drops the name", async () => {
    const kit = deps();
    const calls: { method: string; body: string }[] = [];
    await handleIncomingEvent(
      await incoming({ text: "/newtopic -100 hello", direct: true }),
      {
        ...kit,
        botToken: "bot-token",
        fetchImpl: async (input, init) => {
          const url = String(input);
          calls.push({
            method: url.slice(url.lastIndexOf("/") + 1),
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
        },
      },
    );
    expect(kit.reply.sent.map((message) => message.text)).toEqual([
      "已在 -100 建好话题 55。其它话题还在。",
    ]);
    expect(calls.map((call) => call.method)).toEqual(["createForumTopic"]);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      chat_id: -100,
      name: "hello",
    });
    expect(calls[0]?.body).not.toContain("icon_color");
    expect(JSON.stringify(kit.reply.sent)).not.toContain("hello");
    expect(JSON.stringify(kit.reply.sent)).not.toContain(phrase);
    expect(JSON.stringify(kit.reply.sent)).not.toContain("emoji-secret");
    expect(JSON.stringify(kit.logger.entries)).not.toContain("bot-token");
    expect(JSON.stringify(kit.logger.entries)).not.toContain("hello");
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
    const offline = deps();
    await handleIncomingEvent(
      await incoming({ text: "/newtopic -100 hello", direct: true }),
      offline,
    );
    expect(offline.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    const rejected = deps();
    await handleIncomingEvent(
      await incoming({ text: `/newtopic -100 ${phrase}`, direct: true }),
      {
        ...rejected,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: false, description: phrase }), {
            status: 400,
          }),
      },
    );
    expect(rejected.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain("bot-token");
  });

  it("renames one forum topic and drops the name", async () => {
    const kit = deps();
    const calls: { method: string; body: string }[] = [];
    await handleIncomingEvent(
      await incoming({ text: "/rentopic -100 55 hello", direct: true }),
      {
        ...kit,
        botToken: "bot-token",
        fetchImpl: async (input, init) => {
          const url = String(input);
          calls.push({
            method: url.slice(url.lastIndexOf("/") + 1),
            body: String(init?.body ?? ""),
          });
          return new Response(
            JSON.stringify({
              ok: true,
              result: true,
              name: phrase,
              icon_custom_emoji_id: "emoji-secret",
            }),
            { status: 200 },
          );
        },
      },
    );
    expect(kit.reply.sent.map((message) => message.text)).toEqual([
      "已请求修改 -100 里话题 55 的名字。消息还在。其它话题还在。",
    ]);
    expect(calls.map((call) => call.method)).toEqual(["editForumTopic"]);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      chat_id: -100,
      message_thread_id: 55,
      name: "hello",
    });
    expect(calls[0]?.body).not.toContain("icon_custom_emoji_id");
    expect(JSON.stringify(kit.reply.sent)).not.toContain("hello");
    expect(JSON.stringify(kit.reply.sent)).not.toContain(phrase);
    expect(JSON.stringify(kit.reply.sent)).not.toContain("emoji-secret");
    expect(JSON.stringify(kit.logger.entries)).not.toContain("bot-token");
    expect(JSON.stringify(kit.logger.entries)).not.toContain("hello");
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
    const offline = deps();
    await handleIncomingEvent(
      await incoming({ text: "/rentopic -100 55 hello", direct: true }),
      offline,
    );
    expect(offline.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    const rejected = deps();
    await handleIncomingEvent(
      await incoming({ text: `/rentopic -100 55 ${phrase}`, direct: true }),
      {
        ...rejected,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: false, description: phrase }), {
            status: 400,
          }),
      },
    );
    expect(rejected.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain("bot-token");
  });

  it("renames the General topic and drops the name", async () => {
    const kit = deps();
    const calls: { method: string; body: string }[] = [];
    await handleIncomingEvent(
      await incoming({ text: "/rengeneral -100 hello", direct: true }),
      {
        ...kit,
        botToken: "bot-token",
        fetchImpl: async (input, init) => {
          const url = String(input);
          calls.push({
            method: url.slice(url.lastIndexOf("/") + 1),
            body: String(init?.body ?? ""),
          });
          return new Response(
            JSON.stringify({
              ok: true,
              result: true,
              name: phrase,
              message_thread_id: 1,
            }),
            { status: 200 },
          );
        },
      },
    );
    expect(kit.reply.sent.map((message) => message.text)).toEqual([
      "已请求修改 -100 的通用话题名字。其它话题还在。消息还在。",
    ]);
    expect(calls.map((call) => call.method)).toEqual(["editGeneralForumTopic"]);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      chat_id: -100,
      name: "hello",
    });
    expect(calls[0]?.method).not.toContain("editForumTopic");
    expect(calls[0]?.body).not.toContain("message_thread_id");
    expect(JSON.stringify(kit.reply.sent)).not.toContain("hello");
    expect(JSON.stringify(kit.reply.sent)).not.toContain(phrase);
    expect(JSON.stringify(kit.logger.entries)).not.toContain("bot-token");
    expect(JSON.stringify(kit.logger.entries)).not.toContain("hello");
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
    const offline = deps();
    await handleIncomingEvent(
      await incoming({ text: "/rengeneral -100 hello", direct: true }),
      offline,
    );
    expect(offline.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    const rejected = deps();
    await handleIncomingEvent(
      await incoming({ text: `/rengeneral -100 ${phrase}`, direct: true }),
      {
        ...rejected,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: false, description: phrase }), {
            status: 400,
          }),
      },
    );
    expect(rejected.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain("bot-token");
  });

  it("sets a group sticker set and drops the name", async () => {
    const kit = deps();
    const calls: { method: string; body: string }[] = [];
    const name = "Animals_by_SomeBot";
    await handleIncomingEvent(
      await incoming({ text: `/stickers -100 ${name}`, direct: true }),
      {
        ...kit,
        botToken: "bot-token",
        fetchImpl: async (input, init) => {
          const url = String(input);
          calls.push({
            method: url.slice(url.lastIndexOf("/") + 1),
            body: String(init?.body ?? ""),
          });
          return new Response(
            JSON.stringify({
              ok: true,
              result: true,
              name,
              file_id: phrase,
            }),
            { status: 200 },
          );
        },
      },
    );
    expect(kit.reply.sent.map((message) => message.text)).toEqual([
      "已请求设置 -100 的群贴纸包。消息还在。",
    ]);
    expect(calls.map((call) => call.method)).toEqual(["setChatStickerSet"]);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      chat_id: -100,
      sticker_set_name: name,
    });
    expect(calls[0]?.method).not.toContain("deleteChatStickerSet");
    expect(calls[0]?.method).not.toContain("getStickerSet");
    expect(JSON.stringify(kit.reply.sent)).not.toContain(name);
    expect(JSON.stringify(kit.reply.sent)).not.toContain(phrase);
    expect(JSON.stringify(kit.logger.entries)).not.toContain("bot-token");
    expect(JSON.stringify(kit.logger.entries)).not.toContain(name);
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
    const offline = deps();
    await handleIncomingEvent(
      await incoming({ text: `/stickers -100 ${name}`, direct: true }),
      offline,
    );
    expect(offline.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    const rejected = deps();
    await handleIncomingEvent(
      await incoming({ text: `/stickers -100 ${name}`, direct: true }),
      {
        ...rejected,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: false, description: phrase }), {
            status: 400,
          }),
      },
    );
    expect(rejected.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain(name);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain("bot-token");
  });

  it("sets an admin title and drops the title", async () => {
    const kit = deps();
    const calls: { method: string; body: string }[] = [];
    await handleIncomingEvent(
      await incoming({ text: "/admintitle -100 77 hello", direct: true }),
      {
        ...kit,
        botToken: "bot-token",
        fetchImpl: async (input, init) => {
          const url = String(input);
          calls.push({
            method: url.slice(url.lastIndexOf("/") + 1),
            body: String(init?.body ?? ""),
          });
          return new Response(
            JSON.stringify({
              ok: true,
              result: true,
              custom_title: phrase,
            }),
            { status: 200 },
          );
        },
      },
    );
    expect(kit.reply.sent.map((message) => message.text)).toEqual([
      "已请求设置 -100 里 77 的管理员头衔。权限还在。",
    ]);
    expect(calls.map((call) => call.method)).toEqual([
      "setChatAdministratorCustomTitle",
    ]);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      chat_id: -100,
      user_id: 77,
      custom_title: "hello",
    });
    expect(calls[0]?.method).not.toContain("promoteChatMember");
    expect(calls[0]?.method).not.toContain("setChatMemberTag");
    expect(JSON.stringify(kit.reply.sent)).not.toContain("hello");
    expect(JSON.stringify(kit.reply.sent)).not.toContain(phrase);
    expect(JSON.stringify(kit.logger.entries)).not.toContain("bot-token");
    expect(JSON.stringify(kit.logger.entries)).not.toContain("hello");
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
    const cleared = deps();
    const clearCalls: { method: string; body: string }[] = [];
    await handleIncomingEvent(
      await incoming({ text: "/admintitle -100 77", direct: true }),
      {
        ...cleared,
        botToken: "bot-token",
        fetchImpl: async (input, init) => {
          const url = String(input);
          clearCalls.push({
            method: url.slice(url.lastIndexOf("/") + 1),
            body: String(init?.body ?? ""),
          });
          return new Response(JSON.stringify({ ok: true, result: true }), {
            status: 200,
          });
        },
      },
    );
    expect(cleared.reply.sent.map((message) => message.text)).toEqual([
      "已请求清掉 -100 里 77 的管理员头衔。权限还在。",
    ]);
    expect(JSON.parse(clearCalls[0]?.body ?? "{}")).toEqual({
      chat_id: -100,
      user_id: 77,
      custom_title: "",
    });
    const offline = deps();
    await handleIncomingEvent(
      await incoming({ text: "/admintitle -100 77 hello", direct: true }),
      offline,
    );
    expect(offline.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    const rejected = deps();
    await handleIncomingEvent(
      await incoming({ text: `/admintitle -100 77 ${phrase}`, direct: true }),
      {
        ...rejected,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: false, description: phrase }), {
            status: 400,
          }),
      },
    );
    expect(rejected.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain("bot-token");
  });

  it("declines one suggested post and drops the comment", async () => {
    const kit = deps();
    const calls: { method: string; body: string }[] = [];
    await handleIncomingEvent(
      await incoming({ text: `/declinepost -100 55 ${phrase}`, direct: true }),
      {
        ...kit,
        botToken: "bot-token",
        fetchImpl: async (input, init) => {
          const url = String(input);
          calls.push({
            method: url.slice(url.lastIndexOf("/") + 1),
            body: String(init?.body ?? ""),
          });
          return new Response(
            JSON.stringify({
              ok: true,
              result: true,
              comment: phrase,
            }),
            { status: 200 },
          );
        },
      },
    );
    expect(kit.reply.sent.map((message) => message.text)).toEqual([
      "已请求拒绝 -100 的建议帖 55。这条不会发出。其它建议帖还在。",
    ]);
    expect(calls.map((call) => call.method)).toEqual(["declineSuggestedPost"]);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      chat_id: -100,
      message_id: 55,
      comment: phrase,
    });
    expect(calls[0]?.method).not.toContain("approveSuggestedPost");
    expect(calls[0]?.body).not.toContain("send_date");
    expect(JSON.stringify(kit.reply.sent)).not.toContain(phrase);
    expect(JSON.stringify(kit.logger.entries)).not.toContain("bot-token");
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
    const quiet = deps();
    const quietCalls: { method: string; body: string }[] = [];
    await handleIncomingEvent(
      await incoming({ text: "/declinepost -100 1", direct: true }),
      {
        ...quiet,
        botToken: "bot-token",
        fetchImpl: async (input, init) => {
          const url = String(input);
          quietCalls.push({
            method: url.slice(url.lastIndexOf("/") + 1),
            body: String(init?.body ?? ""),
          });
          return new Response(JSON.stringify({ ok: true, result: true }), {
            status: 200,
          });
        },
      },
    );
    expect(quiet.reply.sent.map((message) => message.text)).toEqual([
      "已请求拒绝 -100 的建议帖 1。这条不会发出。其它建议帖还在。",
    ]);
    expect(JSON.parse(quietCalls[0]?.body ?? "{}")).toEqual({
      chat_id: -100,
      message_id: 1,
    });
    expect(quietCalls[0]?.body).not.toContain("comment");
    const offline = deps();
    await handleIncomingEvent(
      await incoming({ text: "/declinepost -100 55", direct: true }),
      offline,
    );
    expect(offline.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    const rejected = deps();
    await handleIncomingEvent(
      await incoming({ text: `/declinepost -100 55 ${phrase}`, direct: true }),
      {
        ...rejected,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: false, description: phrase }), {
            status: 400,
          }),
      },
    );
    expect(rejected.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain("bot-token");
  });

  it("deletes one ephemeral message for one recipient", async () => {
    const kit = deps();
    const calls: { method: string; url: string; body: string }[] = [];
    await handleIncomingEvent(
      await incoming({ text: "/delephemeral -100 77 55", direct: true }),
      {
        ...kit,
        botToken: "bot-token",
        fetchImpl: async (input, init) => {
          const url = String(input);
          calls.push({
            method: url.slice(url.lastIndexOf("/") + 1),
            url,
            body: String(init?.body ?? ""),
          });
          return new Response(
            JSON.stringify({
              ok: true,
              result: true,
              description: phrase,
            }),
            { status: 200 },
          );
        },
      },
    );
    expect(kit.reply.sent.map((message) => message.text)).toEqual([
      "已请求删除 -100 里发给 77 的临时消息 55。对方离线时可能收不到这次删除。其它消息还在。",
    ]);
    expect(calls.map((call) => call.method)).toEqual([
      "deleteEphemeralMessage",
    ]);
    expect(calls[0]?.url).not.toContain("/deleteMessage");
    expect(calls[0]?.method).not.toContain("deleteMessages");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      chat_id: -100,
      receiver_user_id: 77,
      ephemeral_message_id: 55,
    });
    expect(calls[0]?.body).not.toContain('"message_id"');
    expect(JSON.stringify(kit.reply.sent)).not.toContain(phrase);
    expect(JSON.stringify(kit.logger.entries)).not.toContain("bot-token");
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
    const first = deps();
    const firstCalls: { method: string; body: string }[] = [];
    await handleIncomingEvent(
      await incoming({ text: "/delephemeral -100 77 1", direct: true }),
      {
        ...first,
        botToken: "bot-token",
        fetchImpl: async (input, init) => {
          const url = String(input);
          firstCalls.push({
            method: url.slice(url.lastIndexOf("/") + 1),
            body: String(init?.body ?? ""),
          });
          return new Response(JSON.stringify({ ok: true, result: true }), {
            status: 200,
          });
        },
      },
    );
    expect(first.reply.sent.map((message) => message.text)).toEqual([
      "已请求删除 -100 里发给 77 的临时消息 1。对方离线时可能收不到这次删除。其它消息还在。",
    ]);
    expect(JSON.parse(firstCalls[0]?.body ?? "{}")).toEqual({
      chat_id: -100,
      receiver_user_id: 77,
      ephemeral_message_id: 1,
    });
    const offline = deps();
    await handleIncomingEvent(
      await incoming({ text: "/delephemeral -100 77 55", direct: true }),
      offline,
    );
    expect(offline.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    const rejected = deps();
    await handleIncomingEvent(
      await incoming({ text: "/delephemeral -100 77 55", direct: true }),
      {
        ...rejected,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: false, description: phrase }), {
            status: 400,
          }),
      },
    );
    expect(rejected.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain("bot-token");
  });

  it("sets this bot's default administrator rights", async () => {
    const kit = deps();
    const calls: { method: string; url: string; body: string }[] = [];
    const rights = {
      is_anonymous: false,
      can_manage_chat: true,
      can_delete_messages: true,
      can_manage_video_chats: false,
      can_restrict_members: false,
      can_promote_members: false,
      can_change_info: false,
      can_invite_users: false,
      can_post_stories: false,
      can_edit_stories: false,
      can_delete_stories: false,
      can_post_messages: false,
      can_edit_messages: false,
      can_pin_messages: false,
      can_manage_topics: false,
      can_manage_direct_messages: false,
      can_manage_tags: false,
      can_send_welcome_messages: false,
    };
    await handleIncomingEvent(
      await incoming({
        text: "/myrights manage_chat delete_messages",
        direct: true,
      }),
      {
        ...kit,
        botToken: "bot-token",
        fetchImpl: async (input, init) => {
          const url = String(input);
          calls.push({
            method: url.slice(url.lastIndexOf("/") + 1),
            url,
            body: String(init?.body ?? ""),
          });
          return new Response(
            JSON.stringify({ ok: true, result: true, description: phrase }),
            { status: 200 },
          );
        },
      },
    );
    expect(kit.reply.sent.map((message) => message.text)).toEqual([
      "已请求设置这个 bot 在群和超级群里的默认管理员权限。加入时仍可修改。已有群不受影响。",
    ]);
    expect(calls.map((call) => call.method)).toEqual([
      "setMyDefaultAdministratorRights",
    ]);
    expect(calls[0]?.method).not.toContain("promoteChatMember");
    expect(calls[0]?.method).not.toContain("getMyDefaultAdministratorRights");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ rights });
    expect(calls[0]?.body).not.toContain("for_channels");
    expect(calls[0]?.body).not.toContain("chat_id");
    expect(JSON.stringify(kit.reply.sent)).not.toContain(phrase);
    expect(JSON.stringify(kit.reply.sent)).not.toContain("manage_chat");
    expect(JSON.stringify(kit.logger.entries)).not.toContain("bot-token");
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
    const cleared = deps();
    const clearCalls: { method: string; body: string }[] = [];
    await handleIncomingEvent(
      await incoming({ text: "/myrights channels clear", direct: true }),
      {
        ...cleared,
        botToken: "bot-token",
        fetchImpl: async (input, init) => {
          const url = String(input);
          clearCalls.push({
            method: url.slice(url.lastIndexOf("/") + 1),
            body: String(init?.body ?? ""),
          });
          return new Response(JSON.stringify({ ok: true, result: true }), {
            status: 200,
          });
        },
      },
    );
    expect(cleared.reply.sent.map((message) => message.text)).toEqual([
      "已请求清掉这个 bot 在频道里的默认管理员权限。已有频道不受影响。",
    ]);
    expect(JSON.parse(clearCalls[0]?.body ?? "{}")).toEqual({
      for_channels: true,
    });
    expect(clearCalls[0]?.body).not.toContain("rights");
    expect(clearCalls[0]?.method).not.toContain("promoteChatMember");
    const offline = deps();
    await handleIncomingEvent(
      await incoming({ text: "/myrights clear", direct: true }),
      offline,
    );
    expect(offline.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    const rejected = deps();
    await handleIncomingEvent(
      await incoming({ text: "/myrights clear", direct: true }),
      {
        ...rejected,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: false, description: phrase }), {
            status: 400,
          }),
      },
    );
    expect(rejected.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain("bot-token");
  });

  it("reads this bot's default administrator rights", async () => {
    const kit = deps();
    const calls: { method: string; body: string }[] = [];
    await handleIncomingEvent(
      await incoming({ text: "/botrights", direct: true }),
      {
        ...kit,
        botToken: "bot-token",
        fetchImpl: async (input, init) => {
          const url = String(input);
          calls.push({
            method: url.slice(url.lastIndexOf("/") + 1),
            body: String(init?.body ?? ""),
          });
          return new Response(
            JSON.stringify({
              ok: true,
              result: {
                can_manage_chat: true,
                can_delete_messages: false,
                description: phrase,
              },
            }),
            { status: 200 },
          );
        },
      },
    );
    expect(kit.reply.sent.map((message) => message.text)).toEqual([
      [
        "botrights 群",
        "匿名 未知",
        "管理 on",
        "删除 off",
        "视频 未知",
        "限制 未知",
        "提升 未知",
        "资料 未知",
        "邀请 未知",
        "故事 未知",
        "改故事 未知",
        "删故事 未知",
        "发帖 未知",
        "编辑 未知",
        "置顶 未知",
        "话题 未知",
        "私信 未知",
        "标签 未知",
        "欢迎 未知",
      ].join("\n"),
    ]);
    expect(calls.map((call) => call.method)).toEqual([
      "getMyDefaultAdministratorRights",
    ]);
    expect(calls[0]?.method).not.toContain("setMyDefaultAdministratorRights");
    expect(calls[0]?.method).not.toContain("promoteChatMember");
    expect(calls[0]?.body).toBe("{}");
    expect(JSON.stringify(kit.reply.sent)).not.toContain(phrase);
    expect(JSON.stringify(kit.logger.entries)).not.toContain("bot-token");
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
    const channels = deps();
    const channelCalls: { method: string; body: string }[] = [];
    await handleIncomingEvent(
      await incoming({ text: "/botrights channels", direct: true }),
      {
        ...channels,
        botToken: "bot-token",
        fetchImpl: async (input, init) => {
          const url = String(input);
          channelCalls.push({
            method: url.slice(url.lastIndexOf("/") + 1),
            body: String(init?.body ?? ""),
          });
          return new Response(
            JSON.stringify({
              ok: true,
              result: { can_post_messages: true },
            }),
            { status: 200 },
          );
        },
      },
    );
    expect(channels.reply.sent[0]?.text.startsWith("botrights 频道\n")).toBe(
      true,
    );
    expect(channels.reply.sent[0]?.text).toContain("发帖 on");
    expect(JSON.parse(channelCalls[0]?.body ?? "null")).toEqual({
      for_channels: true,
    });
    const offline = deps();
    await handleIncomingEvent(
      await incoming({ text: "/botrights", direct: true }),
      offline,
    );
    expect(offline.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    const rejected = deps();
    await handleIncomingEvent(
      await incoming({ text: "/botrights", direct: true }),
      {
        ...rejected,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              ok: true,
              result: { can_manage_chat: phrase },
            }),
            { status: 200 },
          ),
      },
    );
    expect(rejected.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain("bot-token");
  });

  it("sets the private command menu and leaves group menus alone", async () => {
    const kit = deps();
    const calls: { method: string; body: string }[] = [];
    await handleIncomingEvent(
      await incoming({ text: "/setcommands", direct: true }),
      {
        ...kit,
        botToken: "bot-token",
        fetchImpl: async (input, init) => {
          const url = String(input);
          calls.push({
            method: url.slice(url.lastIndexOf("/") + 1),
            body: String(init?.body ?? ""),
          });
          return new Response(JSON.stringify({ ok: true, result: true }), {
            status: 200,
          });
        },
      },
    );
    expect(kit.reply.sent.map((message) => message.text)).toEqual([
      "已请求设置私聊里的命令菜单。群菜单不变。已有单独语言列表的人不受影响。",
    ]);
    expect(calls.map((call) => call.method)).toEqual(["setMyCommands"]);
    expect(calls[0]?.method).not.toContain("deleteMyCommands");
    expect(calls[0]?.method).not.toContain("getMyCommands");
    const body = JSON.parse(calls[0]?.body ?? "null") as {
      commands: { command: string; description: string }[];
      scope: { type: string };
    };
    expect(body.scope).toEqual({ type: "all_private_chats" });
    expect(body).not.toHaveProperty("language_code");
    expect(body).not.toHaveProperty("chat_id");
    expect(body.commands).toHaveLength(76);
    expect(body.commands[0]).toEqual({ command: "help", description: "/help" });
    expect(body.commands.find((item) => item.command === "botdesc")).toEqual({
      command: "botdesc",
      description: "/botdesc [description]",
    });
    expect(body.commands.find((item) => item.command === "mydesc")).toEqual({
      command: "mydesc",
      description: "/mydesc",
    });
    expect(body.commands.find((item) => item.command === "botshort")).toEqual({
      command: "botshort",
      description: "/botshort [short]",
    });
    expect(body.commands.find((item) => item.command === "myshort")).toEqual({
      command: "myshort",
      description: "/myshort",
    });
    expect(body.commands.find((item) => item.command === "who")).toEqual({
      command: "who",
      description: "/who",
    });
    expect(body.commands.find((item) => item.command === "hook")).toEqual({
      command: "hook",
      description: "/hook",
    });
    expect(body.commands.find((item) => item.command === "guard")).toEqual({
      command: "guard",
      description: "/guard <chatId>",
    });
    expect(body.commands.find((item) => item.command === "joinbot")).toEqual({
      command: "joinbot",
      description: "/joinbot <chatId>",
    });
    expect(body.commands.find((item) => item.command === "reactions")).toEqual({
      command: "reactions",
      description: "/reactions <chatId>",
    });
    expect(body.commands.at(-1)).toEqual({
      command: "community",
      description: "/community <chatId>",
    });
    expect(calls[0]?.body).not.toContain("is_ephemeral");
    expect(calls[0]?.body).not.toContain(phrase);
    expect(calls[0]?.body).not.toContain("bot-token");
    expect(JSON.stringify(kit.reply.sent)).not.toContain("/help");
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
    const named = deps();
    const namedCalls: { method: string; body: string }[] = [];
    await handleIncomingEvent(
      await incoming({ text: "/setcommands private", direct: true }),
      {
        ...named,
        botToken: "bot-token",
        fetchImpl: async (input, init) => {
          const url = String(input);
          namedCalls.push({
            method: url.slice(url.lastIndexOf("/") + 1),
            body: String(init?.body ?? ""),
          });
          return new Response(JSON.stringify({ ok: true, result: true }), {
            status: 200,
          });
        },
      },
    );
    expect(JSON.parse(namedCalls[0]?.body ?? "null")).toEqual(body);
    const usage = deps();
    let used = false;
    await handleIncomingEvent(
      await incoming({ text: "/setcommands private extra", direct: true }),
      {
        ...usage,
        botToken: "bot-token",
        fetchImpl: async () => {
          used = true;
          return new Response(JSON.stringify({ ok: true, result: true }), {
            status: 200,
          });
        },
      },
    );
    expect(used).toBe(false);
    expect(usage.reply.sent.map((message) => message.text)).toEqual([
      "用法：/setcommands [private]",
    ]);
    const invalid = deps();
    let called = false;
    await handleIncomingEvent(
      await incoming({ text: `/setcommands ${phrase}`, direct: true }),
      {
        ...invalid,
        botToken: "bot-token",
        fetchImpl: async () => {
          called = true;
          return new Response(JSON.stringify({ ok: true, result: true }), {
            status: 200,
          });
        },
      },
    );
    expect(called).toBe(false);
    expect(invalid.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(invalid.reply.sent)).not.toContain(phrase);
    const offline = deps();
    await handleIncomingEvent(
      await incoming({ text: "/setcommands", direct: true }),
      offline,
    );
    expect(offline.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    const rejected = deps();
    await handleIncomingEvent(
      await incoming({ text: "/setcommands", direct: true }),
      {
        ...rejected,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: false, description: phrase }), {
            status: 400,
          }),
      },
    );
    expect(rejected.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain("bot-token");
  });

  it("reads the private command menu without inventing commands", async () => {
    const kit = deps();
    const calls: { method: string; body: string }[] = [];
    await handleIncomingEvent(
      await incoming({ text: "/commands", direct: true }),
      {
        ...kit,
        botToken: "bot-token",
        fetchImpl: async (input, init) => {
          const url = String(input);
          calls.push({
            method: url.slice(url.lastIndexOf("/") + 1),
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
                  is_ephemeral: false,
                },
              ],
            }),
            { status: 200 },
          );
        },
      },
    );
    expect(kit.reply.sent.map((message) => message.text)).toEqual([
      [
        "命令 2",
        "help /help 未知",
        "stickers /stickers <chatId> <name> off",
      ].join("\n"),
    ]);
    expect(calls.map((call) => call.method)).toEqual(["getMyCommands"]);
    expect(calls[0]?.method).not.toContain("setMyCommands");
    expect(calls[0]?.method).not.toContain("deleteMyCommands");
    expect(JSON.parse(calls[0]?.body ?? "null")).toEqual({
      scope: { type: "all_private_chats" },
    });
    expect(calls[0]?.body).not.toContain("language_code");
    expect(calls[0]?.body).not.toContain("chat_id");
    expect(JSON.stringify(kit.reply.sent)).not.toContain(phrase);
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(kit.logger.entries)).not.toContain("bot-token");
    const named = deps();
    const namedCalls: { method: string; body: string }[] = [];
    await handleIncomingEvent(
      await incoming({ text: "/commands private", direct: true }),
      {
        ...named,
        botToken: "bot-token",
        fetchImpl: async (input, init) => {
          const url = String(input);
          namedCalls.push({
            method: url.slice(url.lastIndexOf("/") + 1),
            body: String(init?.body ?? ""),
          });
          return new Response(JSON.stringify({ ok: true, result: [] }), {
            status: 200,
          });
        },
      },
    );
    expect(named.reply.sent.map((message) => message.text)).toEqual(["命令 0"]);
    expect(JSON.parse(namedCalls[0]?.body ?? "null")).toEqual({
      scope: { type: "all_private_chats" },
    });
    const broken = deps();
    await handleIncomingEvent(
      await incoming({ text: "/commands", direct: true }),
      {
        ...broken,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              ok: true,
              result: [
                { command: "help", description: "/help" },
                { command: "Rules", description: "/rules" },
              ],
            }),
            { status: 200 },
          ),
      },
    );
    expect(broken.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(broken.reply.sent)).not.toContain("/help");
    const offline = deps();
    await handleIncomingEvent(
      await incoming({ text: "/commands", direct: true }),
      offline,
    );
    expect(offline.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    const rejected = deps();
    await handleIncomingEvent(
      await incoming({ text: "/commands", direct: true }),
      {
        ...rejected,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: false, description: phrase }), {
            status: 400,
          }),
      },
    );
    expect(rejected.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain("bot-token");
  });

  it("clears the private command menu and leaves higher menus", async () => {
    const kit = deps();
    const calls: { method: string; body: string }[] = [];
    await handleIncomingEvent(
      await incoming({ text: "/delcommands", direct: true }),
      {
        ...kit,
        botToken: "bot-token",
        fetchImpl: async (input, init) => {
          const url = String(input);
          calls.push({
            method: url.slice(url.lastIndexOf("/") + 1),
            body: String(init?.body ?? ""),
          });
          return new Response(JSON.stringify({ ok: true, result: true }), {
            status: 200,
          });
        },
      },
    );
    expect(kit.reply.sent.map((message) => message.text)).toEqual([
      "已请求清掉私聊里的命令菜单。更高一层的菜单会显示出来。群菜单不变。已有单独语言列表的人不受影响。",
    ]);
    expect(calls.map((call) => call.method)).toEqual(["deleteMyCommands"]);
    expect(calls[0]?.method).not.toContain("setMyCommands");
    expect(calls[0]?.method).not.toContain("getMyCommands");
    expect(JSON.parse(calls[0]?.body ?? "null")).toEqual({
      scope: { type: "all_private_chats" },
    });
    expect(calls[0]?.body).not.toContain("language_code");
    expect(calls[0]?.body).not.toContain("chat_id");
    expect(calls[0]?.body).not.toContain("commands");
    expect(calls[0]?.body).not.toContain(phrase);
    expect(JSON.stringify(kit.reply.sent)).not.toContain("/help");
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
    const named = deps();
    const namedCalls: { method: string; body: string }[] = [];
    await handleIncomingEvent(
      await incoming({ text: "/delcommands private", direct: true }),
      {
        ...named,
        botToken: "bot-token",
        fetchImpl: async (input, init) => {
          const url = String(input);
          namedCalls.push({
            method: url.slice(url.lastIndexOf("/") + 1),
            body: String(init?.body ?? ""),
          });
          return new Response(JSON.stringify({ ok: true, result: true }), {
            status: 200,
          });
        },
      },
    );
    expect(JSON.parse(namedCalls[0]?.body ?? "null")).toEqual({
      scope: { type: "all_private_chats" },
    });
    const usage = deps();
    let used = false;
    await handleIncomingEvent(
      await incoming({ text: "/delcommands private extra", direct: true }),
      {
        ...usage,
        botToken: "bot-token",
        fetchImpl: async () => {
          used = true;
          return new Response(JSON.stringify({ ok: true, result: true }), {
            status: 200,
          });
        },
      },
    );
    expect(used).toBe(false);
    expect(usage.reply.sent.map((message) => message.text)).toEqual([
      "用法：/delcommands [private]",
    ]);
    const invalid = deps();
    let called = false;
    await handleIncomingEvent(
      await incoming({ text: `/delcommands ${phrase}`, direct: true }),
      {
        ...invalid,
        botToken: "bot-token",
        fetchImpl: async () => {
          called = true;
          return new Response(JSON.stringify({ ok: true, result: true }), {
            status: 200,
          });
        },
      },
    );
    expect(called).toBe(false);
    expect(invalid.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(invalid.reply.sent)).not.toContain(phrase);
    const offline = deps();
    await handleIncomingEvent(
      await incoming({ text: "/delcommands", direct: true }),
      offline,
    );
    expect(offline.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    const rejected = deps();
    await handleIncomingEvent(
      await incoming({ text: "/delcommands", direct: true }),
      {
        ...rejected,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: false, description: phrase }), {
            status: 400,
          }),
      },
    );
    expect(rejected.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain("bot-token");
  });

  it("sets the default menu button without a private chat", async () => {
    const kit = deps();
    const calls: { method: string; body: string }[] = [];
    await handleIncomingEvent(
      await incoming({ text: "/menubutton commands", direct: true }),
      {
        ...kit,
        botToken: "bot-token",
        fetchImpl: async (input, init) => {
          const url = String(input);
          calls.push({
            method: url.slice(url.lastIndexOf("/") + 1),
            body: String(init?.body ?? ""),
          });
          return new Response(JSON.stringify({ ok: true, result: true }), {
            status: 200,
          });
        },
      },
    );
    expect(kit.reply.sent.map((message) => message.text)).toEqual([
      "已请求把默认菜单按钮设成命令列表。某个私聊里单独设过的按钮不受影响。",
    ]);
    expect(calls.map((call) => call.method)).toEqual(["setChatMenuButton"]);
    expect(calls[0]?.method).not.toContain("getChatMenuButton");
    expect(JSON.parse(calls[0]?.body ?? "null")).toEqual({
      menu_button: { type: "commands" },
    });
    expect(calls[0]?.body).not.toContain("chat_id");
    expect(calls[0]?.body).not.toContain("web_app");
    expect(calls[0]?.body).not.toContain(phrase);
    const restored = deps();
    const restoredCalls: { method: string; body: string }[] = [];
    await handleIncomingEvent(
      await incoming({ text: "/menubutton default", direct: true }),
      {
        ...restored,
        botToken: "bot-token",
        fetchImpl: async (input, init) => {
          const url = String(input);
          restoredCalls.push({
            method: url.slice(url.lastIndexOf("/") + 1),
            body: String(init?.body ?? ""),
          });
          return new Response(JSON.stringify({ ok: true, result: true }), {
            status: 200,
          });
        },
      },
    );
    expect(restored.reply.sent.map((message) => message.text)).toEqual([
      "已请求把默认菜单按钮恢复成默认。某个私聊里单独设过的按钮不受影响。",
    ]);
    expect(JSON.parse(restoredCalls[0]?.body ?? "null")).toEqual({
      menu_button: { type: "default" },
    });
    expect(restoredCalls[0]?.body).not.toContain("chat_id");
    const usage = deps();
    let used = false;
    await handleIncomingEvent(
      await incoming({ text: "/menubutton", direct: true }),
      {
        ...usage,
        botToken: "bot-token",
        fetchImpl: async () => {
          used = true;
          return new Response(JSON.stringify({ ok: true, result: true }), {
            status: 200,
          });
        },
      },
    );
    expect(used).toBe(false);
    expect(usage.reply.sent.map((message) => message.text)).toEqual([
      "用法：/menubutton <commands|default>",
    ]);
    const invalid = deps();
    let called = false;
    await handleIncomingEvent(
      await incoming({ text: `/menubutton ${phrase}`, direct: true }),
      {
        ...invalid,
        botToken: "bot-token",
        fetchImpl: async () => {
          called = true;
          return new Response(JSON.stringify({ ok: true, result: true }), {
            status: 200,
          });
        },
      },
    );
    expect(called).toBe(false);
    expect(invalid.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(invalid.reply.sent)).not.toContain(phrase);
    const offline = deps();
    await handleIncomingEvent(
      await incoming({ text: "/menubutton commands", direct: true }),
      offline,
    );
    expect(offline.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    const rejected = deps();
    await handleIncomingEvent(
      await incoming({ text: "/menubutton default", direct: true }),
      {
        ...rejected,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: false, description: phrase }), {
            status: 400,
          }),
      },
    );
    expect(rejected.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain("bot-token");
  });

  it("reads the default menu button and drops the web app", async () => {
    const kit = deps();
    const calls: { method: string; body: string }[] = [];
    await handleIncomingEvent(
      await incoming({ text: "/button", direct: true }),
      {
        ...kit,
        botToken: "bot-token",
        fetchImpl: async (input, init) => {
          const url = String(input);
          calls.push({
            method: url.slice(url.lastIndexOf("/") + 1),
            body: String(init?.body ?? ""),
          });
          return new Response(
            JSON.stringify({
              ok: true,
              result: { type: "commands", note: phrase },
            }),
            { status: 200 },
          );
        },
      },
    );
    expect(kit.reply.sent.map((message) => message.text)).toEqual([
      "菜单按钮 命令",
    ]);
    expect(calls.map((call) => call.method)).toEqual(["getChatMenuButton"]);
    expect(calls[0]?.method).not.toContain("setChatMenuButton");
    expect("getChatMenuButton").not.toContain("setChatMenuButton");
    expect(JSON.parse(calls[0]?.body ?? "null")).toEqual({});
    expect(calls[0]?.body).not.toContain("chat_id");
    expect(calls[0]?.body).not.toContain(phrase);
    expect(JSON.stringify(kit.reply.sent)).not.toContain(phrase);
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
    const webApp = deps();
    await handleIncomingEvent(
      await incoming({ text: "/button", direct: true }),
      {
        ...webApp,
        botToken: "bot-token",
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
      },
    );
    expect(webApp.reply.sent.map((message) => message.text)).toEqual([
      "菜单按钮 应用",
    ]);
    expect(JSON.stringify(webApp.reply.sent)).not.toContain(phrase);
    expect(JSON.stringify(webApp.reply.sent)).not.toContain("https://");
    const unknown = deps();
    await handleIncomingEvent(
      await incoming({ text: "/button", direct: true }),
      {
        ...unknown,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: true, result: { type: "apps" } }), {
            status: 200,
          }),
      },
    );
    expect(unknown.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(unknown.reply.sent)).not.toContain("菜单按钮");
    const empty = deps();
    await handleIncomingEvent(
      await incoming({ text: "/button", direct: true }),
      {
        ...empty,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: true, result: null }), {
            status: 200,
          }),
      },
    );
    expect(empty.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    const offline = deps();
    await handleIncomingEvent(
      await incoming({ text: "/button", direct: true }),
      offline,
    );
    expect(offline.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    const rejected = deps();
    await handleIncomingEvent(
      await incoming({ text: "/button", direct: true }),
      {
        ...rejected,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: false, description: phrase }), {
            status: 400,
          }),
      },
    );
    expect(rejected.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain("bot-token");
  });

  it("sets the bot name without a language", async () => {
    const kit = deps();
    const calls: { method: string; body: string }[] = [];
    await handleIncomingEvent(
      await incoming({ text: `/botname ${phrase}`, direct: true }),
      {
        ...kit,
        botToken: "bot-token",
        fetchImpl: async (input, init) => {
          const url = String(input);
          calls.push({
            method: url.slice(url.lastIndexOf("/") + 1),
            body: String(init?.body ?? ""),
          });
          return new Response(JSON.stringify({ ok: true, result: true }), {
            status: 200,
          });
        },
      },
    );
    expect(kit.reply.sent.map((message) => message.text)).toEqual([
      "已请求设置这个 bot 的名字。已有单独语言名字的人不受影响。",
    ]);
    expect(calls.map((call) => call.method)).toEqual(["setMyName"]);
    expect(calls[0]?.method).not.toContain("getMyName");
    expect("setMyName").not.toContain("getMyName");
    expect(JSON.parse(calls[0]?.body ?? "null")).toEqual({ name: phrase });
    expect(calls[0]?.body).not.toContain("language_code");
    expect(JSON.stringify(kit.reply.sent)).not.toContain(phrase);
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
    const cleared = deps();
    const clearedCalls: { method: string; body: string }[] = [];
    await handleIncomingEvent(
      await incoming({ text: "/botname", direct: true }),
      {
        ...cleared,
        botToken: "bot-token",
        fetchImpl: async (input, init) => {
          const url = String(input);
          clearedCalls.push({
            method: url.slice(url.lastIndexOf("/") + 1),
            body: String(init?.body ?? ""),
          });
          return new Response(JSON.stringify({ ok: true, result: true }), {
            status: 200,
          });
        },
      },
    );
    expect(cleared.reply.sent.map((message) => message.text)).toEqual([
      "已请求清掉这个 bot 的默认名字。已有单独语言名字的人不受影响。",
    ]);
    expect(JSON.parse(clearedCalls[0]?.body ?? "null")).toEqual({ name: "" });
    expect(clearedCalls[0]?.body).not.toContain("language_code");
    const exact = deps();
    const exactCalls: { body: string }[] = [];
    const exactName = "y".repeat(64);
    await handleIncomingEvent(
      await incoming({ text: `/botname ${exactName}`, direct: true }),
      {
        ...exact,
        botToken: "bot-token",
        fetchImpl: async (_input, init) => {
          exactCalls.push({ body: String(init?.body ?? "") });
          return new Response(JSON.stringify({ ok: true, result: true }), {
            status: 200,
          });
        },
      },
    );
    expect(JSON.parse(exactCalls[0]?.body ?? "null")).toEqual({
      name: exactName,
    });
    const invalid = deps();
    let called = false;
    await handleIncomingEvent(
      await incoming({
        text: `/botname ${phrase}${"x".repeat(64)}`,
        direct: true,
      }),
      {
        ...invalid,
        botToken: "bot-token",
        fetchImpl: async () => {
          called = true;
          return new Response(JSON.stringify({ ok: true, result: true }), {
            status: 200,
          });
        },
      },
    );
    expect(called).toBe(false);
    expect(invalid.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(invalid.reply.sent)).not.toContain(phrase);
    const offline = deps();
    await handleIncomingEvent(
      await incoming({ text: `/botname ${phrase}`, direct: true }),
      offline,
    );
    expect(offline.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    const rejected = deps();
    await handleIncomingEvent(
      await incoming({ text: `/botname ${phrase}`, direct: true }),
      {
        ...rejected,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: false, description: phrase }), {
            status: 400,
          }),
      },
    );
    expect(rejected.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain("bot-token");
  });

  it("reads the default bot name and keeps it out of the logs", async () => {
    const kit = deps();
    const calls: { method: string; body: string }[] = [];
    await handleIncomingEvent(
      await incoming({ text: "/myname", direct: true }),
      {
        ...kit,
        botToken: "bot-token",
        fetchImpl: async (input, init) => {
          const url = String(input);
          calls.push({
            method: url.slice(url.lastIndexOf("/") + 1),
            body: String(init?.body ?? ""),
          });
          return new Response(
            JSON.stringify({
              ok: true,
              result: { name: phrase, note: "kept" },
            }),
            { status: 200 },
          );
        },
      },
    );
    expect(kit.reply.sent.map((message) => message.text)).toEqual([
      `名字 ${phrase}`,
    ]);
    expect(calls.map((call) => call.method)).toEqual(["getMyName"]);
    expect(calls[0]?.method).not.toContain("setMyName");
    expect("getMyName").not.toContain("setMyName");
    expect(JSON.parse(calls[0]?.body ?? "null")).toEqual({});
    expect(calls[0]?.body).not.toContain("language_code");
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
    const cleared = deps();
    await handleIncomingEvent(
      await incoming({ text: "/myname", direct: true }),
      {
        ...cleared,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: true, result: { name: "" } }), {
            status: 200,
          }),
      },
    );
    expect(cleared.reply.sent.map((message) => message.text)).toEqual([
      "名字 空",
    ]);
    const broken = deps();
    await handleIncomingEvent(
      await incoming({ text: "/myname", direct: true }),
      {
        ...broken,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              ok: true,
              result: { name: `${phrase}\nsecret` },
            }),
            { status: 200 },
          ),
      },
    );
    expect(broken.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(broken.reply.sent)).not.toContain(phrase);
    const empty = deps();
    await handleIncomingEvent(
      await incoming({ text: "/myname", direct: true }),
      {
        ...empty,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: true, result: null }), {
            status: 200,
          }),
      },
    );
    expect(empty.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    const offline = deps();
    await handleIncomingEvent(
      await incoming({ text: "/myname", direct: true }),
      offline,
    );
    expect(offline.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    const rejected = deps();
    await handleIncomingEvent(
      await incoming({ text: "/myname", direct: true }),
      {
        ...rejected,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: false, description: phrase }), {
            status: 400,
          }),
      },
    );
    expect(rejected.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain("bot-token");
  });

  it("sets the bot description without a language", async () => {
    const kit = deps();
    const calls: { method: string; body: string }[] = [];
    await handleIncomingEvent(
      await incoming({ text: `/botdesc ${phrase}`, direct: true }),
      {
        ...kit,
        botToken: "bot-token",
        fetchImpl: async (input, init) => {
          const url = String(input);
          calls.push({
            method: url.slice(url.lastIndexOf("/") + 1),
            body: String(init?.body ?? ""),
          });
          return new Response(JSON.stringify({ ok: true, result: true }), {
            status: 200,
          });
        },
      },
    );
    expect(kit.reply.sent.map((message) => message.text)).toEqual([
      "已请求设置这个 bot 的简介。已有单独语言简介的人不受影响。",
    ]);
    expect(calls.map((call) => call.method)).toEqual(["setMyDescription"]);
    expect(calls[0]?.method).not.toContain("getMyDescription");
    expect("setMyDescription").not.toContain("getMyDescription");
    expect(JSON.parse(calls[0]?.body ?? "null")).toEqual({
      description: phrase,
    });
    expect(calls[0]?.body).not.toContain("language_code");
    expect(JSON.stringify(kit.reply.sent)).not.toContain(phrase);
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
    const cleared = deps();
    const clearedCalls: { body: string }[] = [];
    await handleIncomingEvent(
      await incoming({ text: "/botdesc", direct: true }),
      {
        ...cleared,
        botToken: "bot-token",
        fetchImpl: async (_input, init) => {
          clearedCalls.push({ body: String(init?.body ?? "") });
          return new Response(JSON.stringify({ ok: true, result: true }), {
            status: 200,
          });
        },
      },
    );
    expect(cleared.reply.sent.map((message) => message.text)).toEqual([
      "已请求清掉这个 bot 的默认简介。已有单独语言简介的人不受影响。",
    ]);
    expect(JSON.parse(clearedCalls[0]?.body ?? "null")).toEqual({
      description: "",
    });
    const exact = deps();
    const exactCalls: { body: string }[] = [];
    const exactDescription = "y".repeat(512);
    await handleIncomingEvent(
      await incoming({ text: `/botdesc ${exactDescription}`, direct: true }),
      {
        ...exact,
        botToken: "bot-token",
        fetchImpl: async (_input, init) => {
          exactCalls.push({ body: String(init?.body ?? "") });
          return new Response(JSON.stringify({ ok: true, result: true }), {
            status: 200,
          });
        },
      },
    );
    expect(JSON.parse(exactCalls[0]?.body ?? "null")).toEqual({
      description: exactDescription,
    });
    const invalid = deps();
    let called = false;
    await handleIncomingEvent(
      await incoming({
        text: `/botdesc ${phrase}${"x".repeat(512)}`,
        direct: true,
      }),
      {
        ...invalid,
        botToken: "bot-token",
        fetchImpl: async () => {
          called = true;
          return new Response(JSON.stringify({ ok: true, result: true }), {
            status: 200,
          });
        },
      },
    );
    expect(called).toBe(false);
    expect(invalid.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(invalid.reply.sent)).not.toContain(phrase);
    const offline = deps();
    await handleIncomingEvent(
      await incoming({ text: `/botdesc ${phrase}`, direct: true }),
      offline,
    );
    expect(offline.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    const rejected = deps();
    await handleIncomingEvent(
      await incoming({ text: `/botdesc ${phrase}`, direct: true }),
      {
        ...rejected,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: false, description: phrase }), {
            status: 400,
          }),
      },
    );
    expect(rejected.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain("bot-token");
  });

  it("reads the default bot description and keeps it out of the logs", async () => {
    const kit = deps();
    const calls: { method: string; body: string }[] = [];
    await handleIncomingEvent(
      await incoming({ text: "/mydesc", direct: true }),
      {
        ...kit,
        botToken: "bot-token",
        fetchImpl: async (input, init) => {
          const url = String(input);
          calls.push({
            method: url.slice(url.lastIndexOf("/") + 1),
            body: String(init?.body ?? ""),
          });
          return new Response(
            JSON.stringify({
              ok: true,
              result: { description: phrase, note: "kept" },
            }),
            { status: 200 },
          );
        },
      },
    );
    expect(kit.reply.sent.map((message) => message.text)).toEqual([
      `简介 ${phrase}`,
    ]);
    expect(calls.map((call) => call.method)).toEqual(["getMyDescription"]);
    expect(calls[0]?.method).not.toContain("setMyDescription");
    expect("getMyDescription").not.toContain("setMyDescription");
    expect(JSON.parse(calls[0]?.body ?? "null")).toEqual({});
    expect(calls[0]?.body).not.toContain("language_code");
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
    const cleared = deps();
    await handleIncomingEvent(
      await incoming({ text: "/mydesc", direct: true }),
      {
        ...cleared,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(
            JSON.stringify({ ok: true, result: { description: "" } }),
            { status: 200 },
          ),
      },
    );
    expect(cleared.reply.sent.map((message) => message.text)).toEqual([
      "简介 空",
    ]);
    const broken = deps();
    await handleIncomingEvent(
      await incoming({ text: "/mydesc", direct: true }),
      {
        ...broken,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              ok: true,
              result: { description: `${phrase}\nsecret` },
            }),
            { status: 200 },
          ),
      },
    );
    expect(broken.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(broken.reply.sent)).not.toContain(phrase);
    const empty = deps();
    await handleIncomingEvent(
      await incoming({ text: "/mydesc", direct: true }),
      {
        ...empty,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: true, result: null }), {
            status: 200,
          }),
      },
    );
    expect(empty.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    const offline = deps();
    await handleIncomingEvent(
      await incoming({ text: "/mydesc", direct: true }),
      offline,
    );
    expect(offline.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    const rejected = deps();
    await handleIncomingEvent(
      await incoming({ text: "/mydesc", direct: true }),
      {
        ...rejected,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: false, description: phrase }), {
            status: 400,
          }),
      },
    );
    expect(rejected.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain("bot-token");
  });

  it("sets the bot short description without a language", async () => {
    const kit = deps();
    const calls: { method: string; body: string }[] = [];
    await handleIncomingEvent(
      await incoming({ text: `/botshort ${phrase}`, direct: true }),
      {
        ...kit,
        botToken: "bot-token",
        fetchImpl: async (input, init) => {
          const url = String(input);
          calls.push({
            method: url.slice(url.lastIndexOf("/") + 1),
            body: String(init?.body ?? ""),
          });
          return new Response(JSON.stringify({ ok: true, result: true }), {
            status: 200,
          });
        },
      },
    );
    expect(kit.reply.sent.map((message) => message.text)).toEqual([
      "已请求设置这个 bot 的短简介。已有单独语言短简介的人不受影响。",
    ]);
    expect(calls.map((call) => call.method)).toEqual(["setMyShortDescription"]);
    expect(calls[0]?.method).not.toContain("getMyShortDescription");
    expect("setMyShortDescription").not.toContain("getMyShortDescription");
    expect(JSON.parse(calls[0]?.body ?? "null")).toEqual({
      short_description: phrase,
    });
    expect(calls[0]?.body).not.toContain("language_code");
    expect(JSON.stringify(kit.reply.sent)).not.toContain(phrase);
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
    const cleared = deps();
    const clearedCalls: { body: string }[] = [];
    await handleIncomingEvent(
      await incoming({ text: "/botshort", direct: true }),
      {
        ...cleared,
        botToken: "bot-token",
        fetchImpl: async (_input, init) => {
          clearedCalls.push({ body: String(init?.body ?? "") });
          return new Response(JSON.stringify({ ok: true, result: true }), {
            status: 200,
          });
        },
      },
    );
    expect(cleared.reply.sent.map((message) => message.text)).toEqual([
      "已请求清掉这个 bot 的默认短简介。已有单独语言短简介的人不受影响。",
    ]);
    expect(JSON.parse(clearedCalls[0]?.body ?? "null")).toEqual({
      short_description: "",
    });
    const exact = deps();
    const exactCalls: { body: string }[] = [];
    const exactShort = "y".repeat(120);
    await handleIncomingEvent(
      await incoming({ text: `/botshort ${exactShort}`, direct: true }),
      {
        ...exact,
        botToken: "bot-token",
        fetchImpl: async (_input, init) => {
          exactCalls.push({ body: String(init?.body ?? "") });
          return new Response(JSON.stringify({ ok: true, result: true }), {
            status: 200,
          });
        },
      },
    );
    expect(JSON.parse(exactCalls[0]?.body ?? "null")).toEqual({
      short_description: exactShort,
    });
    const invalid = deps();
    let called = false;
    await handleIncomingEvent(
      await incoming({
        text: `/botshort ${phrase}${"x".repeat(120)}`,
        direct: true,
      }),
      {
        ...invalid,
        botToken: "bot-token",
        fetchImpl: async () => {
          called = true;
          return new Response(JSON.stringify({ ok: true, result: true }), {
            status: 200,
          });
        },
      },
    );
    expect(called).toBe(false);
    expect(invalid.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(invalid.reply.sent)).not.toContain(phrase);
    const offline = deps();
    await handleIncomingEvent(
      await incoming({ text: `/botshort ${phrase}`, direct: true }),
      offline,
    );
    expect(offline.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    const rejected = deps();
    await handleIncomingEvent(
      await incoming({ text: `/botshort ${phrase}`, direct: true }),
      {
        ...rejected,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: false, description: phrase }), {
            status: 400,
          }),
      },
    );
    expect(rejected.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain("bot-token");
  });

  it("reads the default bot short description and keeps it out of the logs", async () => {
    const kit = deps();
    const calls: { method: string; body: string }[] = [];
    await handleIncomingEvent(
      await incoming({ text: "/myshort", direct: true }),
      {
        ...kit,
        botToken: "bot-token",
        fetchImpl: async (input, init) => {
          const url = String(input);
          calls.push({
            method: url.slice(url.lastIndexOf("/") + 1),
            body: String(init?.body ?? ""),
          });
          return new Response(
            JSON.stringify({
              ok: true,
              result: { short_description: phrase, note: "kept" },
            }),
            { status: 200 },
          );
        },
      },
    );
    expect(kit.reply.sent.map((message) => message.text)).toEqual([
      `短简介 ${phrase}`,
    ]);
    expect(calls.map((call) => call.method)).toEqual(["getMyShortDescription"]);
    expect(calls[0]?.method).not.toContain("setMyShortDescription");
    expect("getMyShortDescription").not.toContain("setMyShortDescription");
    expect(JSON.parse(calls[0]?.body ?? "null")).toEqual({});
    expect(calls[0]?.body).not.toContain("language_code");
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
    const cleared = deps();
    await handleIncomingEvent(
      await incoming({ text: "/myshort", direct: true }),
      {
        ...cleared,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              ok: true,
              result: { short_description: "" },
            }),
            { status: 200 },
          ),
      },
    );
    expect(cleared.reply.sent.map((message) => message.text)).toEqual([
      "短简介 空",
    ]);
    const broken = deps();
    await handleIncomingEvent(
      await incoming({ text: "/myshort", direct: true }),
      {
        ...broken,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              ok: true,
              result: { short_description: `${phrase}\nsecret` },
            }),
            { status: 200 },
          ),
      },
    );
    expect(broken.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(broken.reply.sent)).not.toContain(phrase);
    const empty = deps();
    await handleIncomingEvent(
      await incoming({ text: "/myshort", direct: true }),
      {
        ...empty,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: true, result: null }), {
            status: 200,
          }),
      },
    );
    expect(empty.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    const offline = deps();
    await handleIncomingEvent(
      await incoming({ text: "/myshort", direct: true }),
      offline,
    );
    expect(offline.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    const rejected = deps();
    await handleIncomingEvent(
      await incoming({ text: "/myshort", direct: true }),
      {
        ...rejected,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: false, description: phrase }), {
            status: 400,
          }),
      },
    );
    expect(rejected.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain("bot-token");
  });

  it("reads the bot identity and drops the display name", async () => {
    const kit = deps();
    const calls: { method: string; body: string }[] = [];
    await handleIncomingEvent(await incoming({ text: "/who", direct: true }), {
      ...kit,
      botToken: "bot-token",
      fetchImpl: async (input, init) => {
        const url = String(input);
        calls.push({
          method: url.slice(url.lastIndexOf("/") + 1),
          body: String(init?.body ?? ""),
        });
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              id: 42,
              is_bot: true,
              first_name: phrase,
              username: "giftbot",
              can_join_groups: true,
              can_read_all_group_messages: false,
              supports_guest_queries: true,
              supports_join_request_queries: false,
              note: phrase,
            },
          }),
          { status: 200 },
        );
      },
    });
    expect(kit.reply.sent.map((message) => message.text)).toEqual([
      [
        "机器人 42",
        "用户名 giftbot",
        "入群 on",
        "群消息 off",
        "访客 on",
        "入群查询 off",
      ].join("\n"),
    ]);
    expect(calls.map((call) => call.method)).toEqual(["getMe"]);
    expect(calls[0]?.method).not.toContain("logOut");
    expect(calls[0]?.method).not.toContain("close");
    expect("getMe").not.toContain("logOut");
    expect(JSON.parse(calls[0]?.body ?? "null")).toEqual({});
    expect(JSON.stringify(kit.reply.sent)).not.toContain(phrase);
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(kit.logger.entries)).not.toContain("giftbot");
    const cleared = deps();
    await handleIncomingEvent(await incoming({ text: "/who", direct: true }), {
      ...cleared,
      botToken: "bot-token",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            ok: true,
            result: { id: 7, is_bot: true },
          }),
          { status: 200 },
        ),
    });
    expect(cleared.reply.sent.map((message) => message.text)).toEqual([
      [
        "机器人 7",
        "用户名 空",
        "入群 未知",
        "群消息 未知",
        "访客 未知",
        "入群查询 未知",
      ].join("\n"),
    ]);
    const flagged = deps();
    await handleIncomingEvent(await incoming({ text: "/who", direct: true }), {
      ...flagged,
      botToken: "bot-token",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            ok: true,
            result: {
              id: 42,
              is_bot: true,
              first_name: phrase,
              supports_guest_queries: "yes",
            },
          }),
          { status: 200 },
        ),
    });
    expect(flagged.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(flagged.reply.sent)).not.toContain(phrase);
    const broken = deps();
    await handleIncomingEvent(await incoming({ text: "/who", direct: true }), {
      ...broken,
      botToken: "bot-token",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            ok: true,
            result: {
              id: 42,
              is_bot: false,
              first_name: phrase,
              username: "giftbot",
            },
          }),
          { status: 200 },
        ),
    });
    expect(broken.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(broken.reply.sent)).not.toContain(phrase);
    expect(JSON.stringify(broken.reply.sent)).not.toContain("giftbot");
    const empty = deps();
    await handleIncomingEvent(await incoming({ text: "/who", direct: true }), {
      ...empty,
      botToken: "bot-token",
      fetchImpl: async () =>
        new Response(JSON.stringify({ ok: true, result: null }), {
          status: 200,
        }),
    });
    expect(empty.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    const offline = deps();
    await handleIncomingEvent(
      await incoming({ text: "/who", direct: true }),
      offline,
    );
    expect(offline.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    const rejected = deps();
    await handleIncomingEvent(await incoming({ text: "/who", direct: true }), {
      ...rejected,
      botToken: "bot-token",
      fetchImpl: async () =>
        new Response(JSON.stringify({ ok: false, description: phrase }), {
          status: 400,
        }),
    });
    expect(rejected.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain("bot-token");
  });

  it("reads the webhook backlog and drops the address", async () => {
    const kit = deps();
    const calls: { method: string; body: string }[] = [];
    const address = `https://example.invalid/${phrase}`;
    await handleIncomingEvent(await incoming({ text: "/hook", direct: true }), {
      ...kit,
      botToken: "bot-token",
      fetchImpl: async (input, init) => {
        const url = String(input);
        calls.push({
          method: url.slice(url.lastIndexOf("/") + 1),
          body: String(init?.body ?? ""),
        });
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              url: address,
              has_custom_certificate: false,
              pending_update_count: 3,
              ip_address: "203.0.113.1",
              last_error_date: 1700000000,
              last_error_message: phrase,
              max_connections: 40,
              allowed_updates: ["message"],
            },
          }),
          { status: 200 },
        );
      },
    });
    expect(kit.reply.sent.map((message) => message.text)).toEqual([
      ["待投递 3", "证书 off", "连接 40", "上次错误 1700000000"].join("\n"),
    ]);
    expect(calls.map((call) => call.method)).toEqual(["getWebhookInfo"]);
    expect(calls[0]?.method).not.toContain("setWebhook");
    expect(calls[0]?.method).not.toContain("deleteWebhook");
    expect("getWebhookInfo").not.toContain("setWebhook");
    expect(JSON.parse(calls[0]?.body ?? "null")).toEqual({});
    expect(JSON.stringify(kit.reply.sent)).not.toContain(phrase);
    expect(JSON.stringify(kit.reply.sent)).not.toContain(address);
    expect(JSON.stringify(kit.reply.sent)).not.toContain("example.invalid");
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(kit.logger.entries)).not.toContain(address);
    expect(JSON.stringify(kit.logger.entries)).not.toContain("example.invalid");
    const cleared = deps();
    await handleIncomingEvent(await incoming({ text: "/hook", direct: true }), {
      ...cleared,
      botToken: "bot-token",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            ok: true,
            result: { url: "", pending_update_count: 0 },
          }),
          { status: 200 },
        ),
    });
    expect(cleared.reply.sent.map((message) => message.text)).toEqual([
      ["待投递 0", "证书 未知", "连接 未知", "上次错误 未知"].join("\n"),
    ]);
    const broken = deps();
    await handleIncomingEvent(await incoming({ text: "/hook", direct: true }), {
      ...broken,
      botToken: "bot-token",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            ok: true,
            result: {
              url: address,
              pending_update_count: -1,
              last_error_message: phrase,
            },
          }),
          { status: 200 },
        ),
    });
    expect(broken.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(broken.reply.sent)).not.toContain(phrase);
    expect(JSON.stringify(broken.reply.sent)).not.toContain(address);
    const wide = deps();
    await handleIncomingEvent(await incoming({ text: "/hook", direct: true }), {
      ...wide,
      botToken: "bot-token",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            ok: true,
            result: {
              url: address,
              pending_update_count: 1.5,
              max_connections: 101,
              last_error_date: 1.5,
              last_error_message: phrase,
            },
          }),
          { status: 200 },
        ),
    });
    expect(wide.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(wide.reply.sent)).not.toContain("example.invalid");
    const zero = deps();
    await handleIncomingEvent(await incoming({ text: "/hook", direct: true }), {
      ...zero,
      botToken: "bot-token",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            ok: true,
            result: {
              pending_update_count: 0,
              max_connections: 0,
            },
          }),
          { status: 200 },
        ),
    });
    expect(zero.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    const empty = deps();
    await handleIncomingEvent(await incoming({ text: "/hook", direct: true }), {
      ...empty,
      botToken: "bot-token",
      fetchImpl: async () =>
        new Response(JSON.stringify({ ok: true, result: null }), {
          status: 200,
        }),
    });
    expect(empty.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    const offline = deps();
    await handleIncomingEvent(
      await incoming({ text: "/hook", direct: true }),
      offline,
    );
    expect(offline.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    const rejected = deps();
    await handleIncomingEvent(await incoming({ text: "/hook", direct: true }), {
      ...rejected,
      botToken: "bot-token",
      fetchImpl: async () =>
        new Response(JSON.stringify({ ok: false, description: phrase }), {
          status: 400,
        }),
    });
    expect(rejected.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain("bot-token");
  });

  it("reads the chat guard posture and drops the title", async () => {
    const kit = deps();
    const calls: { method: string; body: string }[] = [];
    const invite = `https://t.me/+${phrase}`;
    await handleIncomingEvent(
      await incoming({ text: "/guard -100", direct: true }),
      {
        ...kit,
        botToken: "bot-token",
        fetchImpl: async (input, init) => {
          const url = String(input);
          calls.push({
            method: url.slice(url.lastIndexOf("/") + 1),
            body: String(init?.body ?? ""),
          });
          return new Response(
            JSON.stringify({
              ok: true,
              result: {
                id: -100,
                type: "supergroup",
                title: phrase,
                username: "giftchat",
                description: phrase,
                invite_link: invite,
                bio: phrase,
                is_forum: true,
                is_direct_messages: false,
                join_by_request: true,
                join_to_send_messages: false,
                has_aggressive_anti_spam_enabled: true,
                slow_mode_delay: 30,
                message_auto_delete_time: 86400,
                unrestrict_boost_count: 2,
                has_protected_content: true,
                has_hidden_members: false,
                has_visible_history: true,
                max_reaction_count: 11,
                linked_chat_id: -100777,
                sticker_set_name: phrase,
                permissions: { can_send_messages: true },
              },
            }),
            { status: 200 },
          );
        },
      },
    );
    expect(kit.reply.sent.map((message) => message.text)).toEqual([
      [
        "群 -100",
        "类型 超级群",
        "话题 on",
        "频道私聊 off",
        "审核入群 on",
        "入群发言 off",
        "官方反垃圾 on",
        "慢速 30",
        "自毁 86400",
        "加速豁免 2",
        "防转发 on",
        "隐藏成员 off",
        "可见历史 on",
        "反应 11",
        "关联 -100777",
      ].join("\n"),
    ]);
    expect(calls.map((call) => call.method)).toEqual(["getChat"]);
    expect(calls[0]?.method).not.toContain("setChatPermissions");
    expect(calls[0]?.method).not.toContain("setChatTitle");
    expect("getChat").not.toContain("setChatTitle");
    expect(JSON.parse(calls[0]?.body ?? "null")).toEqual({ chat_id: -100 });
    expect(JSON.stringify(kit.reply.sent)).not.toContain(phrase);
    expect(JSON.stringify(kit.reply.sent)).not.toContain(invite);
    expect(JSON.stringify(kit.reply.sent)).not.toContain("giftchat");
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(kit.logger.entries)).not.toContain(invite);
    expect(JSON.stringify(kit.logger.entries)).not.toContain("giftchat");
    const cleared = deps();
    await handleIncomingEvent(
      await incoming({ text: "/guard -100", direct: true }),
      {
        ...cleared,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              ok: true,
              result: {
                id: -100,
                type: "group",
                title: phrase,
                max_reaction_count: 0,
              },
            }),
            { status: 200 },
          ),
      },
    );
    expect(cleared.reply.sent.map((message) => message.text)).toEqual([
      [
        "群 -100",
        "类型 群",
        "话题 未知",
        "频道私聊 未知",
        "审核入群 未知",
        "入群发言 未知",
        "官方反垃圾 未知",
        "慢速 未知",
        "自毁 未知",
        "加速豁免 未知",
        "防转发 未知",
        "隐藏成员 未知",
        "可见历史 未知",
        "反应 0",
        "关联 未知",
      ].join("\n"),
    ]);
    expect(JSON.stringify(cleared.reply.sent)).not.toContain(phrase);
    const zero = deps();
    await handleIncomingEvent(
      await incoming({ text: "/guard 42", direct: true }),
      {
        ...zero,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              ok: true,
              result: {
                id: 42,
                type: "private",
                first_name: phrase,
                max_reaction_count: 1,
                slow_mode_delay: 0,
                message_auto_delete_time: 0,
                unrestrict_boost_count: 0,
              },
            }),
            { status: 200 },
          ),
      },
    );
    const zeroText = zero.reply.sent.map((message) => message.text).join("\n");
    expect(zeroText).toContain("群 42\n类型 私聊\n");
    expect(zeroText).toContain("慢速 0\n自毁 0\n加速豁免 0\n");
    expect(zeroText).toContain("\n反应 1\n");
    expect(JSON.stringify(zero.reply.sent)).not.toContain(phrase);
    const broken = deps();
    await handleIncomingEvent(
      await incoming({ text: "/guard -100", direct: true }),
      {
        ...broken,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              ok: true,
              result: {
                id: -100,
                type: phrase,
                title: phrase,
                max_reaction_count: 1,
              },
            }),
            { status: 200 },
          ),
      },
    );
    expect(broken.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(broken.reply.sent)).not.toContain(phrase);
    const wide = deps();
    await handleIncomingEvent(
      await incoming({ text: "/guard -100", direct: true }),
      {
        ...wide,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              ok: true,
              result: {
                id: -200,
                type: "supergroup",
                title: phrase,
                invite_link: invite,
                slow_mode_delay: -1,
                max_reaction_count: 1.5,
              },
            }),
            { status: 200 },
          ),
      },
    );
    expect(wide.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(wide.reply.sent)).not.toContain(phrase);
    expect(JSON.stringify(wide.reply.sent)).not.toContain(invite);
    const empty = deps();
    await handleIncomingEvent(
      await incoming({ text: "/guard -100", direct: true }),
      {
        ...empty,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: true, result: null }), {
            status: 200,
          }),
      },
    );
    expect(empty.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    const offline = deps();
    await handleIncomingEvent(
      await incoming({ text: "/guard -100", direct: true }),
      offline,
    );
    expect(offline.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    const rejected = deps();
    await handleIncomingEvent(
      await incoming({ text: "/guard -100", direct: true }),
      {
        ...rejected,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: false, description: phrase }), {
            status: 400,
          }),
      },
    );
    expect(rejected.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain("bot-token");
  });

  it("reads the join-request bot and drops the display name", async () => {
    const kit = deps();
    const calls: { method: string; body: string }[] = [];
    const invite = `https://t.me/+${phrase}`;
    await handleIncomingEvent(
      await incoming({ text: "/joinbot -100", direct: true }),
      {
        ...kit,
        botToken: "bot-token",
        fetchImpl: async (input, init) => {
          const url = String(input);
          calls.push({
            method: url.slice(url.lastIndexOf("/") + 1),
            body: String(init?.body ?? ""),
          });
          return new Response(
            JSON.stringify({
              ok: true,
              result: {
                id: -100,
                type: "supergroup",
                title: phrase,
                invite_link: invite,
                guard_bot: {
                  id: 4242,
                  is_bot: true,
                  first_name: phrase,
                  username: "giftbot",
                },
              },
            }),
            { status: 200 },
          );
        },
      },
    );
    expect(kit.reply.sent.map((message) => message.text)).toEqual([
      ["群 -100", "机器人 4242", "用户名 giftbot"].join("\n"),
    ]);
    expect(calls.map((call) => call.method)).toEqual(["getChat"]);
    expect(calls[0]?.method).not.toContain("setChatPermissions");
    expect("getChat").not.toContain("setChatTitle");
    expect(JSON.parse(calls[0]?.body ?? "null")).toEqual({ chat_id: -100 });
    expect(JSON.stringify(kit.reply.sent)).toContain("giftbot");
    expect(JSON.stringify(kit.reply.sent)).not.toContain(phrase);
    expect(JSON.stringify(kit.reply.sent)).not.toContain(invite);
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(kit.logger.entries)).not.toContain("giftbot");
    expect(JSON.stringify(kit.logger.entries)).not.toContain(invite);
    const cleared = deps();
    await handleIncomingEvent(
      await incoming({ text: "/joinbot -100", direct: true }),
      {
        ...cleared,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              ok: true,
              result: { id: -100, type: "group", title: phrase },
            }),
            { status: 200 },
          ),
      },
    );
    expect(cleared.reply.sent.map((message) => message.text)).toEqual([
      ["群 -100", "机器人 未知", "用户名 未知"].join("\n"),
    ]);
    expect(JSON.stringify(cleared.reply.sent)).not.toContain(phrase);
    const blank = deps();
    await handleIncomingEvent(
      await incoming({ text: "/joinbot -100", direct: true }),
      {
        ...blank,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              ok: true,
              result: {
                id: -100,
                type: "supergroup",
                guard_bot: { id: 7, is_bot: true, first_name: phrase },
              },
            }),
            { status: 200 },
          ),
      },
    );
    expect(blank.reply.sent.map((message) => message.text)).toEqual([
      ["群 -100", "机器人 7", "用户名 空"].join("\n"),
    ]);
    expect(JSON.stringify(blank.reply.sent)).not.toContain(phrase);
    const broken = deps();
    await handleIncomingEvent(
      await incoming({ text: "/joinbot -100", direct: true }),
      {
        ...broken,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              ok: true,
              result: {
                id: -100,
                title: phrase,
                guard_bot: { id: 4242, is_bot: false, first_name: phrase },
              },
            }),
            { status: 200 },
          ),
      },
    );
    expect(broken.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(broken.reply.sent)).not.toContain(phrase);
    const wide = deps();
    await handleIncomingEvent(
      await incoming({ text: "/joinbot -100", direct: true }),
      {
        ...wide,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              ok: true,
              result: {
                id: -200,
                title: phrase,
                invite_link: invite,
                guard_bot: {
                  id: 4242,
                  is_bot: true,
                  username: phrase,
                  first_name: phrase,
                },
              },
            }),
            { status: 200 },
          ),
      },
    );
    expect(wide.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(wide.reply.sent)).not.toContain(phrase);
    expect(JSON.stringify(wide.reply.sent)).not.toContain(invite);
    const empty = deps();
    await handleIncomingEvent(
      await incoming({ text: "/joinbot -100", direct: true }),
      {
        ...empty,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: true, result: null }), {
            status: 200,
          }),
      },
    );
    expect(empty.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    const offline = deps();
    await handleIncomingEvent(
      await incoming({ text: "/joinbot -100", direct: true }),
      offline,
    );
    expect(offline.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    const rejected = deps();
    await handleIncomingEvent(
      await incoming({ text: "/joinbot -100", direct: true }),
      {
        ...rejected,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: false, description: phrase }), {
            status: 400,
          }),
      },
    );
    expect(rejected.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain("bot-token");
  });

  it("reads the allowed reactions and drops the emoji", async () => {
    const kit = deps();
    const calls: { method: string; body: string }[] = [];
    const invite = `https://t.me/+${phrase}`;
    const customId = "5368324170676423940";
    await handleIncomingEvent(
      await incoming({ text: "/reactions -100", direct: true }),
      {
        ...kit,
        botToken: "bot-token",
        fetchImpl: async (input, init) => {
          const url = String(input);
          calls.push({
            method: url.slice(url.lastIndexOf("/") + 1),
            body: String(init?.body ?? ""),
          });
          return new Response(
            JSON.stringify({
              ok: true,
              result: {
                id: -100,
                type: "supergroup",
                title: phrase,
                invite_link: invite,
                available_reactions: [
                  { type: "emoji", emoji: phrase },
                  { type: "custom_emoji", custom_emoji_id: customId },
                  { type: "paid" },
                ],
              },
            }),
            { status: 200 },
          );
        },
      },
    );
    expect(kit.reply.sent.map((message) => message.text)).toEqual([
      ["群 -100", "反应 3"].join("\n"),
    ]);
    expect(calls.map((call) => call.method)).toEqual(["getChat"]);
    expect(calls[0]?.method).not.toContain("setMessageReaction");
    expect("getChat").not.toContain("setMessageReaction");
    expect(JSON.parse(calls[0]?.body ?? "null")).toEqual({ chat_id: -100 });
    expect(JSON.stringify(kit.reply.sent)).not.toContain(phrase);
    expect(JSON.stringify(kit.reply.sent)).not.toContain(customId);
    expect(JSON.stringify(kit.reply.sent)).not.toContain(invite);
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(kit.logger.entries)).not.toContain(customId);
    expect(JSON.stringify(kit.logger.entries)).not.toContain(invite);
    const all = deps();
    await handleIncomingEvent(
      await incoming({ text: "/reactions -100", direct: true }),
      {
        ...all,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              ok: true,
              result: { id: -100, type: "group", title: phrase },
            }),
            { status: 200 },
          ),
      },
    );
    expect(all.reply.sent.map((message) => message.text)).toEqual([
      ["群 -100", "反应 全部"].join("\n"),
    ]);
    expect(JSON.stringify(all.reply.sent)).not.toContain(phrase);
    const emptyList = deps();
    await handleIncomingEvent(
      await incoming({ text: "/reactions -100", direct: true }),
      {
        ...emptyList,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              ok: true,
              result: { id: -100, available_reactions: [] },
            }),
            { status: 200 },
          ),
      },
    );
    expect(emptyList.reply.sent.map((message) => message.text)).toEqual([
      ["群 -100", "反应 0"].join("\n"),
    ]);
    const broken = deps();
    await handleIncomingEvent(
      await incoming({ text: "/reactions -100", direct: true }),
      {
        ...broken,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              ok: true,
              result: { id: -100, title: phrase, available_reactions: phrase },
            }),
            { status: 200 },
          ),
      },
    );
    expect(broken.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(broken.reply.sent)).not.toContain(phrase);
    const typed = deps();
    await handleIncomingEvent(
      await incoming({ text: "/reactions -100", direct: true }),
      {
        ...typed,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              ok: true,
              result: {
                id: -100,
                available_reactions: [{ type: "sticker", emoji: phrase }],
              },
            }),
            { status: 200 },
          ),
      },
    );
    expect(typed.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(typed.reply.sent)).not.toContain(phrase);
    const wide = deps();
    await handleIncomingEvent(
      await incoming({ text: "/reactions -100", direct: true }),
      {
        ...wide,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              ok: true,
              result: {
                id: -200,
                title: phrase,
                invite_link: invite,
                available_reactions: [{ type: "emoji", emoji: phrase }],
              },
            }),
            { status: 200 },
          ),
      },
    );
    expect(wide.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(wide.reply.sent)).not.toContain(phrase);
    expect(JSON.stringify(wide.reply.sent)).not.toContain(invite);
    const empty = deps();
    await handleIncomingEvent(
      await incoming({ text: "/reactions -100", direct: true }),
      {
        ...empty,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: true, result: null }), {
            status: 200,
          }),
      },
    );
    expect(empty.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    const offline = deps();
    await handleIncomingEvent(
      await incoming({ text: "/reactions -100", direct: true }),
      offline,
    );
    expect(offline.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    const rejected = deps();
    await handleIncomingEvent(
      await incoming({ text: "/reactions -100", direct: true }),
      {
        ...rejected,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: false, description: phrase }), {
            status: 400,
          }),
      },
    );
    expect(rejected.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain("bot-token");
  });

  it("reads the chat community and drops the name", async () => {
    const kit = deps();
    const calls: { method: string; body: string }[] = [];
    const invite = `https://t.me/+${phrase}`;
    await handleIncomingEvent(
      await incoming({ text: "/community -100", direct: true }),
      {
        ...kit,
        botToken: "bot-token",
        fetchImpl: async (input, init) => {
          const url = String(input);
          calls.push({
            method: url.slice(url.lastIndexOf("/") + 1),
            body: String(init?.body ?? ""),
          });
          return new Response(
            JSON.stringify({
              ok: true,
              result: {
                id: -100,
                type: "supergroup",
                title: phrase,
                invite_link: invite,
                community: { id: 82002, name: phrase },
              },
            }),
            { status: 200 },
          );
        },
      },
    );
    expect(kit.reply.sent.map((message) => message.text)).toEqual([
      ["群 -100", "社区 82002"].join("\n"),
    ]);
    expect(calls.map((call) => call.method)).toEqual(["getChat"]);
    expect(calls[0]?.method).not.toContain("setChatPermissions");
    expect("getChat").not.toContain("setChatTitle");
    expect(JSON.parse(calls[0]?.body ?? "null")).toEqual({ chat_id: -100 });
    expect(JSON.stringify(kit.reply.sent)).not.toContain(phrase);
    expect(JSON.stringify(kit.reply.sent)).not.toContain(invite);
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(kit.logger.entries)).not.toContain(invite);
    const none = deps();
    await handleIncomingEvent(
      await incoming({ text: "/community -100", direct: true }),
      {
        ...none,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              ok: true,
              result: { id: -100, type: "group", title: phrase },
            }),
            { status: 200 },
          ),
      },
    );
    expect(none.reply.sent.map((message) => message.text)).toEqual([
      ["群 -100", "社区 无"].join("\n"),
    ]);
    expect(JSON.stringify(none.reply.sent)).not.toContain(phrase);
    const broken = deps();
    await handleIncomingEvent(
      await incoming({ text: "/community -100", direct: true }),
      {
        ...broken,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              ok: true,
              result: { id: -100, title: phrase, community: phrase },
            }),
            { status: 200 },
          ),
      },
    );
    expect(broken.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(broken.reply.sent)).not.toContain(phrase);
    const wide = deps();
    await handleIncomingEvent(
      await incoming({ text: "/community -100", direct: true }),
      {
        ...wide,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              ok: true,
              result: {
                id: -200,
                title: phrase,
                invite_link: invite,
                community: { id: 82002, name: phrase },
              },
            }),
            { status: 200 },
          ),
      },
    );
    expect(wide.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(wide.reply.sent)).not.toContain(phrase);
    expect(JSON.stringify(wide.reply.sent)).not.toContain(invite);
    const empty = deps();
    await handleIncomingEvent(
      await incoming({ text: "/community -100", direct: true }),
      {
        ...empty,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: true, result: null }), {
            status: 200,
          }),
      },
    );
    expect(empty.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    const offline = deps();
    await handleIncomingEvent(
      await incoming({ text: "/community -100", direct: true }),
      offline,
    );
    expect(offline.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    const rejected = deps();
    await handleIncomingEvent(
      await incoming({ text: "/community -100", direct: true }),
      {
        ...rejected,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: false, description: phrase }), {
            status: 400,
          }),
      },
    );
    expect(rejected.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain("bot-token");
  });

  it("reports default speaking permissions without the chat title", async () => {
    const kit = deps();
    const calls: { method: string; body: string }[] = [];
    const locked = {
      can_send_messages: false,
      can_send_audios: false,
      can_send_documents: false,
      can_send_photos: false,
      can_send_videos: false,
      can_send_video_notes: false,
      can_send_voice_notes: false,
      can_send_polls: false,
      can_send_other_messages: false,
      can_add_web_page_previews: false,
      can_react_to_messages: false,
      can_edit_tag: false,
      can_change_info: false,
      can_invite_users: false,
      can_pin_messages: false,
      can_manage_topics: false,
    };
    await handleIncomingEvent(
      await incoming({ text: "/perms -100", direct: true }),
      {
        ...kit,
        botToken: "bot-token",
        fetchImpl: async (input, init) => {
          const url = String(input);
          calls.push({
            method: url.slice(url.lastIndexOf("/") + 1),
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
                bio: phrase,
                invite_link: phrase,
                permissions: locked,
              },
            }),
            { status: 200 },
          );
        },
      },
    );
    expect(kit.reply.sent.map((message) => message.text)).toEqual([
      [
        "perms -100",
        "发言 off",
        "音频 off",
        "文件 off",
        "图片 off",
        "视频 off",
        "视频留言 off",
        "语音 off",
        "投票 off",
        "其他 off",
        "预览 off",
        "反应 off",
        "标签 off",
        "资料 off",
        "邀请 off",
        "置顶 off",
        "话题 off",
      ].join("\n"),
    ]);
    expect(calls.map((call) => call.method)).toEqual(["getChat"]);
    const body = JSON.parse(calls[0]?.body ?? "{}") as {
      chat_id?: number;
      user_id?: number;
    };
    expect(body.chat_id).toBe(-100);
    expect(body.user_id).toBeUndefined();
    expect(JSON.stringify(calls)).not.toContain(phrase);
    expect(JSON.stringify(kit.reply.sent)).not.toContain(phrase);
    expect(JSON.stringify(kit.logger.entries)).not.toContain("bot-token");
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
    const offline = deps();
    await handleIncomingEvent(
      await incoming({ text: "/perms -100", direct: true }),
      offline,
    );
    expect(offline.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    const rejected = deps();
    await handleIncomingEvent(
      await incoming({ text: "/perms -100", direct: true }),
      {
        ...rejected,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: false, description: phrase }), {
            status: 400,
          }),
      },
    );
    expect(rejected.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain("bot-token");
  });

  it("deletes several messages in one request", async () => {
    const kit = deps();
    const calls: { method: string; body: string }[] = [];
    await handleIncomingEvent(
      await incoming({ text: "/deletes -100 88 89", direct: true }),
      {
        ...kit,
        botToken: "bot-token",
        fetchImpl: async (input, init) => {
          const url = String(input);
          calls.push({
            method: url.slice(url.lastIndexOf("/") + 1),
            body: String(init?.body ?? ""),
          });
          return new Response(JSON.stringify({ ok: true, result: true }), {
            status: 200,
          });
        },
      },
    );
    expect(kit.reply.sent.map((message) => message.text)).toEqual([
      "已请求删除 -100 的 2 条。找不到的会跳过",
    ]);
    expect(calls.map((call) => call.method)).toEqual(["deleteMessages"]);
    const body = JSON.parse(calls[0]?.body ?? "{}") as {
      chat_id?: number;
      message_id?: number;
      message_ids?: number[];
      receiver_user_id?: number;
    };
    expect(body.chat_id).toBe(-100);
    expect(body.message_ids).toEqual([88, 89]);
    expect(body.message_id).toBeUndefined();
    expect(body.receiver_user_id).toBeUndefined();
    expect(JSON.stringify(calls)).not.toContain(phrase);
    expect(JSON.stringify(kit.logger.entries)).not.toContain("bot-token");
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
    const offline = deps();
    await handleIncomingEvent(
      await incoming({ text: "/deletes -100 88 89", direct: true }),
      offline,
    );
    expect(offline.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    const rejected = deps();
    await handleIncomingEvent(
      await incoming({ text: "/deletes -100 88 89", direct: true }),
      {
        ...rejected,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: false, description: phrase }), {
            status: 400,
          }),
      },
    );
    expect(rejected.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain("bot-token");
  });

  it("deletes one message and leaves the author in the chat", async () => {
    const kit = deps();
    const calls: { method: string; body: string }[] = [];
    await handleIncomingEvent(
      await incoming({ text: "/delete -100 88", direct: true }),
      {
        ...kit,
        botToken: "bot-token",
        fetchImpl: async (input, init) => {
          const url = String(input);
          calls.push({
            method: url.slice(url.lastIndexOf("/") + 1),
            body: String(init?.body ?? ""),
          });
          return new Response(JSON.stringify({ ok: true, result: true }), {
            status: 200,
          });
        },
      },
    );
    expect(kit.reply.sent.map((message) => message.text)).toEqual([
      "已删除 -100 88",
    ]);
    expect(calls.map((call) => call.method)).toEqual(["deleteMessage"]);
    expect(calls[0]?.body).toContain('"chat_id":-100');
    expect(calls[0]?.body).toContain('"message_id":88');
    expect(calls[0]?.body).not.toContain("receiver_user_id");
    expect(JSON.stringify(calls)).not.toContain(phrase);
    expect(JSON.stringify(kit.logger.entries)).not.toContain("bot-token");
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
    const offline = deps();
    await handleIncomingEvent(
      await incoming({ text: "/delete -100 88", direct: true }),
      offline,
    );
    expect(offline.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    const rejected = deps();
    await handleIncomingEvent(
      await incoming({ text: "/delete -100 88", direct: true }),
      {
        ...rejected,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: false, description: phrase }), {
            status: 400,
          }),
      },
    );
    expect(rejected.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain("bot-token");
  });

  it("reports a restriction without the member name", async () => {
    const kit = deps();
    const calls: { method: string; body: string }[] = [];
    await handleIncomingEvent(
      await incoming({ text: "/member -100 77", direct: true }),
      {
        ...kit,
        botToken: "bot-token",
        fetchImpl: async (input, init) => {
          const url = String(input);
          calls.push({
            method: url.slice(url.lastIndexOf("/") + 1),
            body: String(init?.body ?? ""),
          });
          return new Response(
            JSON.stringify({
              ok: true,
              result: {
                status: "restricted",
                is_member: true,
                until_date: 1_700_000_000,
                user: { id: 77, first_name: phrase },
              },
            }),
            { status: 200 },
          );
        },
      },
    );
    expect(kit.reply.sent.map((message) => message.text)).toEqual([
      "-100 77 禁言中，直到 1700000000",
    ]);
    expect(calls.map((call) => call.method)).toEqual(["getChatMember"]);
    expect(JSON.stringify(calls)).not.toContain(phrase);
    expect(JSON.stringify(kit.logger.entries)).not.toContain("bot-token");
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
    const offline = deps();
    await handleIncomingEvent(
      await incoming({ text: "/member -100 77", direct: true }),
      offline,
    );
    expect(offline.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
  });

  it("mutes a member for one hour when no duration is given", async () => {
    const kit = deps();
    const calls: { method: string; body: string }[] = [];
    const started = Math.floor(Date.now() / 1000);
    await handleIncomingEvent(
      await incoming({ text: "/mute -100 77", direct: true }),
      {
        ...kit,
        botToken: "bot-token",
        fetchImpl: async (input, init) => {
          const url = String(input);
          calls.push({
            method: url.slice(url.lastIndexOf("/") + 1),
            body: String(init?.body ?? ""),
          });
          return new Response(JSON.stringify({ ok: true, result: true }), {
            status: 200,
          });
        },
      },
    );
    expect(kit.reply.sent.map((message) => message.text)).toEqual([
      "已禁言 -100 77 3600 秒",
    ]);
    expect(calls.map((call) => call.method)).toEqual(["restrictChatMember"]);
    const body = JSON.parse(calls[0]?.body ?? "{}") as {
      until_date?: number;
      permissions?: { can_send_messages?: boolean; can_edit_tag?: boolean };
      use_independent_chat_permissions?: boolean;
    };
    expect(body.permissions?.can_send_messages).toBe(false);
    expect(body.permissions?.can_edit_tag).toBe(false);
    expect(body.use_independent_chat_permissions).toBe(true);
    expect(body.until_date).toBeGreaterThanOrEqual(started + 3600);
    expect(body.until_date).toBeLessThanOrEqual(started + 3600 + 5);
    expect(JSON.stringify(calls)).not.toContain(phrase);
    expect(JSON.stringify(kit.logger.entries)).not.toContain("bot-token");
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
    const offline = deps();
    await handleIncomingEvent(
      await incoming({ text: "/mute -100 77", direct: true }),
      offline,
    );
    expect(offline.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    const rejected = deps();
    await handleIncomingEvent(
      await incoming({ text: "/mute -100 77 120", direct: true }),
      {
        ...rejected,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: false, description: phrase }), {
            status: 400,
          }),
      },
    );
    expect(rejected.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain("bot-token");
  });

  it("bans a member without deleting their earlier messages", async () => {
    const kit = deps();
    const calls: { method: string; body: string }[] = [];
    await handleIncomingEvent(
      await incoming({ text: "/ban -100 77", direct: true }),
      {
        ...kit,
        botToken: "bot-token",
        fetchImpl: async (input, init) => {
          const url = String(input);
          calls.push({
            method: url.slice(url.lastIndexOf("/") + 1),
            body: String(init?.body ?? ""),
          });
          return new Response(JSON.stringify({ ok: true, result: true }), {
            status: 200,
          });
        },
      },
    );
    expect(kit.reply.sent.map((message) => message.text)).toEqual([
      "已封禁 -100 77",
    ]);
    expect(calls.map((call) => call.method)).toEqual(["banChatMember"]);
    expect(calls[0]?.body).toContain('"revoke_messages":false');
    expect(calls[0]?.body).toContain('"user_id":77');
    expect(calls[0]?.body).not.toContain("until_date");
    expect(JSON.stringify(calls)).not.toContain(phrase);
    expect(JSON.stringify(kit.logger.entries)).not.toContain("bot-token");
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
    const offline = deps();
    await handleIncomingEvent(
      await incoming({ text: "/ban -100 77", direct: true }),
      offline,
    );
    expect(offline.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    const rejected = deps();
    await handleIncomingEvent(
      await incoming({ text: "/ban -100 77", direct: true }),
      {
        ...rejected,
        botToken: "bot-token",
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: false, description: phrase }), {
            status: 400,
          }),
      },
    );
    expect(rejected.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(rejected.logger.entries)).not.toContain("bot-token");
  });

  it("asks Telegram to unban only a user who is already banned", async () => {
    const kit = deps();
    const calls: { method: string; body: string }[] = [];
    await handleIncomingEvent(
      await incoming({ text: "/unban -100 77", direct: true }),
      {
        ...kit,
        botToken: "bot-token",
        fetchImpl: async (input, init) => {
          const url = String(input);
          calls.push({
            method: url.slice(url.lastIndexOf("/") + 1),
            body: String(init?.body ?? ""),
          });
          return new Response("ok", { status: 200 });
        },
      },
    );
    expect(kit.reply.sent.map((message) => message.text)).toEqual([
      "已解除封禁 -100 77",
    ]);
    expect(calls.map((call) => call.method)).toEqual(["unbanChatMember"]);
    expect(calls[0]?.body).toContain('"only_if_banned":true');
    expect(calls[0]?.body).toContain('"user_id":77');
    expect(JSON.stringify(kit.logger.entries)).not.toContain("bot-token");
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
    const offline = deps();
    await handleIncomingEvent(
      await incoming({ text: "/unban -100 77", direct: true }),
      offline,
    );
    expect(offline.reply.sent.map((message) => message.text)).toEqual([
      "参数无效",
    ]);
  });

  it("screens a group command and leaves config unchanged", async () => {
    const kit = deps();
    await handleIncomingEvent(
      await incoming({
        text: `/whitelist -100 add 9 ${phrase}`,
        chatId: "-100",
      }),
      kit,
    );
    expect(kit.reply.sent).toHaveLength(0);
    expect(await kit.policyStore.get("local", "-100")).toBeNull();
    expect(
      kit.logger.entries.some((entry) => entry.fields.action === "delete"),
    ).toBe(true);
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
  });

  it("lets a configured admin manage one chat from a private command", async () => {
    const kit = deps();
    await handleIncomingEvent(
      await incoming({ text: `/help ${phrase}`, direct: true }),
      kit,
    );
    expect(kit.reply.sent[0]?.text).toContain("/whitelist");
    expect(kit.reply.sent[0]?.text).not.toContain(phrase);

    const denied = deps();
    await handleIncomingEvent(
      await incoming({
        text: `/dryrun -100 on ${phrase}`,
        direct: true,
        actorId: "7",
      }),
      denied,
    );
    expect(denied.reply.sent[0]?.text).toBe("没有权限");
    expect(await denied.runtime.getDryRun("local", "-100")).toBe(false);

    await handleIncomingEvent(
      await incoming({ text: "/dryrun -100 on", direct: true }),
      kit,
    );
    await handleIncomingEvent(
      await incoming({
        text: "/dryrun -100 off",
        chatId: "-100",
        actorId: "42",
      }),
      kit,
    );
    expect(await kit.runtime.getDryRun("local", "-100")).toBe(true);

    await handleIncomingEvent(
      await incoming({ text: phrase, chatId: "-100", actorId: "5" }),
      kit,
    );
    expect(kit.storage.records).toHaveLength(0);
    expect(
      kit.logger.entries.some((entry) => entry.fields.dryRun === true),
    ).toBe(true);

    await handleIncomingEvent(
      await incoming({ text: "/dryrun -100 off", direct: true }),
      kit,
    );
    await handleIncomingEvent(
      await incoming({ text: phrase, chatId: "-100", actorId: "5" }),
      kit,
    );
    expect(kit.storage.records).toHaveLength(1);
    const logs = await handleIncomingEvent(
      await incoming({ text: "/logs -100", direct: true }),
      kit,
    );
    expect(logs).toBeUndefined();
    const logReply = kit.reply.sent.at(-1)?.text ?? "";
    expect(logReply).toContain("delete");
    expect(logReply).not.toContain(phrase);
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
  });

  it("releases a join when the captcha button cannot be sent", async () => {
    const kit = deps();
    const moderator = createMemoryModerator();
    const captchaStore = createMemoryCaptchaStore();
    const nonce = "0123456789abcdef";
    await handleIncomingEvent(
      parseEvent({
        id: "evt_join",
        tenantId: "local",
        chatId: "-100123",
        kind: "chat_member",
        occurredAt: "2026-11-01T00:00:00.000Z",
        actor: { id: "77", isAdmin: false },
        membership: "join",
      }),
      { ...kit, moderator, captchaStore, createNonce: () => nonce },
    );
    expect(moderator.restricted).toHaveLength(1);
    expect(moderator.released).toHaveLength(1);
    expect(await captchaStore.get("local", "-100123", "77")).toBeNull();
    expect(
      kit.logger.entries.some(
        (entry) => entry.message === "captcha_prompt_failed",
      ),
    ).toBe(true);
    expect(JSON.stringify(kit.logger.entries)).not.toContain(nonce);
    expect(JSON.stringify(kit.storage.records)).not.toContain(nonce);
  });

  it("audits a passed challenge and a timeout without the nonce", async () => {
    const nonce = "abcdef0123456789";
    const passedStore = createMemoryCaptchaStore();
    const passedMod = createMemoryModerator();
    const passed = deps();
    const clock = createFixedClock("2026-11-01T00:00:00.000Z");
    await passedStore.put({
      tenantId: "local",
      chatId: "-100",
      actorId: "77",
      nonce,
      expiresAt: "2026-11-01T00:05:00.000Z",
    });
    await handleIncomingEvent(
      parseEvent({
        id: "evt_pass",
        tenantId: "local",
        chatId: "-100",
        kind: "challenge",
        occurredAt: "2026-11-01T00:00:00.000Z",
        actor: { id: "77", isAdmin: false },
        challenge: { nonce },
      }),
      { ...passed, moderator: passedMod, captchaStore: passedStore, clock },
    );
    expect(passedMod.released).toHaveLength(1);
    expect(passed.storage.records[0]?.reasons).toEqual(["captcha_passed"]);
    expect(JSON.stringify(passed.storage.records)).not.toContain(nonce);
    expect(JSON.stringify(passed.storage.records)).not.toContain("text");

    const expiredStore = createMemoryCaptchaStore();
    const expiredMod = createMemoryModerator();
    const expired = deps();
    await expiredStore.put({
      tenantId: "local",
      chatId: "-100",
      actorId: "77",
      nonce,
      expiresAt: "2026-11-01T00:00:00.000Z",
    });
    await handleIncomingEvent(
      parseEvent({
        id: "evt_late",
        tenantId: "local",
        chatId: "-100",
        kind: "challenge",
        occurredAt: "2026-11-01T00:00:00.000Z",
        actor: { id: "77", isAdmin: false },
        challenge: { nonce },
      }),
      {
        ...expired,
        moderator: expiredMod,
        captchaStore: expiredStore,
        clock,
      },
    );
    expect(expiredMod.released).toEqual([]);
    expect(expired.storage.records[0]?.reasons).toEqual(["captcha_expired"]);
    expect(JSON.stringify(expired.storage.records)).not.toContain(nonce);
  });

  it("keeps the member restricted after the button is sent", async () => {
    const kit = deps();
    const moderator = createMemoryModerator();
    const captchaStore = createMemoryCaptchaStore();
    const nonce = "0123456789abcdef";
    let body = "";
    await handleIncomingEvent(
      parseEvent({
        id: "evt_button",
        tenantId: "local",
        chatId: "-100123",
        kind: "chat_member",
        occurredAt: "2026-11-01T00:00:00.000Z",
        actor: { id: "77", isAdmin: false },
        membership: "join",
      }),
      {
        ...kit,
        moderator,
        captchaStore,
        createNonce: () => nonce,
        botToken: "bot-token",
        fetchImpl: async (_input, init) => {
          body = String(init?.body ?? "");
          return new Response("ok", { status: 200 });
        },
      },
    );
    expect(moderator.restricted).toHaveLength(1);
    expect(moderator.released).toEqual([]);
    expect(await captchaStore.get("local", "-100123", "77")).not.toBeNull();
    expect(body).toContain(`c:${nonce}`);
    expect(body).not.toContain(phrase);
    expect(JSON.stringify(kit.logger.entries)).not.toContain("bot-token");
  });

  it("sends the captcha button again when the same join is delivered twice", async () => {
    const kit = deps();
    const moderator = createMemoryModerator();
    const captchaStore = createMemoryCaptchaStore();
    const nonce = "0123456789abcdef";
    let prompts = 0;
    const event = parseEvent({
      id: "evt_button_retry",
      tenantId: "local",
      chatId: "-100123",
      kind: "chat_member",
      occurredAt: "2026-11-01T00:00:00.000Z",
      actor: { id: "77", isAdmin: false },
      membership: "join",
    });
    const options = {
      ...kit,
      moderator,
      captchaStore,
      createNonce: () => nonce,
      botToken: "bot-token",
      fetchImpl: async () => {
        prompts += 1;
        return new Response("ok", { status: 200 });
      },
    };
    await handleIncomingEvent(event, options);
    await handleIncomingEvent(event, options);
    expect(prompts).toBe(2);
    expect(moderator.restricted).toHaveLength(1);
    expect(moderator.released).toEqual([]);
    expect(await captchaStore.get("local", "-100123", "77")).toMatchObject({
      nonce,
    });
    expect(JSON.stringify(kit.logger.entries)).not.toContain(nonce);
    expect(JSON.stringify(kit.logger.entries)).not.toContain("bot-token");
  });

  it("keeps the challenge when a repeated join cannot resend the button", async () => {
    const kit = deps();
    const moderator = createMemoryModerator();
    const captchaStore = createMemoryCaptchaStore();
    const nonce = "0123456789abcdef";
    let prompts = 0;
    const event = parseEvent({
      id: "evt_button_retry_fail",
      tenantId: "local",
      chatId: "-100123",
      kind: "chat_member",
      occurredAt: "2026-11-01T00:00:00.000Z",
      actor: { id: "77", isAdmin: false },
      membership: "join",
    });
    const options = {
      ...kit,
      moderator,
      captchaStore,
      createNonce: () => nonce,
      botToken: "bot-token",
      fetchImpl: async () => {
        prompts += 1;
        if (prompts > 1) {
          return new Response("no", { status: 500 });
        }
        return new Response("ok", { status: 200 });
      },
    };
    await handleIncomingEvent(event, options);
    await handleIncomingEvent(event, options);
    expect(prompts).toBe(2);
    expect(moderator.restricted).toHaveLength(1);
    expect(moderator.released).toEqual([]);
    expect(await captchaStore.get("local", "-100123", "77")).toMatchObject({
      nonce,
    });
    expect(
      kit.logger.entries.some(
        (entry) => entry.message === "captcha_prompt_failed",
      ),
    ).toBe(true);
    expect(JSON.stringify(kit.logger.entries)).not.toContain(nonce);
  });

  it("deletes the button when its id cannot be stored", async () => {
    const kit = deps();
    const moderator = createMemoryModerator();
    const captchaStore = createMemoryCaptchaStore();
    const nonce = "0123456789abcdef";
    const options = {
      ...kit,
      moderator,
      captchaStore: {
        ...captchaStore,
        async attachPrompt() {
          throw new Error(phrase);
        },
      },
      createNonce: () => nonce,
      botToken: "bot-token",
      fetchImpl: async () =>
        Response.json({
          ok: true,
          result: { message_id: 42 },
        }),
    };
    await handleIncomingEvent(
      parseEvent({
        id: "evt_attach_throw",
        tenantId: "local",
        chatId: "-100123",
        kind: "chat_member",
        occurredAt: "2026-11-01T00:00:00.000Z",
        actor: { id: "77", isAdmin: false },
        membership: "join",
      }),
      options,
    );
    expect(moderator.deleted).toEqual([
      { tenantId: "local", chatId: "-100123", messageId: "42" },
    ]);
    expect(await captchaStore.get("local", "-100123", "77")).toMatchObject({
      nonce,
    });
    expect(
      (await captchaStore.get("local", "-100123", "77"))?.messageId,
    ).toBeUndefined();
    expect(moderator.restricted).toHaveLength(1);
    expect(moderator.released).toEqual([]);
    expect(
      kit.logger.entries.some(
        (entry) => entry.message === "captcha_prompt_failed",
      ),
    ).toBe(true);
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(kit.logger.entries)).not.toContain(nonce);
    expect(JSON.stringify(kit.logger.entries)).not.toContain("42");
  });

  it("deletes only the unrecorded button when a resend cannot store its id", async () => {
    const kit = deps();
    const moderator = createMemoryModerator();
    const captchaStore = createMemoryCaptchaStore();
    const nonce = "0123456789abcdef";
    let prompts = 0;
    let attaches = 0;
    const event = parseEvent({
      id: "evt_attach_resend",
      tenantId: "local",
      chatId: "-100123",
      kind: "chat_member",
      occurredAt: "2026-11-01T00:00:00.000Z",
      actor: { id: "77", isAdmin: false },
      membership: "join",
    });
    const options = {
      ...kit,
      moderator,
      captchaStore: {
        ...captchaStore,
        async attachPrompt(
          tenantId: string,
          chatId: string,
          actorId: string,
          storedNonce: string,
          messageId: string,
        ) {
          attaches += 1;
          if (attaches > 1) {
            throw new Error(phrase);
          }
          return captchaStore.attachPrompt(
            tenantId,
            chatId,
            actorId,
            storedNonce,
            messageId,
          );
        },
      },
      createNonce: () => nonce,
      botToken: "bot-token",
      fetchImpl: async () => {
        prompts += 1;
        return Response.json({
          ok: true,
          result: { message_id: prompts === 1 ? 42 : 43 },
        });
      },
    };
    await handleIncomingEvent(event, options);
    await handleIncomingEvent(event, options);
    expect(prompts).toBe(2);
    expect(moderator.deleted).toEqual([
      { tenantId: "local", chatId: "-100123", messageId: "43" },
    ]);
    expect(await captchaStore.get("local", "-100123", "77")).toMatchObject({
      nonce,
      messageId: "42",
    });
    expect(moderator.restricted).toHaveLength(1);
    expect(moderator.released).toEqual([]);
    expect(
      kit.logger.entries.some(
        (entry) => entry.message === "captcha_prompt_failed",
      ),
    ).toBe(true);
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(kit.logger.entries)).not.toContain(nonce);
    expect(JSON.stringify(kit.logger.entries)).not.toContain("43");
  });

  it("keeps the challenge when the unrecorded button cannot be deleted", async () => {
    const kit = deps();
    const moderator = createMemoryModerator();
    const captchaStore = createMemoryCaptchaStore();
    const nonce = "0123456789abcdef";
    const options = {
      ...kit,
      moderator: {
        ...moderator,
        async deleteMessage() {
          throw new Error(phrase);
        },
      },
      captchaStore: {
        ...captchaStore,
        async attachPrompt() {
          throw new Error(phrase);
        },
      },
      createNonce: () => nonce,
      botToken: "bot-token",
      fetchImpl: async () =>
        Response.json({
          ok: true,
          result: { message_id: 42 },
        }),
    };
    await handleIncomingEvent(
      parseEvent({
        id: "evt_attach_delete_fail",
        tenantId: "local",
        chatId: "-100123",
        kind: "chat_member",
        occurredAt: "2026-11-01T00:00:00.000Z",
        actor: { id: "77", isAdmin: false },
        membership: "join",
      }),
      options,
    );
    expect(await captchaStore.get("local", "-100123", "77")).toMatchObject({
      nonce,
    });
    expect(moderator.restricted).toHaveLength(1);
    expect(moderator.released).toEqual([]);
    expect(
      kit.logger.entries
        .map((entry) => entry.message)
        .filter((message) => message.startsWith("captcha_")),
    ).toEqual(["captcha_prompt_failed", "captcha_prompt_delete_failed"]);
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(kit.logger.entries)).not.toContain(nonce);
  });

  it("deletes the clicked captcha button and the stored one after a pass", async () => {
    const kit = deps();
    const moderator = createMemoryModerator();
    const captchaStore = createMemoryCaptchaStore();
    const nonce = "0123456789abcdef";
    await handleIncomingEvent(
      parseEvent({
        id: "evt_click_join",
        tenantId: "local",
        chatId: "-100123",
        kind: "chat_member",
        occurredAt: "2026-11-01T00:00:00.000Z",
        actor: { id: "77", isAdmin: false },
        membership: "join",
      }),
      {
        ...kit,
        moderator,
        captchaStore,
        createNonce: () => nonce,
        botToken: "bot-token",
        fetchImpl: async () =>
          Response.json({ ok: true, result: { message_id: 42 } }),
      },
    );
    await handleIncomingEvent(
      parseEvent({
        id: "evt_click_pass",
        tenantId: "local",
        chatId: "-100123",
        kind: "challenge",
        occurredAt: "2026-11-01T00:01:00.000Z",
        actor: { id: "77", isAdmin: false },
        challenge: { nonce, messageId: "43" },
      }),
      { ...kit, moderator, captchaStore },
    );
    expect(moderator.deleted).toEqual([
      { tenantId: "local", chatId: "-100123", messageId: "42" },
      { tenantId: "local", chatId: "-100123", messageId: "43" },
    ]);
    expect(await captchaStore.get("local", "-100123", "77")).toBeNull();
    expect(moderator.released).toHaveLength(1);
    expect(JSON.stringify(kit.logger.entries)).not.toContain(nonce);
    expect(JSON.stringify(kit.logger.entries)).not.toContain("43");
  });

  it("keeps the captcha button when someone else clicks it", async () => {
    const kit = deps();
    const moderator = createMemoryModerator();
    const captchaStore = createMemoryCaptchaStore();
    const nonce = "0123456789abcdef";
    await handleIncomingEvent(
      parseEvent({
        id: "evt_stranger_join",
        tenantId: "local",
        chatId: "-100123",
        kind: "chat_member",
        occurredAt: "2026-11-01T00:00:00.000Z",
        actor: { id: "77", isAdmin: false },
        membership: "join",
      }),
      {
        ...kit,
        moderator,
        captchaStore,
        createNonce: () => nonce,
        botToken: "bot-token",
        fetchImpl: async () =>
          Response.json({ ok: true, result: { message_id: 42 } }),
      },
    );
    await handleIncomingEvent(
      parseEvent({
        id: "evt_stranger_click",
        tenantId: "local",
        chatId: "-100123",
        kind: "challenge",
        occurredAt: "2026-11-01T00:01:00.000Z",
        actor: { id: "88", isAdmin: false },
        challenge: { nonce, messageId: "42" },
      }),
      { ...kit, moderator, captchaStore },
    );
    expect(moderator.deleted).toEqual([]);
    expect(await captchaStore.get("local", "-100123", "77")).toMatchObject({
      nonce,
      messageId: "42",
    });
    expect(moderator.restricted).toHaveLength(1);
    expect(moderator.released).toEqual([]);
    expect(JSON.stringify(kit.logger.entries)).not.toContain(nonce);
  });

  it("keeps a live captcha button when another member's nonce does not match", async () => {
    const kit = deps();
    const moderator = createMemoryModerator();
    const captchaStore = createMemoryCaptchaStore();
    const nonce = "0123456789abcdef";
    const other = "fedcba9876543210";
    await handleIncomingEvent(
      parseEvent({
        id: "evt_live_join",
        tenantId: "local",
        chatId: "-100123",
        kind: "chat_member",
        occurredAt: "2026-11-01T00:00:00.000Z",
        actor: { id: "77", isAdmin: false },
        membership: "join",
      }),
      {
        ...kit,
        moderator,
        captchaStore,
        createNonce: () => nonce,
        botToken: "bot-token",
        fetchImpl: async () =>
          Response.json({ ok: true, result: { message_id: 42 } }),
      },
    );
    await handleIncomingEvent(
      parseEvent({
        id: "evt_live_other",
        tenantId: "local",
        chatId: "-100123",
        kind: "chat_member",
        occurredAt: "2026-11-01T00:00:10.000Z",
        actor: { id: "88", isAdmin: false },
        membership: "join",
      }),
      {
        ...kit,
        moderator,
        captchaStore,
        createNonce: () => other,
        botToken: "bot-token",
        fetchImpl: async () =>
          Response.json({ ok: true, result: { message_id: 43 } }),
      },
    );
    await handleIncomingEvent(
      parseEvent({
        id: "evt_live_click",
        tenantId: "local",
        chatId: "-100123",
        kind: "challenge",
        occurredAt: "2026-11-01T00:01:00.000Z",
        actor: { id: "88", isAdmin: false },
        challenge: { nonce, messageId: "42" },
      }),
      { ...kit, moderator, captchaStore },
    );
    expect(moderator.deleted).toEqual([]);
    expect(await captchaStore.get("local", "-100123", "77")).toMatchObject({
      nonce,
      messageId: "42",
    });
    expect(await captchaStore.get("local", "-100123", "88")).toMatchObject({
      nonce: other,
      messageId: "43",
    });
    expect(moderator.restricted).toHaveLength(2);
    expect(moderator.released).toEqual([]);
    expect(JSON.stringify(kit.logger.entries)).not.toContain(nonce);
    expect(JSON.stringify(kit.logger.entries)).not.toContain(other);
  });

  it("stores the captcha button id and deletes that message after a pass", async () => {
    const kit = deps();
    const moderator = createMemoryModerator();
    const captchaStore = createMemoryCaptchaStore();
    const nonce = "0123456789abcdef";
    await handleIncomingEvent(
      parseEvent({
        id: "evt_button_id",
        tenantId: "local",
        chatId: "-100123",
        kind: "chat_member",
        occurredAt: "2026-11-01T00:00:00.000Z",
        actor: { id: "77", isAdmin: false },
        membership: "join",
      }),
      {
        ...kit,
        moderator,
        captchaStore,
        createNonce: () => nonce,
        botToken: "bot-token",
        fetchImpl: async () =>
          Response.json({ ok: true, result: { message_id: 42 } }),
      },
    );
    expect(await captchaStore.get("local", "-100123", "77")).toMatchObject({
      nonce,
      messageId: "42",
    });
    expect(moderator.deleted).toEqual([]);
    await handleIncomingEvent(
      parseEvent({
        id: "evt_button_pass",
        tenantId: "local",
        chatId: "-100123",
        kind: "challenge",
        occurredAt: "2026-11-01T00:01:00.000Z",
        actor: { id: "77", isAdmin: false },
        challenge: { nonce },
      }),
      { ...kit, moderator, captchaStore },
    );
    expect(moderator.deleted).toEqual([
      { tenantId: "local", chatId: "-100123", messageId: "42" },
    ]);
    expect(moderator.released).toHaveLength(1);
    expect(JSON.stringify(kit.logger.entries)).not.toContain(nonce);
    expect(JSON.stringify(kit.logger.entries)).not.toContain("42");
  });

  it("deletes the previous captcha button when the same join is sent again", async () => {
    const kit = deps();
    const moderator = createMemoryModerator();
    const captchaStore = createMemoryCaptchaStore();
    const nonce = "0123456789abcdef";
    let prompts = 0;
    const event = parseEvent({
      id: "evt_button_replace",
      tenantId: "local",
      chatId: "-100123",
      kind: "chat_member",
      occurredAt: "2026-11-01T00:00:00.000Z",
      actor: { id: "77", isAdmin: false },
      membership: "join",
    });
    const options = {
      ...kit,
      moderator,
      captchaStore,
      createNonce: () => nonce,
      botToken: "bot-token",
      fetchImpl: async () => {
        prompts += 1;
        return Response.json({
          ok: true,
          result: { message_id: prompts === 1 ? 42 : 43 },
        });
      },
    };
    await handleIncomingEvent(event, options);
    await handleIncomingEvent(event, options);
    expect(prompts).toBe(2);
    expect(moderator.deleted).toEqual([
      { tenantId: "local", chatId: "-100123", messageId: "42" },
    ]);
    expect(await captchaStore.get("local", "-100123", "77")).toMatchObject({
      nonce,
      messageId: "43",
    });
    expect(moderator.restricted).toHaveLength(1);
    expect(moderator.released).toEqual([]);
    expect(JSON.stringify(kit.logger.entries)).not.toContain(nonce);
  });

  it("deletes the previous captcha button when the member joins again", async () => {
    const kit = deps();
    const moderator = createMemoryModerator();
    const captchaStore = createMemoryCaptchaStore();
    const nonce = "0123456789abcdef";
    let prompts = 0;
    const options = {
      ...kit,
      moderator,
      captchaStore,
      createNonce: () => nonce,
      botToken: "bot-token",
      fetchImpl: async () => {
        prompts += 1;
        return Response.json({
          ok: true,
          result: { message_id: prompts === 1 ? 42 : 43 },
        });
      },
    };
    await handleIncomingEvent(
      parseEvent({
        id: "evt_rejoin_1",
        tenantId: "local",
        chatId: "-100123",
        kind: "chat_member",
        occurredAt: "2026-11-01T00:00:00.000Z",
        actor: { id: "77", isAdmin: false },
        membership: "join",
      }),
      options,
    );
    await handleIncomingEvent(
      parseEvent({
        id: "evt_rejoin_2",
        tenantId: "local",
        chatId: "-100123",
        kind: "chat_member",
        occurredAt: "2026-11-01T00:00:00.000Z",
        actor: { id: "77", isAdmin: false },
        membership: "join",
      }),
      options,
    );
    expect(prompts).toBe(2);
    expect(moderator.deleted).toEqual([
      { tenantId: "local", chatId: "-100123", messageId: "42" },
    ]);
    expect(await captchaStore.get("local", "-100123", "77")).toMatchObject({
      nonce,
      messageId: "43",
    });
    expect(moderator.restricted).toHaveLength(2);
    expect(moderator.released).toEqual([]);
    expect(JSON.stringify(kit.logger.entries)).not.toContain(nonce);
    expect(JSON.stringify(kit.logger.entries)).not.toContain("42");
  });

  it("deletes the captcha button when the member leaves", async () => {
    const kit = deps();
    const moderator = createMemoryModerator();
    const captchaStore = createMemoryCaptchaStore();
    const nonce = "0123456789abcdef";
    let prompts = 0;
    const options = {
      ...kit,
      moderator,
      captchaStore,
      createNonce: () => nonce,
      botToken: "bot-token",
      fetchImpl: async () => {
        prompts += 1;
        return Response.json({
          ok: true,
          result: { message_id: 42 },
        });
      },
    };
    await handleIncomingEvent(
      parseEvent({
        id: "evt_leave_join",
        tenantId: "local",
        chatId: "-100123",
        kind: "chat_member",
        occurredAt: "2026-11-01T00:00:00.000Z",
        actor: { id: "77", isAdmin: false },
        membership: "join",
      }),
      options,
    );
    await handleIncomingEvent(
      parseEvent({
        id: "evt_leave",
        tenantId: "local",
        chatId: "-100123",
        kind: "chat_member",
        occurredAt: "2026-11-01T00:00:10.000Z",
        actor: { id: "77", isAdmin: false },
        membership: "leave",
      }),
      options,
    );
    expect(prompts).toBe(1);
    expect(moderator.deleted).toEqual([
      { tenantId: "local", chatId: "-100123", messageId: "42" },
    ]);
    expect(await captchaStore.get("local", "-100123", "77")).toBeNull();
    expect(moderator.restricted).toHaveLength(1);
    expect(moderator.released).toEqual([]);
    expect(JSON.stringify(kit.logger.entries)).not.toContain(nonce);
    expect(JSON.stringify(kit.logger.entries)).not.toContain("42");
  });

  it("deletes the captcha button when the member is promoted", async () => {
    const kit = deps();
    const moderator = createMemoryModerator();
    const captchaStore = createMemoryCaptchaStore();
    const nonce = "0123456789abcdef";
    let prompts = 0;
    const options = {
      ...kit,
      moderator,
      captchaStore,
      createNonce: () => nonce,
      botToken: "bot-token",
      fetchImpl: async () => {
        prompts += 1;
        return Response.json({
          ok: true,
          result: { message_id: 42 },
        });
      },
    };
    await handleIncomingEvent(
      parseEvent({
        id: "evt_promote_join",
        tenantId: "local",
        chatId: "-100123",
        kind: "chat_member",
        occurredAt: "2026-11-01T00:00:00.000Z",
        actor: { id: "77", isAdmin: false },
        membership: "join",
      }),
      options,
    );
    await handleIncomingEvent(
      parseEvent({
        id: "evt_promote",
        tenantId: "local",
        chatId: "-100123",
        kind: "chat_member",
        occurredAt: "2026-11-01T00:00:10.000Z",
        actor: { id: "77", isAdmin: true },
        membership: "promote",
      }),
      options,
    );
    expect(prompts).toBe(1);
    expect(moderator.deleted).toEqual([
      { tenantId: "local", chatId: "-100123", messageId: "42" },
    ]);
    expect(await captchaStore.get("local", "-100123", "77")).toBeNull();
    expect(moderator.restricted).toHaveLength(1);
    expect(moderator.released).toEqual([]);
    expect(
      kit.logger.entries.some((entry) => entry.message === "captcha_promoted"),
    ).toBe(true);
    expect(JSON.stringify(kit.logger.entries)).not.toContain(nonce);
    expect(JSON.stringify(kit.logger.entries)).not.toContain("42");
  });

  it("keeps the challenge when promotion cannot drop the row", async () => {
    const kit = deps();
    const moderator = createMemoryModerator();
    const captchaStore = createMemoryCaptchaStore();
    const nonce = "0123456789abcdef";
    const options = {
      ...kit,
      moderator,
      captchaStore: {
        ...captchaStore,
        async delete() {
          throw new Error(phrase);
        },
      },
      createNonce: () => nonce,
      botToken: "bot-token",
      fetchImpl: async () =>
        Response.json({
          ok: true,
          result: { message_id: 42 },
        }),
    };
    await handleIncomingEvent(
      parseEvent({
        id: "evt_promote_keep_join",
        tenantId: "local",
        chatId: "-100123",
        kind: "chat_member",
        occurredAt: "2026-11-01T00:00:00.000Z",
        actor: { id: "77", isAdmin: false },
        membership: "join",
      }),
      options,
    );
    await handleIncomingEvent(
      parseEvent({
        id: "evt_promote_keep",
        tenantId: "local",
        chatId: "-100123",
        kind: "chat_member",
        occurredAt: "2026-11-01T00:00:10.000Z",
        actor: { id: "77", isAdmin: true },
        membership: "promote",
      }),
      options,
    );
    expect(moderator.deleted).toEqual([
      { tenantId: "local", chatId: "-100123", messageId: "42" },
    ]);
    expect(await captchaStore.get("local", "-100123", "77")).toMatchObject({
      nonce,
      messageId: "42",
    });
    expect(moderator.restricted).toHaveLength(1);
    expect(moderator.released).toEqual([]);
    expect(kit.logger.entries.map((entry) => entry.message)).toContain(
      "captcha_promote_failed",
    );
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(kit.logger.entries)).not.toContain(nonce);
    expect(JSON.stringify(kit.logger.entries)).not.toContain("42");
  });

  it("deletes the captcha button when the restriction is lifted early", async () => {
    const kit = deps();
    const moderator = createMemoryModerator();
    const captchaStore = createMemoryCaptchaStore();
    const nonce = "0123456789abcdef";
    let prompts = 0;
    const options = {
      ...kit,
      moderator,
      captchaStore,
      createNonce: () => nonce,
      botToken: "bot-token",
      fetchImpl: async () => {
        prompts += 1;
        return Response.json({
          ok: true,
          result: { message_id: 42 },
        });
      },
    };
    await handleIncomingEvent(
      parseEvent({
        id: "evt_unrestrict_join",
        tenantId: "local",
        chatId: "-100123",
        kind: "chat_member",
        occurredAt: "2026-11-01T00:00:00.000Z",
        actor: { id: "77", isAdmin: false },
        membership: "join",
      }),
      options,
    );
    await handleIncomingEvent(
      parseEvent({
        id: "evt_unrestrict",
        tenantId: "local",
        chatId: "-100123",
        kind: "chat_member",
        occurredAt: "2026-11-01T00:00:10.000Z",
        actor: { id: "77", isAdmin: false },
        membership: "unrestrict",
      }),
      options,
    );
    expect(prompts).toBe(1);
    expect(moderator.deleted).toEqual([
      { tenantId: "local", chatId: "-100123", messageId: "42" },
    ]);
    expect(await captchaStore.get("local", "-100123", "77")).toBeNull();
    expect(moderator.restricted).toHaveLength(1);
    expect(moderator.released).toEqual([]);
    expect(
      kit.logger.entries.some(
        (entry) => entry.message === "captcha_unrestricted",
      ),
    ).toBe(true);
    expect(JSON.stringify(kit.logger.entries)).not.toContain(nonce);
    expect(JSON.stringify(kit.logger.entries)).not.toContain("42");
  });

  it("keeps the challenge when leaving cannot drop the row", async () => {
    const kit = deps();
    const moderator = createMemoryModerator();
    const captchaStore = createMemoryCaptchaStore();
    const nonce = "0123456789abcdef";
    const options = {
      ...kit,
      moderator,
      captchaStore: {
        ...captchaStore,
        async delete() {
          throw new Error(phrase);
        },
      },
      createNonce: () => nonce,
      botToken: "bot-token",
      fetchImpl: async () =>
        Response.json({
          ok: true,
          result: { message_id: 42 },
        }),
    };
    await handleIncomingEvent(
      parseEvent({
        id: "evt_leave_keep_join",
        tenantId: "local",
        chatId: "-100123",
        kind: "chat_member",
        occurredAt: "2026-11-01T00:00:00.000Z",
        actor: { id: "77", isAdmin: false },
        membership: "join",
      }),
      options,
    );
    await handleIncomingEvent(
      parseEvent({
        id: "evt_leave_keep",
        tenantId: "local",
        chatId: "-100123",
        kind: "chat_member",
        occurredAt: "2026-11-01T00:00:10.000Z",
        actor: { id: "77", isAdmin: false },
        membership: "leave",
      }),
      options,
    );
    expect(moderator.deleted).toEqual([
      { tenantId: "local", chatId: "-100123", messageId: "42" },
    ]);
    expect(await captchaStore.get("local", "-100123", "77")).toMatchObject({
      nonce,
      messageId: "42",
    });
    expect(moderator.restricted).toHaveLength(1);
    expect(moderator.released).toEqual([]);
    expect(kit.logger.entries.map((entry) => entry.message)).toContain(
      "captcha_leave_failed",
    );
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(kit.logger.entries)).not.toContain(nonce);
  });

  it("keeps the captcha button when the member is only restricted", async () => {
    const kit = deps();
    const moderator = createMemoryModerator();
    const captchaStore = createMemoryCaptchaStore();
    const nonce = "0123456789abcdef";
    const options = {
      ...kit,
      moderator,
      captchaStore,
      createNonce: () => nonce,
      botToken: "bot-token",
      fetchImpl: async () =>
        Response.json({
          ok: true,
          result: { message_id: 42 },
        }),
    };
    await handleIncomingEvent(
      parseEvent({
        id: "evt_restrict_join",
        tenantId: "local",
        chatId: "-100123",
        kind: "chat_member",
        occurredAt: "2026-11-01T00:00:00.000Z",
        actor: { id: "77", isAdmin: false },
        membership: "join",
      }),
      options,
    );
    await handleIncomingEvent(
      parseEvent({
        id: "evt_restrict",
        tenantId: "local",
        chatId: "-100123",
        kind: "chat_member",
        occurredAt: "2026-11-01T00:00:10.000Z",
        actor: { id: "77", isAdmin: false },
      }),
      options,
    );
    expect(moderator.deleted).toEqual([]);
    expect(await captchaStore.get("local", "-100123", "77")).toMatchObject({
      nonce,
      messageId: "42",
    });
    expect(moderator.restricted).toHaveLength(1);
    expect(moderator.released).toEqual([]);
    expect(JSON.stringify(kit.logger.entries)).not.toContain(nonce);
  });

  it("deletes the captcha button when a later join is banned", async () => {
    const kit = deps();
    const moderator = createMemoryModerator();
    const captchaStore = createMemoryCaptchaStore();
    const nonce = "0123456789abcdef";
    const name = "广告员免费领取礼品";
    let prompts = 0;
    const options = {
      ...kit,
      moderator,
      captchaStore,
      createNonce: () => nonce,
      botToken: "bot-token",
      fetchImpl: async () => {
        prompts += 1;
        return Response.json({
          ok: true,
          result: { message_id: 42 },
        });
      },
    };
    await handleIncomingEvent(
      parseEvent({
        id: "evt_ban_join_1",
        tenantId: "local",
        chatId: "-100123",
        kind: "chat_member",
        occurredAt: "2026-11-01T00:00:00.000Z",
        actor: { id: "77", isAdmin: false },
        membership: "join",
      }),
      options,
    );
    await handleIncomingEvent(
      parseEvent({
        id: "evt_ban_join_2",
        tenantId: "local",
        chatId: "-100123",
        kind: "chat_member",
        occurredAt: "2026-11-01T00:00:10.000Z",
        actor: { id: "77", isAdmin: false },
        membership: "join",
        profile: { text: name, textSha256: await sha256Hex(name) },
      }),
      options,
    );
    expect(prompts).toBe(1);
    expect(moderator.banned).toEqual([
      { tenantId: "local", chatId: "-100123", actorId: "77" },
    ]);
    expect(moderator.deleted).toEqual([
      { tenantId: "local", chatId: "-100123", messageId: "42" },
    ]);
    expect(await captchaStore.get("local", "-100123", "77")).toBeNull();
    expect(moderator.restricted).toHaveLength(1);
    expect(moderator.released).toEqual([]);
    expect(JSON.stringify(kit.logger.entries)).not.toContain(nonce);
    expect(JSON.stringify(kit.logger.entries)).not.toContain("42");
    expect(JSON.stringify(kit.logger.entries)).not.toContain(name);
  });

  it("stops reading the shared blocklist as soon as the chat turns it off", async () => {
    const kit = deps();
    const blocklist = createMemoryBlocklistStore();
    let reads = 0;
    const wrapped: BlocklistStore = {
      isEnabled: (tenantId, chatId) => blocklist.isEnabled(tenantId, chatId),
      setEnabled: (tenantId, chatId, enabled) =>
        blocklist.setEnabled(tenantId, chatId, enabled),
      add: (tenantId, entry) => blocklist.add(tenantId, entry),
      remove: (tenantId, entry) => blocklist.remove(tenantId, entry),
      size: (tenantId) => blocklist.size(tenantId),
      async has(tenantId, entry) {
        reads += 1;
        return blocklist.has(tenantId, entry);
      },
    };
    const note = "今天站会改到三点";
    const base = {
      ...kit,
      blocklist: wrapped,
      rateWindow: createMemoryRateWindow(),
    };
    await handleIncomingEvent(
      await incoming({ text: note, chatId: "-100", actorId: "5" }),
      base,
    );
    expect(reads).toBe(0);
    expect(kit.storage.records).toHaveLength(0);

    await handleIncomingEvent(
      await incoming({ text: "/blocklist -100 add actor 5", direct: true }),
      base,
    );
    expect(kit.reply.sent.at(-1)?.text).toBe(
      "blocklist -100 off shared 1\nadded",
    );
    await handleIncomingEvent(
      await incoming({ text: "明天下午见", chatId: "-100", actorId: "5" }),
      base,
    );
    expect(reads).toBe(0);

    await handleIncomingEvent(
      await incoming({ text: "/blocklist -100 on", direct: true }),
      base,
    );
    await handleIncomingEvent(
      await incoming({ text: "下周一同步", chatId: "-100", actorId: "5" }),
      base,
    );
    expect(kit.storage.records.at(-1)?.action).toBe("delete");
    expect(kit.storage.records.at(-1)?.reasons).toContain("shared_actor");
    expect(JSON.stringify(kit.storage.records)).not.toContain("下周一同步");
    const seen = reads;
    expect(seen).toBeGreaterThan(0);

    await handleIncomingEvent(
      await incoming({ text: "/blocklist -100 off", direct: true }),
      base,
    );
    await handleIncomingEvent(
      await incoming({ text: "周五再看", chatId: "-100", actorId: "5" }),
      base,
    );
    expect(reads).toBe(seen);
    expect(kit.storage.records).toHaveLength(1);
    expect(JSON.stringify(kit.logger.entries)).not.toContain(note);
  });

  it("replies in English when locale is en", async () => {
    const kit = deps();
    await handleIncomingEvent(
      await incoming({ text: "/help", direct: true, actorId: "7" }),
      { ...kit, locale: "en" },
    );
    expect(kit.reply.sent[0]?.text).toBe("No permission");
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
  });

  it("queues an appeal and leaves the rules untouched", async () => {
    const kit = deps();
    const review = createMemoryReviewQueue();
    const rules = {
      version: 1 as const,
      aggregate: "max" as const,
      rules: [
        {
          id: "spam_keywords",
          enabled: true,
          detectorIds: ["keyword"],
          threshold: 1,
          actions: ["delete" as const],
        },
      ],
    };
    await kit.storage.putRuleSet("local", "-100", rules);
    await kit.storage.appendAudit({
      tenantId: "local",
      chatId: "-100",
      eventId: "tg_9",
      textSha256: await sha256Hex(phrase),
      action: "delete",
      score: 1,
      reasons: ["keyword_match"],
      evidence: [{ kind: "keyword", summary: phrase }],
      ruleIds: ["spam_keywords"],
      createdAt: "2026-11-01T00:00:00.000Z",
    });
    await handleIncomingEvent(
      await incoming({ text: "/appeal -100 tg_9 false", direct: true }),
      { ...kit, review },
    );
    expect(kit.reply.sent.at(-1)?.text).toBe("appeal -100 tg_9 误判");
    const queued = await review.list({ tenantId: "local" });
    expect(queued).toHaveLength(1);
    expect(queued[0]?.label).toBe("false_positive");
    expect(JSON.stringify(queued)).not.toContain(phrase);
    expect(await kit.storage.getRuleSet("local", "-100")).toEqual(rules);
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
    expect(
      kit.logger.entries.some((entry) => entry.message === "review_queued"),
    ).toBe(true);
    await handleIncomingEvent(
      await incoming({ text: "/evals -100", direct: true }),
      { ...kit, review },
    );
    const exported = kit.reply.sent.at(-1)?.text ?? "";
    const doc = JSON.parse(exported) as {
      cases: { label: string; text?: string }[];
    };
    expect(doc.cases[0]?.label).toBe("ham");
    expect(doc.cases[0]?.text).toBeUndefined();
    expect(exported).not.toContain(phrase);
    expect(await kit.storage.getRuleSet("local", "-100")).toEqual(rules);
  });

  it("shares a rule pack between the command and the next message", async () => {
    const kit = deps();
    const store = createMemoryRuleSubscriptionStore();
    const archive = createMemoryRulePackArchive();
    let calls = 0;
    const rulePacks = {
      store,
      archive,
      source: {
        async load() {
          calls += 1;
          if (calls > 1) {
            throw new Error(phrase);
          }
          return { version: 1, aggregate: "max", rules: [] };
        },
      },
    };
    const rateWindow = createMemoryRateWindow();
    await handleIncomingEvent(
      await incoming({ text: "/packs -100558 community", direct: true }),
      { ...kit, rulePacks, rateWindow },
    );
    expect(kit.reply.sent.at(-1)?.text).toBe("packs -100558 community");
    await handleIncomingEvent(
      await incoming({ text: "/rules -100558", direct: true }),
      { ...kit, rulePacks, rateWindow },
    );
    expect(kit.reply.sent.at(-1)?.text).toBe("rules -100558 community\nnone");
    await handleIncomingEvent(
      await incoming({ text: phrase, chatId: "-100558", actorId: "5" }),
      { ...kit, rulePacks, rateWindow },
    );
    expect(
      kit.logger.entries.some((entry) => entry.fields.action === "allow"),
    ).toBe(true);
    const again = deps();
    await handleIncomingEvent(
      await incoming({ text: phrase, chatId: "-100558", actorId: "5" }),
      {
        ...again,
        rulePacks,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(
      again.logger.entries.some(
        (entry) => entry.message === "pack_update_failed",
      ),
    ).toBe(true);
    expect(
      again.logger.entries.some((entry) => entry.fields.action === "allow"),
    ).toBe(true);
    expect(JSON.stringify(again.logger.entries)).not.toContain(phrase);
    expect(calls).toBe(2);
  });

  it("reports a hit to the first admin without the message", async () => {
    const kit = deps();
    await handleIncomingEvent(
      await incoming({ text: phrase, chatId: "-100567", actorId: "5" }),
      {
        ...kit,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        source: {
          async loadChat() {
            return null;
          },
          async loadDefault() {
            return {
              version: 1,
              aggregate: "max",
              rules: [
                {
                  id: "watch",
                  enabled: true,
                  detectorIds: ["keyword"],
                  threshold: 1,
                  actions: ["report"],
                },
              ],
            };
          },
        },
      },
    );
    expect(kit.reply.sent).toHaveLength(1);
    expect(kit.reply.sent[0]?.chatId).toBe("42");
    expect(kit.reply.sent[0]?.text).toContain("keyword_match");
    expect(kit.reply.sent[0]?.text).not.toContain(phrase);
  });

  it("marks paused rules after the free quota without counting the command", async () => {
    const kit = deps();
    const policy = quotaPolicyFromEnv({
      QUOTA_ENABLED: "true",
      QUOTA_LIMIT: "1",
      QUOTA_BASIC: "keyword",
    });
    const store = createMemoryQuotaStore();
    const usage = {
      tenantId: "local",
      chatId: "-100",
      atIso: "2026-11-01T00:00:00.000Z",
      policy,
    };
    await store.consume(usage);
    await store.consume(usage);
    const before = await store.read(usage);
    await handleIncomingEvent(
      await incoming({ text: "/rules -100", direct: true }),
      {
        ...kit,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        source: {
          async loadChat() {
            return null;
          },
          async loadDefault() {
            return {
              version: 1,
              aggregate: "max",
              rules: [
                {
                  id: "spam_keywords",
                  enabled: true,
                  detectorIds: ["keyword"],
                  threshold: 1,
                  actions: ["delete"],
                },
                {
                  id: "llm_hint",
                  enabled: false,
                  detectorIds: ["llm"],
                  threshold: 1,
                  actions: ["log"],
                },
              ],
            };
          },
        },
        quota: { policy, store },
      },
    );
    const text = kit.reply.sent.at(-1)?.text ?? "";
    expect(text.startsWith("rules -100 until 2026-12-01T00:00:00.000Z\n")).toBe(
      true,
    );
    expect(text).toContain(
      "spam_keywords enabled file threshold 1 actions delete\n",
    );
    expect(text).toContain(
      "llm_hint disabled file threshold 1 actions log paused",
    );
    expect(await store.read(usage)).toEqual(before);
    expect(text).not.toContain(phrase);
  });

  it("answers /quota from configuration and does not echo the text", async () => {
    const kit = deps();
    await handleIncomingEvent(
      await incoming({ text: `/quota -100 ${phrase}`, direct: true }),
      {
        ...kit,
        quota: {
          policy: quotaPolicyFromEnv({
            QUOTA_ENABLED: "true",
            QUOTA_LIMIT: "3000",
          }),
          store: createMemoryQuotaStore(),
        },
      },
    );
    expect(kit.reply.sent[0]?.text).toBe("用法：/quota <chatId>");
    await handleIncomingEvent(
      await incoming({ text: "/quota -100", direct: true }),
      {
        ...kit,
        quota: {
          policy: quotaPolicyFromEnv({
            QUOTA_ENABLED: "true",
            QUOTA_LIMIT: "3000",
          }),
          store: createMemoryQuotaStore(),
        },
      },
    );
    expect(kit.reply.sent[1]?.text).toBe(
      "quota -100 0/3000 calendar_month full until 2026-12-01T00:00:00.000Z",
    );
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
  });

  it("lists the default basic detectors when /quota is degraded", async () => {
    const kit = deps();
    const policy = quotaPolicyFromEnv({
      QUOTA_ENABLED: "true",
      QUOTA_LIMIT: "1",
    });
    const store = createMemoryQuotaStore();
    const usage = {
      tenantId: "local",
      chatId: "-100",
      atIso: "2026-11-01T00:00:00.000Z",
      policy,
    };
    await store.consume(usage);
    await store.consume(usage);
    await handleIncomingEvent(
      await incoming({ text: "/quota -100", direct: true }),
      { ...kit, quota: { policy, store } },
    );
    const text = kit.reply.sent.at(-1)?.text ?? "";
    expect(defaultBasicDetectorIds.join(",")).toBe(
      "keyword,join,flood,repeat,link,blocklist,forward,regex",
    );
    expect(text).toBe(
      `quota -100 2/1 calendar_month basic until 2026-12-01T00:00:00.000Z\n${defaultBasicDetectorIds.join(",")}`,
    );
    expect(text).not.toContain("llm");
    expect(text).not.toContain(phrase);
  });

  it("lets the person who promoted the bot manage that chat", async () => {
    const kit = deps();
    const chats = createMemoryChatDirectory();
    const title = "机密群名";
    await handleIncomingEvent(
      parseEvent({
        id: "evt_bot",
        tenantId: "local",
        chatId: "-100586",
        kind: "bot_membership",
        occurredAt: "2026-11-01T00:00:00.000Z",
        actor: { id: "7", isAdmin: false },
        bot: "admin",
      }),
      { ...kit, chats },
    );
    expect(kit.reply.sent).toHaveLength(0);
    expect(JSON.stringify(kit.logger.entries)).not.toContain(title);
    await handleIncomingEvent(
      await incoming({ text: "/chats", direct: true, actorId: "7" }),
      { ...kit, chats, adminActorIds: ["42"] },
    );
    expect(kit.reply.sent[0]?.text).toBe("chats\n-100586");
    await handleIncomingEvent(
      await incoming({
        text: `/quota -100587 ${phrase}`,
        direct: true,
        actorId: "7",
      }),
      {
        ...kit,
        chats,
        adminActorIds: ["42"],
        quota: {
          policy: quotaPolicyFromEnv({ QUOTA_ENABLED: "true" }),
          store: createMemoryQuotaStore(),
        },
      },
    );
    expect(kit.reply.sent[1]?.text).toBe("用法：/quota <chatId>");
    await handleIncomingEvent(
      await incoming({ text: "/quota -100586", direct: true, actorId: "7" }),
      {
        ...kit,
        chats,
        adminActorIds: ["42"],
        quota: {
          policy: quotaPolicyFromEnv({ QUOTA_ENABLED: "true" }),
          store: createMemoryQuotaStore(),
        },
      },
    );
    expect(kit.reply.sent[2]?.text).toBe(
      "quota -100586 0/3000 calendar_month full until 2026-12-01T00:00:00.000Z",
    );
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
  });

  it("lists each granted chat with its quota and does not count the command", async () => {
    const kit = deps();
    const chats = createMemoryChatDirectory();
    const policy = quotaPolicyFromEnv({
      QUOTA_ENABLED: "true",
      QUOTA_LIMIT: "1",
    });
    const store = createMemoryQuotaStore();
    const usage = {
      tenantId: "local",
      chatId: "-100586",
      atIso: "2026-11-01T00:00:00.000Z",
      policy,
    };
    await store.consume(usage);
    await store.consume(usage);
    const before = await store.read(usage);
    await handleIncomingEvent(
      parseEvent({
        id: "evt_bot",
        tenantId: "local",
        chatId: "-100586",
        kind: "bot_membership",
        occurredAt: "2026-11-01T00:00:00.000Z",
        actor: { id: "7", isAdmin: false },
        bot: "admin",
      }),
      { ...kit, chats },
    );
    await handleIncomingEvent(
      await incoming({ text: "/chats", direct: true, actorId: "7" }),
      {
        ...kit,
        chats,
        adminActorIds: ["42"],
        quota: { policy, store },
      },
    );
    expect(kit.reply.sent.at(-1)?.text).toBe("chats\n-100586 2/1");
    expect(await store.read(usage)).toEqual(before);
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
  });
});
