import type { BanTarget, ModerationPort, MuteTarget } from "@tasb/core";
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
  can_invite_users: true,
};

export const captchaPrompt = "请点击按钮，确认你不是机器人。";

export function createTelegramModerator(input: {
  readonly token: string | undefined;
  readonly fetchImpl?: typeof fetch;
  readonly nowSeconds?: () => number;
}): ModerationPort {
  return {
    async deleteMessage() {},
    async muteActor() {},
    async banActor() {},
    async restrictActor(target) {
      const until =
        (input.nowSeconds ?? unixSeconds)() + target.durationSeconds;
      await postTelegram({
        token: input.token,
        method: "restrictChatMember",
        fetchImpl: input.fetchImpl,
        missing: "restrict_unavailable",
        failed: "restrict_failed",
        body: {
          chat_id: telegramId(target.chatId),
          user_id: telegramId(target.actorId),
          permissions: silenced,
          until_date: until,
          use_independent_chat_permissions: true,
        },
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
}): Promise<void> {
  if (!/^[a-f0-9]{16}$/.test(input.nonce)) {
    throw new Error("captcha_prompt_failed");
  }
  await postTelegram({
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

async function postTelegram(input: {
  readonly token: string | undefined;
  readonly method: string;
  readonly body: unknown;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly missing: string;
  readonly failed: string;
}): Promise<void> {
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
}

function unixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export type { BanTarget, MuteTarget };
