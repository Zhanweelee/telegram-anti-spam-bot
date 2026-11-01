import {
  type Event,
  type ForwardKind,
  type MediaKind,
  parseEvent,
} from "@tasb/core";
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
  if (Object.hasOwn(input.update, "my_chat_member")) {
    return botMembershipEvent(input.update.my_chat_member, updateId, input);
  }
  if (Object.hasOwn(input.update, "chat_member")) {
    return await chatMemberEvent(input.update.chat_member, updateId, input);
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
  const forward = forwardKind(message);
  const links = linkHosts(message);
  const media = await mediaMark(message);
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
      ...(forward ? { forward } : {}),
      ...(links.hosts.length > 0 ? { hosts: links.hosts } : {}),
      ...(links.invites.length > 0 ? { invites: links.invites } : {}),
      ...(isRecord(message.contact) ? { contact: true as const } : {}),
      ...(isRecord(message.via_bot) ? { via: true as const } : {}),
      ...(media ? { media: media.kind } : {}),
      ...(media?.sha256 ? { mediaSha256: media.sha256 } : {}),
    },
  });
}

function forwardKind(
  message: Record<string, unknown>,
): ForwardKind | undefined {
  const origin = message.forward_origin;
  if (isRecord(origin)) {
    switch (origin.type) {
      case "channel":
        return "channel";
      case "chat":
        return "chat";
      case "hidden_user":
        return "hidden";
      case "user":
        return "user";
      default:
        break;
    }
  }
  if (
    typeof message.forward_sender_name === "string" &&
    message.forward_sender_name.length > 0
  ) {
    return "hidden";
  }
  if (isRecord(message.forward_from_chat)) {
    return message.forward_from_chat.type === "channel" ? "channel" : "chat";
  }
  if (isRecord(message.forward_from)) {
    return "user";
  }
  return undefined;
}

/**
 * The actor is the member whose status changed (`new_chat_member.user`),
 * not `from`. `from` is whoever performed the action, often an admin.
 */
async function chatMemberEvent(
  value: unknown,
  updateId: number,
  input: NormalizeInput,
): Promise<NormalizeOutcome> {
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
  const botJoin = joiningBot(value);
  const membership = joiningMember(value) ? ("join" as const) : undefined;
  const profile =
    membership && isRecord(value.new_chat_member.user)
      ? await joinProfile(value.new_chat_member.user)
      : undefined;
  const configured = admins.has(actor);
  return finish({
    id: `tg_${updateId}`,
    tenantId: input.tenantId,
    chatId,
    kind: "chat_member" as const,
    occurredAt: occurredAt(value.date, input.nowIso),
    actor: {
      id: actor,
      isAdmin: botJoin
        ? configured
        : status === "administrator" || status === "creator" || configured,
      ...(botJoin ? { bot: true as const } : {}),
    },
    ...(direct ? { direct: true } : {}),
    ...(membership ? { membership } : {}),
    ...(profile ? { profile } : {}),
  });
}

async function joinProfile(
  user: Record<string, unknown>,
): Promise<{ readonly text: string; readonly textSha256: string } | undefined> {
  const parts: string[] = [];
  for (const key of ["first_name", "last_name", "username"]) {
    const value = user[key];
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      parts.push(trimmed);
    }
  }
  if (parts.length === 0) {
    return undefined;
  }
  const text = parts.join(" ").slice(0, 256);
  return { text, textSha256: await sha256Hex(text) };
}

function botMembershipEvent(
  value: unknown,
  updateId: number,
  input: NormalizeInput,
): NormalizeOutcome {
  if (!isRecord(value) || !isGroupChat(value.chat)) {
    return { status: "ignored" };
  }
  if (!isRecord(value.new_chat_member)) {
    return { status: "ignored" };
  }
  const state = botState(value.new_chat_member.status);
  const chatId = nestedId(value.chat);
  const actor = nestedId(value.from);
  if (!state || !chatId || !actor) {
    return { status: "ignored" };
  }
  const admins = new Set(input.adminUserIds);
  return finish({
    id: `tg_${updateId}`,
    tenantId: input.tenantId,
    chatId,
    kind: "bot_membership" as const,
    occurredAt: occurredAt(value.date, input.nowIso),
    actor: { id: actor, isAdmin: admins.has(actor) },
    bot: state,
  });
}

function botState(status: unknown): "admin" | "gone" | null {
  if (status === "administrator" || status === "creator") {
    return "admin";
  }
  if (
    status === "left" ||
    status === "kicked" ||
    status === "member" ||
    status === "restricted"
  ) {
    return "gone";
  }
  return null;
}

function isGroupChat(chat: unknown): boolean {
  return (
    isRecord(chat) && (chat.type === "group" || chat.type === "supergroup")
  );
}

function joiningBot(value: Record<string, unknown>): boolean {
  if (!isRecord(value.new_chat_member)) {
    return false;
  }
  const user = value.new_chat_member.user;
  if (!isRecord(user) || user.is_bot !== true) {
    return false;
  }
  const status = value.new_chat_member.status;
  if (
    status !== "member" &&
    status !== "restricted" &&
    status !== "administrator"
  ) {
    return false;
  }
  if (!isRecord(value.old_chat_member)) {
    return true;
  }
  const previous = value.old_chat_member.status;
  return previous === "left" || previous === "kicked" || previous === undefined;
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

const MAX_LINK = 2048;
const MAX_HOSTS = 8;

function linkHosts(message: Record<string, unknown>): {
  hosts: string[];
  invites: string[];
} {
  const hosts: string[] = [];
  const invites: string[] = [];
  const seenHosts = new Set<string>();
  const seenInvites = new Set<string>();
  for (const list of [message.entities, message.caption_entities]) {
    if (!Array.isArray(list)) {
      continue;
    }
    for (const entity of list) {
      if (!isRecord(entity) || entity.type !== "text_link") {
        continue;
      }
      const link = hostFromUrl(entity.url);
      if (!link) {
        continue;
      }
      if (!seenHosts.has(link.host) && hosts.length < MAX_HOSTS) {
        seenHosts.add(link.host);
        hosts.push(link.host);
      }
      if (
        link.invite &&
        !seenInvites.has(link.host) &&
        invites.length < MAX_HOSTS
      ) {
        seenInvites.add(link.host);
        invites.push(link.host);
      }
    }
  }
  return { hosts, invites };
}

function hostFromUrl(value: unknown): { host: string; invite: boolean } | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_LINK
  ) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (
    host.length === 0 ||
    host.length > 253 ||
    host.includes(":") ||
    host.includes("..") ||
    host.startsWith(".") ||
    host.endsWith(".") ||
    !/^[a-z0-9.-]+$/.test(host)
  ) {
    return null;
  }
  const path = url.pathname.replace(/\/+$/, "") || "/";
  return { host, invite: isTelegramInvite(host, path) };
}

function isTelegramInvite(host: string, path: string): boolean {
  const telegram =
    host === "t.me" ||
    host.endsWith(".t.me") ||
    host === "telegram.me" ||
    host.endsWith(".telegram.me") ||
    host === "telegram.dog" ||
    host.endsWith(".telegram.dog");
  if (!telegram) {
    return false;
  }
  return (
    /^\/\+[A-Za-z0-9_-]{1,128}$/.test(path) ||
    /^\/joinchat\/[A-Za-z0-9_-]{1,128}$/.test(path) ||
    /^\/addlist\/[A-Za-z0-9_-]{1,128}$/.test(path)
  );
}

const mediaFields = [
  ["sticker", "sticker"],
  ["animation", "animation"],
  ["video", "video"],
  ["video_note", "video_note"],
  ["voice", "voice"],
  ["audio", "audio"],
  ["document", "document"],
  ["photo", "photo"],
] as const;

async function mediaMark(
  message: Record<string, unknown>,
): Promise<{ readonly kind: MediaKind; readonly sha256?: string } | undefined> {
  for (const [field, kind] of mediaFields) {
    const value = message[field];
    if (field === "photo") {
      if (!Array.isArray(value) || value.length === 0) {
        continue;
      }
      const id = uniqueId(value[value.length - 1]);
      return id
        ? { kind, sha256: await sha256Hex(`${kind}\n${id}`) }
        : { kind };
    }
    if (!isRecord(value)) {
      continue;
    }
    const id = uniqueId(value);
    return id ? { kind, sha256: await sha256Hex(`${kind}\n${id}`) } : { kind };
  }
  return undefined;
}

function uniqueId(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = value.file_unique_id;
  if (typeof id !== "string" || id.length === 0 || id.length > 256) {
    return undefined;
  }
  return id;
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
