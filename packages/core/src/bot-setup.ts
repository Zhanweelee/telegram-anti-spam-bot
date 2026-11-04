import type { Event } from "./event.js";
import { translate } from "./messages.js";
import type { ReplyMessage } from "./reply.js";

const targetId = /^-?\d{1,20}$/;

/** One private note when this bot is in the chat and cannot moderate. */
export function botSetupNotice(
  event: Event,
  locale?: string,
): ReplyMessage | null {
  if (event.kind !== "bot_membership") {
    return null;
  }
  if (!targetId.test(event.chatId) || !targetId.test(event.actor.id)) {
    return null;
  }
  const key = noticeKey(event);
  if (!key) {
    return null;
  }
  return {
    tenantId: event.tenantId,
    chatId: event.actor.id,
    text: translate(locale ?? "zh", key, { chatId: event.chatId }),
  };
}

function noticeKey(event: Event): string | null {
  if (event.bot === "admin") {
    const canDelete = event.botDelete;
    const canRestrict = event.botRestrict;
    if (canDelete === undefined || canRestrict === undefined) {
      return null;
    }
    if (canDelete === "on" && canRestrict === "on") {
      return null;
    }
    if (canDelete === "off" && canRestrict === "off") {
      return "bot.setup.both";
    }
    if (canDelete === "off") {
      return "bot.setup.delete";
    }
    return "bot.setup.restrict";
  }
  if (event.bot === "gone" && event.botSeat === "in") {
    return "bot.setup.present";
  }
  return null;
}
