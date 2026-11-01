import {
  type Event,
  type ForwardKind,
  foldEncodedAlphabet,
  foldEncodedGaps,
  foldEncodedSeparators,
  foldMatchText,
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
  const urls: unknown[] = [];
  const poll = message.poll;
  const checklist = message.checklist;
  const lists = [message.entities, message.caption_entities];
  if (isRecord(poll)) {
    lists.push(poll.question_entities);
  }
  if (isRecord(checklist)) {
    lists.push(checklist.title_entities);
  }
  const quote = message.quote;
  if (
    messageText(message, false).length === 0 &&
    isRecord(quote) &&
    quote.is_manual === true &&
    typeof quote.text === "string" &&
    quote.text.length > 0
  ) {
    lists.push(quote.entities);
  }
  for (const list of lists) {
    if (!Array.isArray(list)) {
      continue;
    }
    for (const entity of list) {
      if (isRecord(entity) && entity.type === "text_link") {
        urls.push(entity.url);
      }
    }
  }
  for (const url of buttonUrls(message)) {
    urls.push(url);
  }
  for (const url of richUrls(message)) {
    urls.push(url);
  }
  for (const url of sideUrls(message)) {
    urls.push(url);
  }
  for (const url of urls) {
    const link = hostFromUrl(url);
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
  return { hosts, invites };
}

const COPY_URL =
  /(?:https?:\/\/|www\.)[^\s<>"']+|\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s<>"']*)?/gi;

function urlsInText(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(new RegExp(COPY_URL.source, "gi"))) {
    const raw = match[0]?.replace(/[),.;!?]+$/g, "");
    if (!raw) {
      continue;
    }
    found.push(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`);
  }
  return found;
}

function sideUrls(message: Record<string, unknown>): string[] {
  const urls: string[] = [];
  const poll = message.poll;
  if (isRecord(poll)) {
    pushPlainUrls(poll.question, urls);
    if (Array.isArray(poll.options)) {
      for (const option of poll.options) {
        if (!isRecord(option)) {
          continue;
        }
        pushPlainUrls(option.text, urls);
        pushTextLinks(option.text_entities, urls);
      }
    }
    pushPlainUrls(poll.explanation, urls);
    pushTextLinks(poll.explanation_entities, urls);
    pushPlainUrls(poll.description, urls);
    pushTextLinks(poll.description_entities, urls);
  }
  for (const field of ["giveaway", "giveaway_winners"]) {
    const value = message[field];
    if (isRecord(value)) {
      pushPlainUrls(value.prize_description, urls);
    }
  }
  const checklist = message.checklist;
  if (isRecord(checklist)) {
    pushPlainUrls(checklist.title, urls);
    if (Array.isArray(checklist.tasks)) {
      for (const task of checklist.tasks) {
        if (!isRecord(task)) {
          continue;
        }
        pushPlainUrls(task.text, urls);
        pushTextLinks(task.text_entities, urls);
      }
    }
  }
  const game = message.game;
  if (isRecord(game)) {
    pushPlainUrls(game.title, urls);
    pushPlainUrls(game.description, urls);
    pushPlainUrls(game.text, urls);
    pushTextLinks(game.text_entities, urls);
  }
  const invoice = message.invoice;
  if (isRecord(invoice)) {
    pushPlainUrls(invoice.title, urls);
    pushPlainUrls(invoice.description, urls);
  }
  const venue = message.venue;
  if (isRecord(venue)) {
    pushPlainUrls(venue.title, urls);
    pushPlainUrls(venue.address, urls);
  }
  for (const field of ["animation", "video", "audio", "document"]) {
    const value = message[field];
    if (!isRecord(value)) {
      continue;
    }
    if (field === "audio") {
      pushPlainUrls(value.title, urls);
    }
    pushPlainUrls(value.file_name, urls);
  }
  const quote = message.quote;
  if (isRecord(quote) && quote.is_manual === true) {
    pushPlainUrls(quote.text, urls);
    pushTextLinks(quote.entities, urls);
  }
  for (const field of ["gift", "unique_gift", "gift_upgrade_sent"]) {
    const value = message[field];
    if (!isRecord(value)) {
      continue;
    }
    pushPlainUrls(value.text, urls);
    pushTextLinks(value.entities, urls);
  }
  for (const field of ["forum_topic_created", "forum_topic_edited"]) {
    const value = message[field];
    if (!isRecord(value)) {
      continue;
    }
    pushPlainUrls(value.name, urls);
  }
  const preview = message.link_preview_options;
  if (isRecord(preview) && typeof preview.url === "string") {
    urls.push(preview.url);
  }
  return urls;
}

function pushPlainUrls(value: unknown, urls: string[]): void {
  if (typeof value !== "string") {
    return;
  }
  for (const url of urlsInText(value)) {
    urls.push(url);
  }
}

function pushTextLinks(list: unknown, urls: string[]): void {
  if (!Array.isArray(list)) {
    return;
  }
  for (const entity of list) {
    if (
      isRecord(entity) &&
      entity.type === "text_link" &&
      typeof entity.url === "string"
    ) {
      urls.push(entity.url);
    }
  }
}

function buttonUrls(message: Record<string, unknown>): unknown[] {
  const markup = message.reply_markup;
  if (!isRecord(markup) || !Array.isArray(markup.inline_keyboard)) {
    return [];
  }
  const urls: unknown[] = [];
  for (const row of markup.inline_keyboard) {
    if (!Array.isArray(row)) {
      continue;
    }
    for (const button of row) {
      if (!isRecord(button)) {
        continue;
      }
      if (typeof button.text === "string") {
        for (const url of urlsInText(button.text)) {
          urls.push(url);
        }
      }
      if (typeof button.url === "string") {
        urls.push(button.url);
      }
      const copied = button.copy_text;
      if (isRecord(copied) && typeof copied.text === "string") {
        for (const url of urlsInText(copied.text)) {
          urls.push(url);
        }
      }
      const login = button.login_url;
      if (isRecord(login) && typeof login.url === "string") {
        urls.push(login.url);
      }
      const app = button.web_app;
      if (isRecord(app) && typeof app.url === "string") {
        urls.push(app.url);
      }
    }
  }
  return urls;
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
    url = new URL(
      foldEncodedAlphabet(
        foldEncodedSeparators(foldMatchText(foldEncodedGaps(value))),
      ),
    );
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

function richBody(message: Record<string, unknown>): string {
  const read = readRich(message);
  return read.text;
}

function richUrls(message: Record<string, unknown>): string[] {
  return readRich(message).urls;
}

function readRich(message: Record<string, unknown>): {
  text: string;
  urls: string[];
} {
  const rich = message.rich_message;
  if (!isRecord(rich)) {
    return { text: "", urls: [] };
  }
  const parts: string[] = [];
  const labels: string[] = [];
  const urls: string[] = [];
  walkBlocks(rich.blocks, parts, labels, urls);
  const body = parts.join(" ");
  const text = body.length > 0 ? body : labels.join(" ");
  return { text: text.slice(0, MAX_TEXT), urls };
}

function walkBlocks(
  value: unknown,
  parts: string[],
  labels: string[],
  urls: string[],
): void {
  if (!Array.isArray(value)) {
    return;
  }
  for (const block of value) {
    if (!isRecord(block)) {
      continue;
    }
    if (block.type === "buttons" && Array.isArray(block.buttons)) {
      for (const button of block.buttons) {
        const label = richButton(button, urls);
        if (label.length > 0) {
          labels.push(label);
        }
      }
      continue;
    }
    if (block.type === "list" && Array.isArray(block.items)) {
      for (const item of block.items) {
        if (!isRecord(item)) {
          continue;
        }
        if (typeof item.label === "string" && item.label.length > 0) {
          parts.push(item.label);
        }
        walkBlocks(item.blocks, parts, labels, urls);
      }
      continue;
    }
    if (block.type === "table" && Array.isArray(block.cells)) {
      for (const row of block.cells) {
        if (!Array.isArray(row)) {
          continue;
        }
        for (const cell of row) {
          if (!isRecord(cell)) {
            continue;
          }
          const text = richText(cell.text, urls);
          if (text.length > 0) {
            parts.push(text);
          }
        }
      }
      pushRich(richText(block.caption, urls), parts);
      continue;
    }
    if (block.type === "details") {
      pushRich(richText(block.summary, urls), parts);
      walkBlocks(block.blocks, parts, labels, urls);
      continue;
    }
    if (
      block.type === "blockquote" ||
      block.type === "collage" ||
      block.type === "slideshow"
    ) {
      walkBlocks(block.blocks, parts, labels, urls);
      pushRich(richText(block.credit, urls), parts);
      pushCaption(block.caption, parts, urls);
      continue;
    }
    if (
      block.type === "paragraph" ||
      block.type === "heading" ||
      block.type === "pre" ||
      block.type === "footer" ||
      block.type === "expandable_blockquote" ||
      block.type === "pullquote" ||
      block.type === "thinking"
    ) {
      pushRich(richText(block.text, urls), parts);
      pushRich(richText(block.credit, urls), parts);
      continue;
    }
    pushCaption(block.caption, parts, urls);
  }
}

function pushRich(text: string, parts: string[]): void {
  if (text.length > 0) {
    parts.push(text);
  }
}

function pushCaption(caption: unknown, parts: string[], urls: string[]): void {
  if (!isRecord(caption)) {
    return;
  }
  pushRich(richText(caption.text, urls), parts);
  pushRich(richText(caption.credit, urls), parts);
}

function richText(value: unknown, urls: string[]): string {
  if (typeof value === "string") {
    for (const url of urlsInText(value)) {
      urls.push(url);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => richText(item, urls)).join("");
  }
  if (!isRecord(value)) {
    return "";
  }
  if (value.type === "url" && typeof value.url === "string") {
    urls.push(value.url);
  }
  if (value.type === "button") {
    return richButton(value.button, urls);
  }
  if ("text" in value) {
    return richText(value.text, urls);
  }
  return "";
}

function richButton(value: unknown, urls: string[]): string {
  if (!isRecord(value)) {
    return "";
  }
  if (typeof value.url === "string") {
    urls.push(value.url);
  }
  const copied = value.copy_text;
  if (isRecord(copied) && typeof copied.text === "string") {
    for (const url of urlsInText(copied.text)) {
      urls.push(url);
    }
  }
  const login = value.login_url;
  if (isRecord(login) && typeof login.url === "string") {
    urls.push(login.url);
  }
  const app = value.web_app;
  if (isRecord(app) && typeof app.url === "string") {
    urls.push(app.url);
  }
  return richText(value.text, urls);
}

function messageText(
  message: Record<string, unknown>,
  includeQuote = true,
): string {
  if (typeof message.text === "string" && message.text.length > 0) {
    return message.text.slice(0, MAX_TEXT);
  }
  if (typeof message.caption === "string" && message.caption.length > 0) {
    return message.caption.slice(0, MAX_TEXT);
  }
  const rich = richBody(message);
  if (rich.length > 0) {
    return rich;
  }
  const poll = message.poll;
  if (
    isRecord(poll) &&
    typeof poll.question === "string" &&
    poll.question.length > 0
  ) {
    return poll.question.slice(0, MAX_TEXT);
  }
  for (const field of ["giveaway", "giveaway_winners"]) {
    const value = message[field];
    if (
      isRecord(value) &&
      typeof value.prize_description === "string" &&
      value.prize_description.length > 0
    ) {
      return value.prize_description.slice(0, MAX_TEXT);
    }
  }
  const checklist = message.checklist;
  if (
    isRecord(checklist) &&
    typeof checklist.title === "string" &&
    checklist.title.length > 0
  ) {
    return checklist.title.slice(0, MAX_TEXT);
  }
  for (const field of ["game", "invoice", "venue"]) {
    const value = message[field];
    if (
      isRecord(value) &&
      typeof value.title === "string" &&
      value.title.length > 0
    ) {
      return value.title.slice(0, MAX_TEXT);
    }
  }
  const label = mediaLabel(message);
  if (label.length > 0) {
    return label;
  }
  const buttons = buttonLabel(message);
  if (buttons.length > 0) {
    return buttons;
  }
  const quote = message.quote;
  if (
    includeQuote &&
    isRecord(quote) &&
    quote.is_manual === true &&
    typeof quote.text === "string" &&
    quote.text.length > 0
  ) {
    return quote.text.slice(0, MAX_TEXT);
  }
  const gift = giftText(message);
  if (gift.length > 0) {
    return gift;
  }
  const topic = topicName(message);
  if (topic.length > 0) {
    return topic;
  }
  return "";
}

function topicName(message: Record<string, unknown>): string {
  for (const field of ["forum_topic_created", "forum_topic_edited"]) {
    const value = message[field];
    if (
      isRecord(value) &&
      typeof value.name === "string" &&
      value.name.length > 0
    ) {
      return value.name.slice(0, MAX_TEXT);
    }
  }
  return "";
}

function giftText(message: Record<string, unknown>): string {
  for (const field of ["gift", "unique_gift", "gift_upgrade_sent"]) {
    const value = message[field];
    if (
      isRecord(value) &&
      typeof value.text === "string" &&
      value.text.length > 0
    ) {
      return value.text.slice(0, MAX_TEXT);
    }
  }
  return "";
}

function buttonLabel(message: Record<string, unknown>): string {
  const markup = message.reply_markup;
  if (!isRecord(markup) || !Array.isArray(markup.inline_keyboard)) {
    return "";
  }
  const parts: string[] = [];
  for (const row of markup.inline_keyboard) {
    if (!Array.isArray(row)) {
      continue;
    }
    for (const button of row) {
      if (!isRecord(button) || typeof button.text !== "string") {
        continue;
      }
      if (button.text.length === 0) {
        continue;
      }
      parts.push(button.text);
    }
  }
  if (parts.length === 0) {
    return "";
  }
  return parts.join(" ").slice(0, MAX_TEXT);
}

function mediaLabel(message: Record<string, unknown>): string {
  for (const field of ["animation", "video", "audio", "document"]) {
    const value = message[field];
    if (!isRecord(value)) {
      continue;
    }
    if (
      field === "audio" &&
      typeof value.title === "string" &&
      value.title.length > 0
    ) {
      return value.title.slice(0, MAX_TEXT);
    }
    if (typeof value.file_name === "string" && value.file_name.length > 0) {
      return value.file_name.slice(0, MAX_TEXT);
    }
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
