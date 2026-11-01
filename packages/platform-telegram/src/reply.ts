import type { ReplyMessage, ReplyPort } from "@tasb/core";
import { telegramId } from "./ids.js";

export function createTelegramReply(input: {
  readonly token: string | undefined;
  readonly fetchImpl?: typeof fetch;
}): ReplyPort {
  return {
    async send(message) {
      const token = input.token?.trim() ?? "";
      if (token.length === 0) {
        throw new Error("reply_unavailable");
      }
      const response = await (input.fetchImpl ?? fetch)(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: telegramId(message.chatId),
            text: message.text.slice(0, 4096),
            link_preview_options: { is_disabled: true },
          }),
        },
      );
      if (!response.ok) {
        throw new Error("reply_failed");
      }
    },
  };
}

export type { ReplyMessage };
