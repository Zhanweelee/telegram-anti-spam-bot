import { type Event, parseEvent } from "@tasb/core";
import { sha256Hex } from "./hash.js";

const MAX_TEXT = 4096;

export interface NormalizeInput {
  readonly update: unknown;
  readonly tenantId: string;
  readonly adminUserIds: readonly string[];
  readonly nowIso: string;
}

export type NormalizeOutcome =
  | { readonly status: "event"; readonly event: Event }
  | { readonly status: "ignored" }
  | { readonly status: "invalid" };

export async function normalizeUpdate(
  input: NormalizeInput,
): Promise<NormalizeOutcome> {
  if (!isRecord(input.update)) {
    return { status: "invalid" };
  }
  const updateId = safeId(input.update.update_id);
  if (updateId === null || updateId < 0) {
    return { status: "invalid" };
  }
  if (Object.hasOwn(input.update, "callback_query")) {
    return callbackEvent(input.update.callback_query, updateId, input);
  }
  if (Object.hasOwn(input.update, "chat_member")) {
    return chatMemberEvent(input.update.chat_member, updateId, input);
  }
  if (Object.hasOwn(input.update, "edited_message")) {
    return messageEvent(input.update.edited_message, updateId, input, true);
  }
  if (!Object.hasOwn(input.update, "message")) {
    return { status: "ignored" };
  }
  return messageEvent(input.update.message, updateId, input, false);
}

function callbackEvent(
  value: unknown,
  updateId: number,
  input: NormalizeInput,
): NormalizeOutcome {
  if (!isRecord(value) || typeof value.data !== "string") {
    return { status: "ignored" };
  }
  const matched = /^c:([a-f0-9]{16})$/.exec(value.data);
  const nonce = matched?.[1];
  if (!nonce) {
    return { status: "ignored" };
  }
  const actor = nestedId(value.from);
  const message = isRecord(value.message) ? value.message : null;
  const chatId = message ? nestedId(message.chat) : null;
  if (!actor || !chatId) {
    return { status: "ignored" };
  }
  const admins = new Set(input.adminUserIds);
  return finish({
    id: `tg_${updateId}`,
    tenantId: input.tenantId,
    chatId,
    kind: "challenge" as const,
    occurredAt: occurredAt(message?.date, input.nowIso),
    actor: { id: actor, isAdmin: admins.has(actor) },
    challenge: { nonce },
  });
}

async function messageEvent(
  message: unknown,
  updateId: number,
  input: NormalizeInput,
  edited: boolean,
): Promise<NormalizeOutcome> {
  if (!isRecord(message)) {
    return { status: "ignored" };
  }
  const chatId = nestedId(message.chat);
  const messageId = idString(message.message_id);
  const actor = nestedId(message.from) ?? nestedId(message.sender_chat);
  if (!chatId || !messageId || !actor) {
    return { status: "ignored" };
  }
  const text = messageText(message);
  const direct = isPrivateChat(message.chat);
  return finish({
    id: `tg_${updateId}`,
    tenantId: input.tenantId,
    chatId,
    kind: "message" as const,
    occurredAt: occurredAt(message.date, input.nowIso),
    actor: {
      id: actor,
      isAdmin: actorIsAdmin(message, new Set(input.adminUserIds)),
    },
    ...(direct ? { direct: true } : {}),
    ...(edited ? { edited: true as const } : {}),
    message: {
      id: messageId,
      text,
      textSha256: await sha256Hex(text),
    },
  });
}

/**
 * The actor is the member whose status changed (`new_chat_member.user`),
 * not `from`. `from` is whoever performed the action, often an admin.
 */
function chatMemberEvent(
  value: unknown,
  updateId: number,
  input: NormalizeInput,
): NormalizeOutcome {
  if (!isRecord(value) || !isRecord(value.new_chat_member)) {
    return { status: "ignored" };
  }
  const chatId = nestedId(value.chat);
  const actor = nestedId(value.new_chat_member.user);
  if (!chatId || !actor) {
    return { status: "ignored" };
  }
  const status = value.new_chat_member.status;
  const admins = new Set(input.adminUserIds);
  const direct = isPrivateChat(value.chat);
  const membership = joiningMember(value) ? ("join" as const) : undefined;
  return finish({
    id: `tg_${updateId}`,
    tenantId: input.tenantId,
    chatId,
    kind: "chat_member" as const,
    occurredAt: occurredAt(value.date, input.nowIso),
    actor: {
      id: actor,
      isAdmin:
        status === "administrator" || status === "creator" || admins.has(actor),
    },
    ...(direct ? { direct: true } : {}),
    ...(membership ? { membership } : {}),
  });
}

function joiningMember(value: Record<string, unknown>): boolean {
  if (!isRecord(value.new_chat_member)) {
    return false;
  }
  const user = value.new_chat_member.user;
  if (isRecord(user) && user.is_bot === true) {
    return false;
  }
  const status = value.new_chat_member.status;
  if (status !== "member" && status !== "restricted") {
    return false;
  }
  if (!isRecord(value.old_chat_member)) {
    return true;
  }
  const previous = value.old_chat_member.status;
  return previous === "left" || previous === "kicked" || previous === undefined;
}

function isPrivateChat(chat: unknown): boolean {
  return isRecord(chat) && chat.type === "private";
}

function finish(draft: unknown): NormalizeOutcome {
  try {
    return { status: "event", event: parseEvent(draft) };
  } catch {
    return { status: "ignored" };
  }
}

function messageText(message: Record<string, unknown>): string {
  if (typeof message.text === "string" && message.text.length > 0) {
    return message.text.slice(0, MAX_TEXT);
  }
  if (typeof message.caption === "string" && message.caption.length > 0) {
    return message.caption.slice(0, MAX_TEXT);
  }
  return "";
}

function occurredAt(date: unknown, nowIso: string): string {
  if (typeof date !== "number" || !Number.isFinite(date)) {
    return nowIso;
  }
  const iso = new Date(date * 1000).toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(iso)) {
    return nowIso;
  }
  return iso;
}

function actorIsAdmin(
  message: Record<string, unknown>,
  admins: ReadonlySet<string>,
): boolean {
  const from = nestedId(message.from);
  if (from !== null && admins.has(from)) {
    return true;
  }
  const chat = nestedId(message.chat);
  const sender = nestedId(message.sender_chat);
  return chat !== null && sender !== null && chat === sender;
}

function nestedId(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  return idString(value.id);
}

function idString(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return String(value);
  }
  if (typeof value === "string" && value.length > 0 && value.length <= 128) {
    return value;
  }
  return null;
}

function safeId(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return value;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
