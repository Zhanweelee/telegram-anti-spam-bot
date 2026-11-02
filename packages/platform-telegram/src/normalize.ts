import {
  type Event,
  type ForwardKind,
  foldBracketDots,
  foldCyrillicLookalikes,
  foldDotLookalikes,
  foldEncodedAlphabet,
  foldEncodedGaps,
  foldEncodedMiddleDot,
  foldEncodedSeparators,
  foldFullwidthLatin,
  foldHostInterrupters,
  foldHostScan,
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
  if (Object.hasOwn(input.update, "chat_join_request")) {
    return joinRequestEvent(input.update.chat_join_request, updateId, input);
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
  const audienceId = positiveId(nestedId(message.receiver_user));
  const ephemeralId = positiveId(message.ephemeral_message_id);
  const messageId =
    ephemeralId !== null && audienceId !== null
      ? ephemeralId
      : idString(message.message_id);
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
      ...(ephemeralId !== null && audienceId !== null ? { audienceId } : {}),
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

async function joinRequestEvent(
  value: unknown,
  updateId: number,
  input: NormalizeInput,
): Promise<NormalizeOutcome> {
  if (!isRecord(value)) {
    return { status: "ignored" };
  }
  const chatId = nestedId(value.chat);
  const actor = nestedId(value.from);
  if (!chatId || !actor) {
    return { status: "ignored" };
  }
  const profile = await requestBio(value.bio);
  const direct = isPrivateChat(value.chat);
  return finish({
    id: `tg_${updateId}`,
    tenantId: input.tenantId,
    chatId,
    kind: "join_request" as const,
    occurredAt: occurredAt(value.date, input.nowIso),
    actor: { id: actor, isAdmin: new Set(input.adminUserIds).has(actor) },
    ...(direct ? { direct: true } : {}),
    ...(profile ? { profile } : {}),
  });
}

async function requestBio(
  value: unknown,
): Promise<{ readonly text: string; readonly textSha256: string } | undefined> {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const text = trimmed.slice(0, 256);
  return { text, textSha256: await sha256Hex(text) };
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
      if (!isRecord(entity)) {
        continue;
      }
      if (entity.type === "text_link") {
        urls.push(entity.url);
      }
      for (const found of preLanguageUrls(entity)) {
        urls.push(found);
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
    for (const extra of link.extras ?? []) {
      if (!seenHosts.has(extra.host) && hosts.length < MAX_HOSTS) {
        seenHosts.add(extra.host);
        hosts.push(extra.host);
      }
      if (
        extra.invite &&
        !seenInvites.has(extra.host) &&
        invites.length < MAX_HOSTS
      ) {
        seenInvites.add(extra.host);
        invites.push(extra.host);
      }
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
  /(?:https?:\/\/|tg:(?:\/\/)?|www\.)[^\s<>"']+|\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s<>"']*)?/gi;

function urlsInText(text: string): string[] {
  const found: string[] = [];
  const folded = foldHostScan(text);
  for (const match of folded.matchAll(new RegExp(COPY_URL.source, "gi"))) {
    const raw = match[0]?.replace(/[),.;!?]+$/g, "");
    if (!raw) {
      continue;
    }
    found.push(/^(?:https?|tg):/i.test(raw) ? raw : `http://${raw}`);
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
    pushPollMedia(poll.media, urls);
    pushPollMedia(poll.explanation_media, urls);
    if (Array.isArray(poll.options)) {
      for (const option of poll.options) {
        if (!isRecord(option)) {
          continue;
        }
        pushPollMedia(option.media, urls);
      }
    }
  }
  for (const field of ["giveaway", "giveaway_winners"]) {
    const value = message[field];
    if (!isRecord(value)) {
      continue;
    }
    pushPlainUrls(value.prize_description, urls);
    if (field === "giveaway" && Array.isArray(value.chats)) {
      for (const chat of value.chats) {
        if (isRecord(chat)) {
          pushPlainUrls(chat.title, urls);
        }
      }
    }
    if (field === "giveaway_winners" && isRecord(value.chat)) {
      pushPlainUrls(value.chat.title, urls);
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
    if (isRecord(game.animation)) {
      pushPlainUrls(game.animation.file_name, urls);
    }
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
      pushPlainUrls(value.file_name, urls);
      pushPlainUrls(value.performer, urls);
      continue;
    }
    pushPlainUrls(value.file_name, urls);
  }
  const paid = message.paid_media;
  if (isRecord(paid) && Array.isArray(paid.paid_media)) {
    for (const item of paid.paid_media) {
      if (!isRecord(item) || !isRecord(item.video)) {
        continue;
      }
      pushPlainUrls(item.video.file_name, urls);
    }
  }
  const origin = message.forward_origin;
  if (isRecord(origin) && origin.type === "hidden_user") {
    pushPlainUrls(origin.sender_user_name, urls);
  }
  pushPlainUrls(message.forward_sender_name, urls);
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
  for (const field of ["poll_option_added", "poll_option_deleted"]) {
    const value = message[field];
    if (!isRecord(value)) {
      continue;
    }
    pushPlainUrls(value.option_text, urls);
    pushTextLinks(value.option_text_entities, urls);
  }
  const addedTasks = message.checklist_tasks_added;
  if (isRecord(addedTasks) && Array.isArray(addedTasks.tasks)) {
    for (const task of addedTasks.tasks) {
      if (!isRecord(task)) {
        continue;
      }
      pushPlainUrls(task.text, urls);
      pushTextLinks(task.text_entities, urls);
    }
  }
  const preview = message.link_preview_options;
  if (isRecord(preview) && typeof preview.url === "string") {
    urls.push(preview.url);
  }
  pushPlainUrls(message.author_signature, urls);
  pushPlainUrls(message.sender_tag, urls);
  const declined = message.suggested_post_declined;
  if (isRecord(declined)) {
    pushPlainUrls(declined.comment, urls);
  }
  pushPlainUrls(message.new_chat_title, urls);
  pushPlainUrls(memberNames(message), urls);
  for (const field of ["community_chat_added", "community_chat_joined"]) {
    const value = message[field];
    if (!isRecord(value)) {
      continue;
    }
    const community = value.community;
    if (isRecord(community)) {
      pushPlainUrls(community.name, urls);
    }
  }
  return urls;
}

function pushPollMedia(media: unknown, urls: string[]): void {
  if (!isRecord(media)) {
    return;
  }
  if (isRecord(media.link) && typeof media.link.url === "string") {
    urls.push(media.link.url);
  }
  for (const field of ["animation", "video", "audio", "document"]) {
    const value = media[field];
    if (!isRecord(value)) {
      continue;
    }
    if (field === "audio") {
      pushPlainUrls(value.title, urls);
      pushPlainUrls(value.file_name, urls);
      pushPlainUrls(value.performer, urls);
      continue;
    }
    pushPlainUrls(value.file_name, urls);
  }
  if (isRecord(media.venue)) {
    pushPlainUrls(media.venue.title, urls);
    pushPlainUrls(media.venue.address, urls);
  }
}

function pushPlainUrls(value: unknown, urls: string[]): void {
  if (typeof value !== "string") {
    return;
  }
  for (const url of urlsInText(value)) {
    urls.push(url);
  }
}

function preLanguageUrls(entity: Record<string, unknown>): string[] {
  if (entity.type !== "pre" || typeof entity.language !== "string") {
    return [];
  }
  return urlsInText(entity.language);
}

function pushTextLinks(list: unknown, urls: string[]): void {
  if (!Array.isArray(list)) {
    return;
  }
  for (const entity of list) {
    if (!isRecord(entity)) {
      continue;
    }
    if (entity.type === "text_link" && typeof entity.url === "string") {
      urls.push(entity.url);
    }
    for (const found of preLanguageUrls(entity)) {
      urls.push(found);
    }
  }
}

function buttonUrls(message: Record<string, unknown>): unknown[] {
  const markup = message.reply_markup;
  if (!isRecord(markup) || !Array.isArray(markup.inline_keyboard)) {
    return [];
  }
  const urls: string[] = [];
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
      pushSwitchInlineQueries(button, urls);
    }
  }
  return urls;
}

function pushSwitchInlineQueries(
  button: Record<string, unknown>,
  urls: string[],
): void {
  pushPlainUrls(button.switch_inline_query, urls);
  pushPlainUrls(button.switch_inline_query_current_chat, urls);
  const chosen = button.switch_inline_query_chosen_chat;
  if (isRecord(chosen)) {
    pushPlainUrls(chosen.query, urls);
  }
}

function hostFromUrl(
  value: unknown,
  unwrap = true,
): {
  host: string;
  invite: boolean;
  extras?: { host: string; invite: boolean }[];
} | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_LINK
  ) {
    return null;
  }
  const folded = foldBracketDots(
    foldEncodedAlphabet(
      foldEncodedSeparators(
        foldMatchText(
          foldDotLookalikes(
            foldEncodedMiddleDot(
              foldHostInterrupters(
                foldFullwidthLatin(
                  foldCyrillicLookalikes(foldEncodedGaps(value)),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  let url: URL;
  try {
    url = new URL(folded);
  } catch {
    return null;
  }
  const deep = telegramDeepInvite(url);
  if (deep) {
    return deep;
  }
  const proxy = proxyServerHost(url);
  const wrapped = unwrap
    ? [
        ...wrappedExtras(folded, url),
        ...msgTextExtras(folded, url),
        ...usernameDraftExtras(folded, url),
        ...passportExtras(folded, url),
      ]
    : [];
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    if (proxy !== null) {
      return packHost(proxy, false, wrapped);
    }
    const first = wrapped[0];
    if (!first) {
      return null;
    }
    return packHost(first.host, first.invite, wrapped.slice(1));
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
    if (proxy !== null) {
      return packHost(proxy, false, wrapped);
    }
    const first = wrapped[0];
    if (!first) {
      return null;
    }
    return packHost(first.host, first.invite, wrapped.slice(1));
  }
  const path = url.pathname.replace(/\/+$/, "") || "/";
  return packHost(
    host,
    isTelegramInvite(host, path) || isPercentSpaceInvite(folded, host),
    [
      ...(proxy !== null && proxy !== host
        ? [{ host: proxy, invite: false }]
        : []),
      ...wrapped,
    ],
  );
}

function packHost(
  host: string,
  invite: boolean,
  extras: { host: string; invite: boolean }[],
): {
  host: string;
  invite: boolean;
  extras?: { host: string; invite: boolean }[];
} {
  const useful = extras.filter(
    (item) => item.host !== host || (item.invite && !invite),
  );
  return useful.length > 0
    ? { host, invite, extras: useful }
    : { host, invite };
}

function wrappedExtras(
  folded: string,
  url: URL,
): { host: string; invite: boolean }[] {
  if (!isTelegramShare(url)) {
    return [];
  }
  const found: { host: string; invite: boolean }[] = [];
  const embedded = queryValue(folded, "url");
  if (embedded !== null && embedded.length > 0 && embedded.length <= MAX_LINK) {
    const inner = hostFromUrl(embedded, false);
    if (inner) {
      found.push({ host: inner.host, invite: inner.invite });
      for (const extra of inner.extras ?? []) {
        found.push(extra);
      }
    }
  }
  const text = queryValue(folded, "text");
  if (text !== null && text.length > 0 && text.length <= MAX_TEXT) {
    for (const raw of urlsInText(text)) {
      const inner = hostFromUrl(raw, false);
      if (inner) {
        found.push({ host: inner.host, invite: inner.invite });
      }
    }
  }
  return found;
}

function msgTextExtras(
  folded: string,
  url: URL,
): { host: string; invite: boolean }[] {
  if (!isTelegramMsg(url)) {
    return [];
  }
  const found: { host: string; invite: boolean }[] = [];
  const embedded = queryValue(folded, "url");
  if (embedded !== null && embedded.length > 0 && embedded.length <= MAX_LINK) {
    const inner = hostFromUrl(embedded, false);
    if (inner) {
      found.push({ host: inner.host, invite: inner.invite });
      for (const extra of inner.extras ?? []) {
        found.push(extra);
      }
    }
  }
  const text = queryValue(folded, "text");
  if (text === null || text.length === 0 || text.length > MAX_TEXT) {
    return found;
  }
  for (const raw of urlsInText(text)) {
    const inner = hostFromUrl(raw, false);
    if (!inner) {
      continue;
    }
    found.push({ host: inner.host, invite: inner.invite });
    for (const extra of inner.extras ?? []) {
      found.push(extra);
    }
  }
  return found;
}

function passportExtras(
  folded: string,
  url: URL,
): { host: string; invite: boolean }[] {
  const callback = passportCallback(folded, url);
  if (callback === null) {
    return [];
  }
  const inner = hostFromUrl(callback, false);
  if (!inner) {
    return [];
  }
  return [{ host: inner.host, invite: inner.invite }, ...(inner.extras ?? [])];
}

/** 桌面端取消 Passport 时打开 `callback_url`。只留主机名。 */
function passportCallback(raw: string, url: URL): string | null {
  if (!isTelegramPassport(raw, url)) {
    return null;
  }
  const callback = queryValue(raw, "callback_url");
  if (
    callback === null ||
    callback.length === 0 ||
    callback.length > MAX_LINK
  ) {
    return null;
  }
  return callback;
}

function isTelegramPassport(raw: string, url: URL): boolean {
  if (url.protocol === "tg:") {
    const host = url.hostname.toLowerCase();
    const path = url.pathname.replace(/^\/+|\/+$/g, "").toLowerCase();
    const command = host.length > 0 ? host : path;
    if (command === "passport") {
      return host.length === 0 || path.length === 0;
    }
    if (command !== "resolve") {
      return false;
    }
    return searchParam(url, "domain") === "telegrampassport";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return false;
  }
  if (isPassportSubdomain(raw, url)) {
    return true;
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!isExactDraftHost(host)) {
    return false;
  }
  const parts = url.pathname.split("/").filter((part) => part.length > 0);
  return isPassportPath(parts);
}

function isPassportSubdomain(raw: string, url: URL): boolean {
  const shown = /^(?:https?:\/\/)?([^/?#]+)/i.exec(raw)?.[1];
  if (shown === undefined || shown.includes(":") || shown.includes("@")) {
    return false;
  }
  const suffix = ".t.me";
  if (!shown.toLowerCase().endsWith(suffix)) {
    return false;
  }
  const label = shown.slice(0, shown.length - suffix.length);
  if (label !== "telegrampassport") {
    return false;
  }
  const parts = url.pathname.split("/").filter((part) => part.length > 0);
  if (parts.length === 0) {
    return true;
  }
  const only = parts[0];
  return parts.length === 1 && only !== undefined && /^\d{1,16}$/.test(only);
}

function isPassportPath(parts: readonly string[]): boolean {
  if (parts[0] !== "telegrampassport") {
    return false;
  }
  if (parts.length === 1) {
    return true;
  }
  if (parts.length === 2) {
    return /^[A-Za-z0-9._-]{1,128}$/.test(parts[1] ?? "");
  }
  if (parts.length === 3) {
    const mid = (parts[1] ?? "").toLowerCase();
    const last = (parts[2] ?? "").toLowerCase();
    if (mid === "s" && (/^\d{1,16}$/.test(last) || last === "live")) {
      return true;
    }
    if ((mid === "a" || mid === "c") && /^\d{1,16}$/.test(last)) {
      return true;
    }
    return (
      /^\d{1,16}$/.test(parts[1] ?? "") && /^\d{1,16}$/.test(parts[2] ?? "")
    );
  }
  return false;
}

function usernameDraftExtras(
  folded: string,
  url: URL,
): { host: string; invite: boolean }[] {
  if (!isUsernameDraft(url)) {
    return [];
  }
  const text = queryValue(folded, "text");
  if (text === null || text.length === 0 || text.length > MAX_TEXT) {
    return [];
  }
  const found: { host: string; invite: boolean }[] = [];
  for (const raw of urlsInText(text)) {
    const inner = hostFromUrl(raw, false);
    if (!inner) {
      continue;
    }
    found.push({ host: inner.host, invite: inner.invite });
    for (const extra of inner.extras ?? []) {
      found.push(extra);
    }
  }
  return found;
}

function isUsernameDraft(url: URL): boolean {
  if (url.protocol === "tg:") {
    const host = url.hostname.toLowerCase();
    const path = url.pathname.replace(/^\/+|\/+$/g, "").toLowerCase();
    const command = host.length > 0 ? host : path;
    if (command !== "resolve") {
      return false;
    }
    const domain = searchParam(url, "domain");
    if (domain !== null && domain.length > 0) {
      return isPublicUsername(domain);
    }
    const phone = searchParam(url, "phone");
    return phone !== null && /^\+?\d{1,20}$/.test(phone);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return false;
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    !telegramProxyHosts.some(
      (name) => name === host || host.endsWith(`.${name}`),
    )
  ) {
    return false;
  }
  const parts = url.pathname.split("/").filter((part) => part.length > 0);
  if (isUserSubdomain(host) && isUserSubdomainPath(parts)) {
    return true;
  }
  const first = parts[0];
  if (parts.length === 1 && first !== undefined) {
    return isPublicUsername(first) || isTelegramPhoneSegment(host, first);
  }
  const preview = parts[0]?.toLowerCase();
  const name = parts[1];
  if (
    parts.length === 2 &&
    preview === "s" &&
    name !== undefined &&
    isPublicUsername(name)
  ) {
    return true;
  }
  return isUserPostPath(host, parts);
}

function isExactDraftHost(host: string): boolean {
  const bare = host.startsWith("www.") ? host.slice(4) : host;
  return bare === "t.me" || bare === "telegram.me" || bare === "telegram.dog";
}

function isUserSubdomain(host: string): boolean {
  if (!host.endsWith(".t.me")) {
    return false;
  }
  const name = host.slice(0, -".t.me".length);
  return (
    name !== "www" &&
    !name.includes(".") &&
    name.length >= 2 &&
    isPublicUsername(name)
  );
}

function isUserSubdomainPath(parts: readonly string[]): boolean {
  if (parts.length === 0) {
    return true;
  }
  const only = parts[0];
  return parts.length === 1 && only !== undefined && /^\d{1,16}$/.test(only);
}

function isUserPostPath(host: string, parts: readonly string[]): boolean {
  if (!isExactDraftHost(host) || parts.length !== 2) {
    return false;
  }
  const name = parts[0];
  const post = parts[1];
  return (
    name !== undefined &&
    post !== undefined &&
    isPublicUsername(name) &&
    /^\d{1,16}$/.test(post)
  );
}

function isTelegramPhoneSegment(host: string, segment: string): boolean {
  const bare = host.startsWith("www.") ? host.slice(4) : host;
  if (bare !== "t.me" && bare !== "telegram.me" && bare !== "telegram.dog") {
    return false;
  }
  return /^\+\d{1,128}$/.test(segment);
}

function isPublicUsername(value: string): boolean {
  return (
    /^[A-Za-z0-9_]{1,32}$/.test(value) &&
    !reservedUsernames.has(value.toLowerCase())
  );
}

const reservedUsernames = new Set([
  "addemoji",
  "addlist",
  "addstickers",
  "addstyle",
  "addtheme",
  "auction",
  "bg",
  "boost",
  "c",
  "call",
  "confirmphone",
  "contact",
  "folder",
  "getpremium",
  "invoice",
  "iv",
  "joinchat",
  "login",
  "m",
  "msg",
  "newbot",
  "nft",
  "proxy",
  "s",
  "setlanguage",
  "share",
  "socks",
  "stargift_auction",
  "telegrampassport",
  "stargift_preview",
  "web",
  "webproxy",
]);

function isTelegramMsg(url: URL): boolean {
  if (url.protocol !== "tg:") {
    return false;
  }
  const host = url.hostname.toLowerCase();
  const path = url.pathname.replace(/^\/+|\/+$/g, "").toLowerCase();
  const command = host.length > 0 ? host : path;
  return command === "msg";
}

/** 查询名不区分大小写，取第一次出现的值。值保持解析后的样子。 */
function searchParam(url: URL, name: string): string | null {
  const wanted = name.toLowerCase();
  for (const [key, value] of url.searchParams) {
    if (key.toLowerCase() === wanted) {
      return value;
    }
  }
  return null;
}

function queryValue(raw: string, name: string): string | null {
  const match = new RegExp(`[?&]${name}=([^&#]*)`, "i").exec(raw);
  const value = match?.[1];
  if (value === undefined || value.length === 0) {
    return null;
  }
  try {
    return decodeURIComponent(value.replace(/\+/g, "%2B"));
  } catch {
    return null;
  }
}

function isTelegramShare(url: URL): boolean {
  if (url.protocol === "tg:") {
    const host = url.hostname.toLowerCase();
    const path = url.pathname.replace(/^\/+|\/+$/g, "").toLowerCase();
    const command = host.length > 0 ? host : path;
    return command === "msg_url" || command === "share" || command === "iv";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return false;
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    !telegramProxyHosts.some(
      (name) => name === host || host.endsWith(`.${name}`),
    )
  ) {
    return false;
  }
  const path = (url.pathname.replace(/\/+$/, "") || "/").toLowerCase();
  return (
    path === "/share/url" ||
    path === "/share" ||
    path === "/iv" ||
    path === "/msg/url"
  );
}

const telegramProxyHosts = ["t.me", "telegram.me", "telegram.dog"];

function proxyServerHost(url: URL): string | null {
  if (!isTelegramProxy(url)) {
    return null;
  }
  const server = proxyAddress(url);
  if (server === null || server.length === 0 || server.length > MAX_LINK) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(
      /^(?:https?:)?\/\//i.test(server) ? server : `http://${server}`,
    );
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
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
  return host;
}

function proxyAddress(url: URL): string | null {
  const server = searchParam(url, "server");
  if (server === null || (server.length === 0 && isWebProxy(url))) {
    return searchParam(url, "host");
  }
  return server;
}

function isWebProxy(url: URL): boolean {
  if (url.protocol === "tg:") {
    const host = url.hostname.toLowerCase();
    const path = url.pathname.replace(/^\/+|\/+$/g, "").toLowerCase();
    const command = host.length > 0 ? host : path;
    return command === "webproxy";
  }
  const path = (url.pathname.replace(/\/+$/, "") || "/").toLowerCase();
  return path === "/webproxy";
}

function isTelegramProxy(url: URL): boolean {
  if (url.protocol === "tg:") {
    const host = url.hostname.toLowerCase();
    const path = url.pathname.replace(/^\/+|\/+$/g, "").toLowerCase();
    const command = host.length > 0 ? host : path;
    return command === "proxy" || command === "socks" || command === "webproxy";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return false;
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    !telegramProxyHosts.some(
      (name) => host === name || host.endsWith(`.${name}`),
    )
  ) {
    return false;
  }
  const path = (url.pathname.replace(/\/+$/, "") || "/").toLowerCase();
  return path === "/proxy" || path === "/socks" || path === "/webproxy";
}

function telegramDeepInvite(
  url: URL,
): { host: string; invite: boolean } | null {
  if (url.protocol !== "tg:") {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const path = url.pathname.replace(/^\/+|\/+$/g, "").toLowerCase();
  const command = host.length > 0 ? host : path;
  const code =
    command === "join"
      ? searchParam(url, "invite")
      : command === "addlist"
        ? searchParam(url, "slug")
        : null;
  if (code === null || !/^[A-Za-z0-9_-]{1,128}$/.test(code)) {
    return null;
  }
  return { host: "t.me", invite: true };
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
  if (isTelegramPhonePath(host, path)) {
    return false;
  }
  return (
    /^\/\+[A-Za-z0-9_-]{1,128}$/.test(path) ||
    /^\/joinchat\/[A-Za-z0-9_-]{1,128}$/i.test(path) ||
    /^\/addlist\/[A-Za-z0-9_-]{1,128}$/i.test(path) ||
    /^\/folder\/[A-Za-z0-9_-]{1,128}$/.test(path) ||
    isAndroidPrefixInvite(host, path)
  );
}

/** Android 把 `folder.t.me/码` 收成 `t.me/folder/码`。只认这三枚标签。 */
function isAndroidPrefixInvite(host: string, path: string): boolean {
  if (!host.endsWith(".t.me")) {
    return false;
  }
  const label = host.slice(0, -".t.me".length);
  if (label !== "folder" && label !== "addlist" && label !== "joinchat") {
    return false;
  }
  return /^\/[A-Za-z0-9_-]{1,128}$/.test(path);
}

/** 桌面端把 `t.me/%20邀请码` 收成 `tg://join`。末尾斜杠和 `#` 不算。 */
function isPercentSpaceInvite(raw: string, host: string): boolean {
  const bare = host.startsWith("www.") ? host.slice(4) : host;
  if (bare !== "t.me" && bare !== "telegram.me" && bare !== "telegram.dog") {
    return false;
  }
  return /^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me|telegram\.dog)\/%20[A-Za-z0-9_-]{1,128}(?:\?.*)?$/i.test(
    raw,
  );
}

function isTelegramPhonePath(host: string, path: string): boolean {
  const bare = host.startsWith("www.") ? host.slice(4) : host;
  if (bare !== "t.me" && bare !== "telegram.me" && bare !== "telegram.dog") {
    return false;
  }
  const segment = path.startsWith("/") ? path.slice(1) : path;
  return /^\+\d{1,128}$/.test(segment);
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
  const rich = message.rich_message;
  if (isRecord(rich)) {
    const found = await firstRichMedia(rich.blocks);
    if (found) {
      return found;
    }
  }
  return firstPaidMedia(message.paid_media);
}

async function firstPaidMedia(
  paid: unknown,
): Promise<{ readonly kind: MediaKind; readonly sha256?: string } | undefined> {
  if (!isRecord(paid) || !Array.isArray(paid.paid_media)) {
    return undefined;
  }
  for (const item of paid.paid_media) {
    if (!isRecord(item)) {
      continue;
    }
    if (item.type === "photo") {
      if (!Array.isArray(item.photo) || item.photo.length === 0) {
        continue;
      }
      return marked("photo", uniqueId(item.photo[item.photo.length - 1]));
    }
    if (item.type === "video") {
      if (!isRecord(item.video)) {
        continue;
      }
      return marked("video", uniqueId(item.video));
    }
    if (item.type === "live_photo") {
      if (!isRecord(item.live_photo)) {
        continue;
      }
      return marked("video", uniqueId(item.live_photo));
    }
  }
  return undefined;
}

async function firstRichMedia(
  value: unknown,
): Promise<{ readonly kind: MediaKind; readonly sha256?: string } | undefined> {
  if (!Array.isArray(value)) {
    return undefined;
  }
  for (const block of value) {
    if (!isRecord(block)) {
      continue;
    }
    const found = await markRichBlock(block);
    if (found) {
      return found;
    }
  }
  return undefined;
}

async function markRichBlock(
  block: Record<string, unknown>,
): Promise<{ readonly kind: MediaKind; readonly sha256?: string } | undefined> {
  const type = block.type;
  if (
    type === "animation" ||
    type === "video" ||
    type === "audio" ||
    type === "document"
  ) {
    const value = block[type];
    if (!isRecord(value)) {
      return undefined;
    }
    return marked(type, uniqueId(value));
  }
  if (type === "voice_note") {
    if (!isRecord(block.voice_note)) {
      return undefined;
    }
    return marked("voice", uniqueId(block.voice_note));
  }
  if (type === "photo") {
    if (!Array.isArray(block.photo) || block.photo.length === 0) {
      return undefined;
    }
    return marked("photo", uniqueId(block.photo[block.photo.length - 1]));
  }
  if (type === "list" && Array.isArray(block.items)) {
    for (const item of block.items) {
      if (!isRecord(item)) {
        continue;
      }
      const found = await firstRichMedia(item.blocks);
      if (found) {
        return found;
      }
    }
    return undefined;
  }
  if (
    type === "details" ||
    type === "blockquote" ||
    type === "collage" ||
    type === "slideshow"
  ) {
    return firstRichMedia(block.blocks);
  }
  return undefined;
}

async function marked(
  kind: MediaKind,
  id: string | undefined,
): Promise<{ readonly kind: MediaKind; readonly sha256?: string }> {
  return id ? { kind, sha256: await sha256Hex(`${kind}\n${id}`) } : { kind };
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
    if (block.type === "mathematical_expression") {
      pushPlainUrls(block.expression, urls);
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
          pushPlainUrls(item.label, urls);
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
      if (block.type === "pre") {
        pushPlainUrls(block.language, urls);
      }
      continue;
    }
    if (
      block.type === "animation" ||
      block.type === "video" ||
      block.type === "audio" ||
      block.type === "document"
    ) {
      pushRichMediaName(block, urls);
    }
    pushCaption(block.caption, parts, urls);
  }
}

function pushRichMediaName(
  block: Record<string, unknown>,
  urls: string[],
): void {
  const value = block[String(block.type)];
  if (!isRecord(value)) {
    return;
  }
  if (block.type === "audio") {
    pushPlainUrls(value.title, urls);
    pushPlainUrls(value.file_name, urls);
    pushPlainUrls(value.performer, urls);
    return;
  }
  pushPlainUrls(value.file_name, urls);
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
  if (value.type === "mathematical_expression") {
    pushPlainUrls(value.expression, urls);
    return "";
  }
  if (value.type === "custom_emoji") {
    return richText(value.alternative_text, urls);
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
  pushSwitchInlineQueries(value, urls);
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
  const performer = performerName(message);
  if (performer.length > 0) {
    return performer;
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
  const comment = declineComment(message);
  if (comment.length > 0) {
    return comment;
  }
  const added = addedServiceText(message);
  if (added.length > 0) {
    return added;
  }
  const hidden = hiddenForwardName(message);
  if (hidden.length > 0) {
    return hidden;
  }
  const signature = authorSignature(message);
  if (signature.length > 0) {
    return signature;
  }
  const tag = senderTag(message);
  if (tag.length > 0) {
    return tag;
  }
  const members = memberNames(message);
  if (members.length > 0) {
    return members;
  }
  return "";
}

function memberNames(message: Record<string, unknown>): string {
  const parts: string[] = [];
  pushUserLabels(message.new_chat_members, parts);
  const invited = message.video_chat_participants_invited;
  if (isRecord(invited)) {
    pushUserLabels(invited.users, parts);
  }
  for (const field of ["chat_owner_changed", "chat_owner_left"]) {
    const value = message[field];
    if (isRecord(value)) {
      pushUserLabels([value.new_owner], parts);
    }
  }
  const proximity = message.proximity_alert_triggered;
  if (isRecord(proximity)) {
    pushUserLabels([proximity.traveler, proximity.watcher], parts);
  }
  if (parts.length === 0) {
    return "";
  }
  return parts.join(" ").slice(0, MAX_TEXT);
}

function pushUserLabels(value: unknown, parts: string[]): void {
  if (!Array.isArray(value)) {
    return;
  }
  for (const member of value) {
    if (!isRecord(member)) {
      continue;
    }
    for (const key of ["first_name", "last_name", "username"]) {
      const label = member[key];
      if (typeof label !== "string") {
        continue;
      }
      const trimmed = label.trim();
      if (trimmed.length > 0) {
        parts.push(trimmed);
      }
    }
  }
}

function senderTag(message: Record<string, unknown>): string {
  if (typeof message.sender_tag === "string" && message.sender_tag.length > 0) {
    return message.sender_tag.slice(0, MAX_TEXT);
  }
  return "";
}

function authorSignature(message: Record<string, unknown>): string {
  if (
    typeof message.author_signature === "string" &&
    message.author_signature.length > 0
  ) {
    return message.author_signature.slice(0, MAX_TEXT);
  }
  return "";
}

function hiddenForwardName(message: Record<string, unknown>): string {
  const origin = message.forward_origin;
  if (
    isRecord(origin) &&
    origin.type === "hidden_user" &&
    typeof origin.sender_user_name === "string" &&
    origin.sender_user_name.length > 0
  ) {
    return origin.sender_user_name.slice(0, MAX_TEXT);
  }
  if (
    typeof message.forward_sender_name === "string" &&
    message.forward_sender_name.length > 0
  ) {
    return message.forward_sender_name.slice(0, MAX_TEXT);
  }
  return "";
}

function addedServiceText(message: Record<string, unknown>): string {
  for (const field of ["poll_option_added", "poll_option_deleted"]) {
    const value = message[field];
    if (
      isRecord(value) &&
      typeof value.option_text === "string" &&
      value.option_text.length > 0
    ) {
      return value.option_text.slice(0, MAX_TEXT);
    }
  }
  const added = message.checklist_tasks_added;
  if (!isRecord(added) || !Array.isArray(added.tasks)) {
    return "";
  }
  const parts: string[] = [];
  for (const task of added.tasks) {
    if (!isRecord(task) || typeof task.text !== "string") {
      continue;
    }
    if (task.text.length === 0) {
      continue;
    }
    parts.push(task.text);
  }
  if (parts.length === 0) {
    return "";
  }
  return parts.join(" ").slice(0, MAX_TEXT);
}

function declineComment(message: Record<string, unknown>): string {
  const declined = message.suggested_post_declined;
  if (
    isRecord(declined) &&
    typeof declined.comment === "string" &&
    declined.comment.length > 0
  ) {
    return declined.comment.slice(0, MAX_TEXT);
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

function performerName(message: Record<string, unknown>): string {
  const audio = message.audio;
  if (
    isRecord(audio) &&
    typeof audio.performer === "string" &&
    audio.performer.length > 0
  ) {
    return audio.performer.slice(0, MAX_TEXT);
  }
  return "";
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
  const paid = message.paid_media;
  if (isRecord(paid) && Array.isArray(paid.paid_media)) {
    for (const item of paid.paid_media) {
      if (!isRecord(item) || !isRecord(item.video)) {
        continue;
      }
      const name = item.video.file_name;
      if (typeof name === "string" && name.length > 0) {
        return name.slice(0, MAX_TEXT);
      }
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

function positiveId(value: unknown): string | null {
  const id = idString(value);
  if (id === null || id === "0" || id.startsWith("-")) {
    return null;
  }
  return id;
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
