import type {
  BanTarget,
  MemberStanding,
  ModerationPort,
  MuteTarget,
  UnmuteResult,
} from "@tasb/core";
import { telegramId } from "./ids.js";

const silenced = {
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

const speaking = {
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
};

export const captchaPrompt = "请点击按钮，确认你不是机器人。";

export function createTelegramModerator(input: {
  readonly token: string | undefined;
  readonly fetchImpl?: typeof fetch;
  readonly nowSeconds?: () => number;
}): ModerationPort {
  return {
    async deleteMessage(target) {
      const audienceId = target.audienceId;
      await postTelegram({
        token: input.token,
        method: audienceId ? "deleteEphemeralMessage" : "deleteMessage",
        fetchImpl: input.fetchImpl,
        missing: "delete_unavailable",
        failed: "delete_failed",
        body: audienceId
          ? {
              chat_id: telegramId(target.chatId),
              receiver_user_id: telegramId(audienceId),
              ephemeral_message_id: telegramId(target.messageId),
            }
          : {
              chat_id: telegramId(target.chatId),
              message_id: telegramId(target.messageId),
            },
      });
    },
    async muteActor(target) {
      await postTelegram({
        token: input.token,
        method: "restrictChatMember",
        fetchImpl: input.fetchImpl,
        missing: "mute_unavailable",
        failed: "mute_failed",
        body: silencedUntil(target, input.nowSeconds ?? unixSeconds),
      });
    },
    async approveJoin(target) {
      await postTelegram({
        token: input.token,
        method: "approveChatJoinRequest",
        fetchImpl: input.fetchImpl,
        missing: "approve_unavailable",
        failed: "approve_failed",
        body: {
          chat_id: telegramId(target.chatId),
          user_id: telegramId(target.actorId),
        },
      });
    },
    async declineJoin(target) {
      if (target.queryId) {
        await answerJoinQuery(input, target.queryId, "decline");
        return;
      }
      await postTelegram({
        token: input.token,
        method: "declineChatJoinRequest",
        fetchImpl: input.fetchImpl,
        missing: "decline_unavailable",
        failed: "decline_failed",
        body: {
          chat_id: telegramId(target.chatId),
          user_id: telegramId(target.actorId),
        },
      });
    },
    async deferJoin(target) {
      await answerJoinQuery(input, target.queryId, "queue");
    },
    async banSenderChat(target) {
      await postTelegram({
        token: input.token,
        method: "banChatSenderChat",
        fetchImpl: input.fetchImpl,
        missing: "sender_unavailable",
        failed: "sender_failed",
        body: {
          chat_id: telegramId(target.chatId),
          sender_chat_id: telegramId(target.senderChatId),
        },
      });
    },
    async unbanSenderChat(target) {
      await postTelegram({
        token: input.token,
        method: "unbanChatSenderChat",
        fetchImpl: input.fetchImpl,
        missing: "unban_sender_unavailable",
        failed: "unban_sender_failed",
        body: {
          chat_id: telegramId(target.chatId),
          sender_chat_id: telegramId(target.senderChatId),
        },
      });
    },
    async banActor(target) {
      await postTelegram({
        token: input.token,
        method: "banChatMember",
        fetchImpl: input.fetchImpl,
        missing: "ban_unavailable",
        failed: "ban_failed",
        body: {
          chat_id: telegramId(target.chatId),
          user_id: telegramId(target.actorId),
          revoke_messages: false,
        },
      });
    },
    async unbanActor(target) {
      await postTelegram({
        token: input.token,
        method: "unbanChatMember",
        fetchImpl: input.fetchImpl,
        missing: "unban_unavailable",
        failed: "unban_failed",
        body: {
          chat_id: telegramId(target.chatId),
          user_id: telegramId(target.actorId),
          only_if_banned: true,
        },
      });
    },
    async unmuteActor(target): Promise<UnmuteResult> {
      const member = await postTelegram({
        token: input.token,
        method: "getChatMember",
        fetchImpl: input.fetchImpl,
        missing: "unmute_unavailable",
        failed: "unmute_failed",
        body: {
          chat_id: telegramId(target.chatId),
          user_id: telegramId(target.actorId),
        },
      });
      if (memberStatus(member) !== "restricted") {
        return "absent";
      }
      await postTelegram({
        token: input.token,
        method: "restrictChatMember",
        fetchImpl: input.fetchImpl,
        missing: "unmute_unavailable",
        failed: "unmute_failed",
        body: {
          chat_id: telegramId(target.chatId),
          user_id: telegramId(target.actorId),
          permissions: speaking,
          use_independent_chat_permissions: true,
        },
      });
      return "lifted";
    },
    async readMember(target): Promise<MemberStanding> {
      const member = await postTelegram({
        token: input.token,
        method: "getChatMember",
        fetchImpl: input.fetchImpl,
        missing: "member_unavailable",
        failed: "member_failed",
        body: {
          chat_id: telegramId(target.chatId),
          user_id: telegramId(target.actorId),
        },
      });
      return readStanding(member);
    },
    async restrictActor(target) {
      await postTelegram({
        token: input.token,
        method: "restrictChatMember",
        fetchImpl: input.fetchImpl,
        missing: "restrict_unavailable",
        failed: "restrict_failed",
        body: silencedUntil(target, input.nowSeconds ?? unixSeconds),
      });
    },
    async releaseActor(target) {
      await postTelegram({
        token: input.token,
        method: "restrictChatMember",
        fetchImpl: input.fetchImpl,
        missing: "restrict_unavailable",
        failed: "restrict_failed",
        body: {
          chat_id: telegramId(target.chatId),
          user_id: telegramId(target.actorId),
          permissions: speaking,
          use_independent_chat_permissions: true,
        },
      });
    },
  };
}

export async function sendCaptchaButton(input: {
  readonly token: string | undefined;
  readonly chatId: string;
  readonly nonce: string;
  readonly fetchImpl?: typeof fetch;
}): Promise<string | null> {
  if (!/^[a-f0-9]{16}$/.test(input.nonce)) {
    throw new Error("captcha_prompt_failed");
  }
  const body = await postTelegram({
    token: input.token,
    method: "sendMessage",
    fetchImpl: input.fetchImpl,
    missing: "captcha_prompt_failed",
    failed: "captcha_prompt_failed",
    body: {
      chat_id: telegramId(input.chatId),
      text: captchaPrompt,
      link_preview_options: { is_disabled: true },
      reply_markup: {
        inline_keyboard: [
          [{ text: "我不是机器人", callback_data: `c:${input.nonce}` }],
        ],
      },
    },
  });
  return readTelegramMessageId(body);
}

function readTelegramMessageId(body: unknown): string | null {
  if (typeof body !== "object" || body === null || !("result" in body)) {
    return null;
  }
  const result = body.result;
  if (
    typeof result !== "object" ||
    result === null ||
    !("message_id" in result)
  ) {
    return null;
  }
  const id = result.message_id;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
    return null;
  }
  const text = String(id);
  return /^[1-9][0-9]{0,15}$/.test(text) ? text : null;
}

export async function answerCallbackQuery(input: {
  readonly token: string | undefined;
  readonly callbackId: string;
  readonly fetchImpl?: typeof fetch;
}): Promise<void> {
  await postTelegram({
    token: input.token,
    method: "answerCallbackQuery",
    fetchImpl: input.fetchImpl,
    missing: "callback_unavailable",
    failed: "callback_failed",
    body: { callback_query_id: input.callbackId },
  });
}

async function answerJoinQuery(
  input: {
    readonly token: string | undefined;
    readonly fetchImpl?: typeof fetch;
  },
  queryId: string,
  result: "decline" | "queue",
): Promise<void> {
  await postTelegram({
    token: input.token,
    method: "answerChatJoinRequestQuery",
    fetchImpl: input.fetchImpl,
    missing: "decline_unavailable",
    failed: "decline_failed",
    body: {
      chat_join_request_query_id: queryId,
      result,
    },
  });
}

async function postTelegram(input: {
  readonly token: string | undefined;
  readonly method: string;
  readonly body: unknown;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly missing: string;
  readonly failed: string;
}): Promise<unknown> {
  const token = input.token?.trim() ?? "";
  if (token.length === 0) {
    throw new Error(input.missing);
  }
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(
      `https://api.telegram.org/bot${token}/${input.method}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input.body),
      },
    );
  } catch {
    throw new Error(input.failed);
  }
  if (!response.ok) {
    throw new Error(input.failed);
  }
  try {
    return await response.json();
  } catch {
    return null;
  }
}

const minimumRestrictionSeconds = 30;
const maximumRestrictionSeconds = 366 * 24 * 60 * 60;

function restrictionSeconds(durationSeconds: number): number {
  if (!Number.isFinite(durationSeconds)) {
    return minimumRestrictionSeconds;
  }
  const seconds = Math.floor(durationSeconds);
  if (seconds < minimumRestrictionSeconds) {
    return minimumRestrictionSeconds;
  }
  if (seconds > maximumRestrictionSeconds) {
    return maximumRestrictionSeconds;
  }
  return seconds;
}

function silencedUntil(
  target: MuteTarget,
  nowSeconds: () => number,
): {
  readonly chat_id: string | number;
  readonly user_id: string | number;
  readonly permissions: typeof silenced;
  readonly until_date: number;
  readonly use_independent_chat_permissions: true;
} {
  return {
    chat_id: telegramId(target.chatId),
    user_id: telegramId(target.actorId),
    permissions: silenced,
    until_date: nowSeconds() + restrictionSeconds(target.durationSeconds),
    use_independent_chat_permissions: true,
  };
}

function readStanding(body: unknown): MemberStanding {
  const result = memberResult(body);
  const status = result.status;
  if (
    status === "creator" ||
    status === "administrator" ||
    status === "member" ||
    status === "left"
  ) {
    return { status };
  }
  if (status === "kicked") {
    return { status, untilDate: expiry(result) };
  }
  if (status === "restricted") {
    return {
      status,
      inChat: stillInChat(result),
      untilDate: expiry(result),
    };
  }
  throw new Error("member_failed");
}

function memberResult(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || !("result" in body)) {
    throw new Error("member_failed");
  }
  const result = body.result;
  if (typeof result !== "object" || result === null || !("status" in result)) {
    throw new Error("member_failed");
  }
  if (typeof result.status !== "string" || result.status.length === 0) {
    throw new Error("member_failed");
  }
  return result;
}

function expiry(result: Record<string, unknown>): number | null {
  if (!("until_date" in result) || result.until_date === undefined) {
    return null;
  }
  const value = result.until_date;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("member_failed");
  }
  return value === 0 ? null : value;
}

function stillInChat(result: Record<string, unknown>): boolean {
  if (!("is_member" in result) || result.is_member === undefined) {
    return true;
  }
  if (typeof result.is_member !== "boolean") {
    throw new Error("member_failed");
  }
  return result.is_member;
}

function memberStatus(body: unknown): "restricted" | "open" {
  if (typeof body !== "object" || body === null || !("result" in body)) {
    throw new Error("unmute_failed");
  }
  const result = body.result;
  if (typeof result !== "object" || result === null || !("status" in result)) {
    throw new Error("unmute_failed");
  }
  if (result.status === "restricted") {
    return "restricted";
  }
  if (typeof result.status === "string" && result.status.length > 0) {
    return "open";
  }
  throw new Error("unmute_failed");
}

function unixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export type { BanTarget, MuteTarget };
