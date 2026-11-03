import {
  androidStrictTld,
  androidUrlSpan,
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
  foldMappedLatin,
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

const DRAFT_IP_HEAD = "(?:25[0-5]|2[0-4][0-9]|[0-1][0-9]{2}|[1-9][0-9]|[1-9])";
const DRAFT_IP_MID = "(?:25[0-5]|2[0-4][0-9]|[0-1][0-9]{2}|[1-9][0-9]|[1-9]|0)";
const DRAFT_IP_LAST = "(?:25[0-5]|2[0-4][0-9]|[0-1][0-9]{2}|[1-9][0-9]|[0-9])";
const DRAFT_IP = `${DRAFT_IP_HEAD}\\.${DRAFT_IP_MID}\\.${DRAFT_IP_MID}\\.${DRAFT_IP_LAST}`;
const DRAFT_IP_TAIL = '(?::\\d{1,5}(?!\\d))?(?:[/?][^\\s<>"]*)?';
const DRAFT_ASCII_LABEL = "[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?";
const DRAFT_ATOM =
  "(?:[A-Za-z0-9]|[^\\t\\n\\v\\f\\r \\u00A0\\u2000-\\u200A\\u2028\\u2029\\u202F\\u3000\\u0000-\\u007F\\u0080-\\u009F\\uD800-\\uDFFF\\uE000-\\uF8FF\\uFDD0-\\uFDEF\\uFFF0-\\uFFFF])";
const DRAFT_BRIDGED = `(?=[^.]{0,62}[_-])${DRAFT_ATOM}(?:${DRAFT_ATOM}|[_-]){0,61}${DRAFT_ATOM}`;
const DRAFT_NAME = `(?:${DRAFT_BRIDGED}|${DRAFT_ASCII_LABEL})`;
const DRAFT_BARE = `(?<!:\\/\\/)(?:^|\\b)(?:${DRAFT_NAME}\\.)+(?:${androidStrictTld})(?![A-Za-z0-9_-])(?::\\d{1,5}(?!\\d))?(?:[/?][^\\s<>"]*)?`;
const STRICT_TLD_LABEL = new RegExp(`^(?:${androidStrictTld})$`, "i");
const DRAFT_MARK =
  "[\\u0300-\\u0344\\u0346-\\u036F\\u0483-\\u0487\\u0591-\\u05BD\\u05BF\\u05C1-\\u05C2" +
  "\\u05C4-\\u05C5\\u05C7\\u0610-\\u061A\\u064B-\\u065F\\u0670\\u06D6-" +
  "\\u06DC\\u06DF-\\u06E4\\u06E7-\\u06E8\\u06EA-\\u06ED\\u0711\\u0730-" +
  "\\u074A\\u07A6-\\u07B0\\u07EB-\\u07F3\\u07FD\\u0816-\\u0819\\u081B-" +
  "\\u0823\\u0825-\\u0827\\u0829-\\u082D\\u0859-\\u085B\\u0898-\\u089F" +
  "\\u08CA-\\u08E1\\u08E3-\\u0902\\u093A\\u093C\\u0941-\\u0948\\u094D" +
  "\\u0951-\\u0957\\u0962-\\u0963\\u0981\\u09BC\\u09C1-\\u09C4\\u09CD" +
  "\\u09E2-\\u09E3\\u09FE\\u0A01-\\u0A02\\u0A3C\\u0A41-\\u0A42\\u0A47-" +
  "\\u0A48\\u0A4B-\\u0A4D\\u0A51\\u0A70-\\u0A71\\u0A75\\u0A81-\\u0A82" +
  "\\u0ABC\\u0AC1-\\u0AC5\\u0AC7-\\u0AC8\\u0ACD\\u0AE2-\\u0AE3\\u0AFA-" +
  "\\u0AFF\\u0B01\\u0B3C\\u0B3F\\u0B41-\\u0B44\\u0B4D\\u0B55-\\u0B56" +
  "\\u0B62-\\u0B63\\u0B82\\u0BC0\\u0BCD\\u0C00\\u0C04\\u0C3C\\u0C3E-" +
  "\\u0C40\\u0C46-\\u0C48\\u0C4A-\\u0C4D\\u0C55-\\u0C56\\u0C62-\\u0C63" +
  "\\u0C81\\u0CBC\\u0CBF\\u0CC6\\u0CCC-\\u0CCD\\u0CE2-\\u0CE3\\u0D00-" +
  "\\u0D01\\u0D3B-\\u0D3C\\u0D41-\\u0D44\\u0D4D\\u0D62-\\u0D63\\u0D81" +
  "\\u0DCA\\u0DD2-\\u0DD4\\u0DD6\\u0E31\\u0E34-\\u0E3A\\u0E47-\\u0E4E" +
  "\\u0EB1\\u0EB4-\\u0EBC\\u0EC8-\\u0ECE\\u0F18-\\u0F19\\u0F35\\u0F37" +
  "\\u0F39\\u0F71-\\u0F7E\\u0F80-\\u0F84\\u0F86-\\u0F87\\u0F8D-\\u0F97" +
  "\\u0F99-\\u0FBC\\u0FC6\\u102D-\\u1030\\u1032-\\u1037\\u1039-\\u103A" +
  "\\u103D-\\u103E\\u1058-\\u1059\\u105E-\\u1060\\u1071-\\u1074\\u1082" +
  "\\u1085-\\u1086\\u108D\\u109D\\u135D-\\u135F\\u1712-\\u1714\\u1732-" +
  "\\u1733\\u1752-\\u1753\\u1772-\\u1773\\u17B4-\\u17B5\\u17B7-\\u17BD" +
  "\\u17C6\\u17C9-\\u17D3\\u17DD\\u180B-\\u180D\\u180F\\u1885-\\u1886" +
  "\\u18A9\\u1920-\\u1922\\u1927-\\u1928\\u1932\\u1939-\\u193B\\u1A17-" +
  "\\u1A18\\u1A1B\\u1A56\\u1A58-\\u1A5E\\u1A60\\u1A62\\u1A65-\\u1A6C" +
  "\\u1A73-\\u1A7C\\u1A7F\\u1AB0-\\u1ABD\\u1ABF-\\u1ACE\\u1B00-\\u1B03" +
  "\\u1B34\\u1B36-\\u1B3A\\u1B3C\\u1B42\\u1B6B-\\u1B73\\u1B80-\\u1B81" +
  "\\u1BA2-\\u1BA5\\u1BA8-\\u1BA9\\u1BAB-\\u1BAD\\u1BE6\\u1BE8-\\u1BE9" +
  "\\u1BED\\u1BEF-\\u1BF1\\u1C2C-\\u1C33\\u1C36-\\u1C37\\u1CD0-\\u1CD2" +
  "\\u1CD4-\\u1CE0\\u1CE2-\\u1CE8\\u1CED\\u1CF4\\u1CF8-\\u1CF9\\u1DC0-" +
  "\\u1DFF\\u20D0-\\u20DC\\u20E1\\u20E5-\\u20F0\\u2CEF-\\u2CF1\\u2D7F" +
  "\\u2DE0-\\u2DFF\\u302A-\\u302D\\u3099-\\u309A\\uA66F\\uA674-\\uA67D" +
  "\\uA69E-\\uA69F\\uA6F0-\\uA6F1\\uA802\\uA806\\uA80B\\uA825-\\uA826" +
  "\\uA82C\\uA8C4-\\uA8C5\\uA8E0-\\uA8F1\\uA8FF\\uA926-\\uA92D\\uA947-" +
  "\\uA951\\uA980-\\uA982\\uA9B3\\uA9B6-\\uA9B9\\uA9BC-\\uA9BD\\uA9E5" +
  "\\uAA29-\\uAA2E\\uAA31-\\uAA32\\uAA35-\\uAA36\\uAA43\\uAA4C\\uAA7C" +
  "\\uAAB0\\uAAB2-\\uAAB4\\uAAB7-\\uAAB8\\uAABE-\\uAABF\\uAAC1\\uAAEC-" +
  "\\uAAED\\uAAF6\\uABE5\\uABE8\\uABED\\uFB1E\\uFE00-\\uFE0F\\uFE20-" +
  "\\uFE2F]";
const DRAFT_MARK_CHAR = new RegExp(`^(?:${DRAFT_MARK})`);
const DRAFT_URL = `(?<![A-Za-z0-9_](?:${DRAFT_MARK})*)(?:https?:\\/\\/|tg:(?:\\/\\/)?)[^\\s<>"']+|www\\.[^\\s<>"']+|${DRAFT_BARE}`;

function urlsInText(text: string): string[] {
  return scanUrls(text, COPY_URL.source);
}

function scanUrls(
  text: string,
  source: string,
  keepPathApostrophe = false,
): string[] {
  const found: string[] = [];
  const folded = foldHostScan(text);
  const re = new RegExp(source, "gi");
  let match: RegExpExecArray | null = re.exec(folded);
  while (match !== null) {
    let raw = match[0] ?? "";
    if (keepPathApostrophe && pathStarted(raw)) {
      const extra = /^'[^\s<>"]*/.exec(folded.slice(re.lastIndex));
      if (extra?.[0]) {
        raw += extra[0];
        re.lastIndex += extra[0].length;
      }
    }
    const trimmed = raw.replace(/[),.;!?]+$/g, "");
    const end = re.lastIndex;
    if (
      keepPathApostrophe &&
      trimmed.length > 0 &&
      (markInsideAuthority(trimmed) || boundaryMarkAt(folded, end))
    ) {
      re.lastIndex = match.index + 1;
      match = re.exec(folded);
      continue;
    }
    if (trimmed) {
      let url = /^(?:https?|tg):/i.test(trimmed)
        ? trimmed
        : `http://${trimmed}`;
      // 后面的空格仍交给这一段，Android 才能退回上一个单词。
      if (keepPathApostrophe && folded.charAt(end) === " ") {
        url += " ";
      }
      found.push(url);
    }
    match = re.exec(folded);
  }
  return found;
}

/** U+0345 在忽略大小写时会连上希腊字母。先换成普通的组合附加符号。 */
function foldBoundaryMark(text: string): string {
  return text.replaceAll("\u0345", "\u0300");
}

function boundaryMark(code: number): boolean {
  return DRAFT_MARK_CHAR.test(String.fromCodePoint(code));
}

function boundaryMarkAt(text: string, index: number): boolean {
  const code = text.codePointAt(index);
  return code !== undefined && boundaryMark(code);
}

/** 主机名还没进路径时，非间距符号把这一段粘住。 */
function markInsideAuthority(raw: string): boolean {
  let index = 0;
  const scheme = /^(?:https?:\/\/|tg:(?:\/\/)?)/i.exec(raw);
  if (scheme?.[0]) {
    index = scheme[0].length;
  }
  while (index < raw.length) {
    const code = raw.codePointAt(index);
    if (code === undefined) {
      return false;
    }
    if (boundaryMark(code)) {
      return true;
    }
    const char = String.fromCodePoint(code);
    if (char === "/" || char === "?" || char === "#") {
      return false;
    }
    index += char.length;
  }
  return false;
}

/** `%2F` 后面的字面斜杠仍分开下一段。两道编码斜杠留在一起。 */
function openEncodedSlashBoundary(text: string): string {
  return text.replace(/%2F(?=\/)/gi, (mark) => `${mark} `);
}

/** 已经结束的主机名在编码间隔前停下。协议正后面的间隔留下十六进制。 */
function openEncodedGapHost(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const gap = draftEncodedGapLength(text, index);
    if (gap > 0 && encodedDotAfterHost(out)) {
      const hex = text.slice(index, index + gap).replace(/%/g, "");
      out += ` ${hex}`;
      index += gap;
      continue;
    }
    if (gap > 0 && out.toLowerCase().endsWith("://")) {
      out += text.slice(index, index + gap).replace(/%/g, "");
      index += gap;
      continue;
    }
    out += text.charAt(index);
    index += 1;
  }
  return out;
}

function draftEncodedGapLength(text: string, index: number): number {
  const single = draftSingleEncodedGap(text, index);
  if (single > 0) {
    return single;
  }
  return draftDoubleEncodedGap(text, index);
}

function draftSingleEncodedGap(text: string, index: number): number {
  const first = draftPercentByte(text, index);
  if (first === null) {
    return 0;
  }
  const width = draftUtf8Width(first.byte);
  if (width === 0) {
    return 0;
  }
  const bytes = [first.byte];
  let next = first.next;
  for (let part = 1; part < width; part += 1) {
    const byte = draftPercentByte(text, next);
    if (byte === null || (byte.byte & 0xc0) !== 0x80) {
      return 0;
    }
    bytes.push(byte.byte);
    next = byte.next;
  }
  let char = "";
  try {
    char = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      Uint8Array.from(bytes),
    );
  } catch {
    return 0;
  }
  if (foldMatchText(char) !== "") {
    return 0;
  }
  return next - index;
}

function draftDoubleEncodedGap(text: string, index: number): number {
  let inner = "";
  let cursor = index;
  let groups = 0;
  while (groups < 4 && cursor + 5 <= text.length) {
    if (text.slice(cursor, cursor + 3).toLowerCase() !== "%25") {
      break;
    }
    const hex = text.slice(cursor + 3, cursor + 5);
    if (!/^[0-9A-Fa-f]{2}$/.test(hex)) {
      break;
    }
    inner += `%${hex}`;
    cursor += 5;
    groups += 1;
    if (draftEncodedGapsCover(inner)) {
      return cursor - index;
    }
  }
  return 0;
}

function draftEncodedGapsCover(text: string): boolean {
  let index = 0;
  while (index < text.length) {
    const skipped = draftSingleEncodedGap(text, index);
    if (skipped === 0) {
      return false;
    }
    index += skipped;
  }
  return text.length > 0;
}

function draftPercentByte(
  text: string,
  index: number,
): { byte: number; next: number } | null {
  if (text.charCodeAt(index) !== 37) {
    return null;
  }
  const hex = text.slice(index + 1, index + 3);
  if (!/^[0-9A-Fa-f]{2}$/.test(hex)) {
    return null;
  }
  return { byte: Number.parseInt(hex, 16), next: index + 3 };
}

function draftUtf8Width(first: number): number {
  if (first < 0x80) {
    return 1;
  }
  if (first >= 0xc2 && first <= 0xdf) {
    return 2;
  }
  if (first >= 0xe0 && first <= 0xef) {
    return 3;
  }
  if (first >= 0xf0 && first <= 0xf4) {
    return 4;
  }
  return 0;
}

/** 粘连扫描会吃掉的间隔。普通空格留下，字面主机名仍能打开。 */
const DRAFT_HOST_GAP =
  /[\t\n\v\f\r\u00A0\u00AD\u061C\u1680\u180E\u2000-\u200F\u2028-\u202E\u202F\u205F\u2060-\u2064\u2066-\u2069\u3000\uFEFF]/;

/** 贴在编码主机名前面的 `%2B`、`%2F`、`%2D` 和 `%252D` 在百分号处停下。 */
function openEncodedHostBody(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const percent = encodedHostBodyPercent(text, index);
    if (percent >= 0) {
      out += `${text.slice(index, percent)} `;
      index = percent + 1;
      continue;
    }
    out += text.charAt(index);
    index += 1;
  }
  return out;
}

function encodedHostBodyPercent(text: string, index: number): number {
  const marker = encodedHostBodyMarker(text, index);
  if (marker === 0 || encodedHostBodyInPath(text, index)) {
    return -1;
  }
  let cursor = index + marker;
  while (DRAFT_HOST_GAP.test(text.charAt(cursor))) {
    cursor += 1;
  }
  const scheme = text.slice(cursor, cursor + 8).toLowerCase();
  if (scheme.startsWith("https://") || scheme.startsWith("http://")) {
    return -1;
  }
  while (cursor < text.length) {
    const char = text.charAt(cursor);
    if (char === "%") {
      const rest = text.slice(cursor + 1);
      if (
        /^[0-9A-Fa-f]{2}/.test(rest) &&
        (encodedBodyHost(rest) || encodedBodyIp(rest))
      ) {
        return cursor;
      }
      const unit = encodedBodyUnit(text, cursor);
      if (unit === 0) {
        return -1;
      }
      cursor += unit;
      continue;
    }
    if (/[A-Za-z0-9._-]/.test(char)) {
      cursor += 1;
      continue;
    }
    return -1;
  }
  return -1;
}

function encodedHostBodyMarker(text: string, index: number): number {
  if (text.slice(index, index + 5).toLowerCase() === "%252d") {
    return 5;
  }
  const three = text.slice(index, index + 3).toLowerCase();
  if (three === "%2b" || three === "%2f" || three === "%2d") {
    return 3;
  }
  return 0;
}

function encodedHostBodyInPath(text: string, index: number): boolean {
  if (text.charAt(index - 1) === "/") {
    return true;
  }
  return text.slice(index - 3, index).toLowerCase() === "%2f";
}

function encodedBodyHost(rest: string): boolean {
  return new RegExp(
    `^(?:${DRAFT_ASCII_LABEL}\\.)+(?:${androidStrictTld})(?![A-Za-z0-9_-])`,
    "i",
  ).test(rest);
}

function encodedBodyIp(rest: string): boolean {
  return new RegExp(`^(?:${DRAFT_IP})(?![0-9.])`, "i").test(rest);
}

function encodedBodyUnit(text: string, index: number): number {
  for (const marker of ["%25", "%"] as const) {
    if (text.slice(index, index + marker.length).toLowerCase() !== marker) {
      continue;
    }
    const hex = text.slice(index + marker.length, index + marker.length + 2);
    if (!/^[0-9A-Fa-f]{2}$/.test(hex)) {
      continue;
    }
    const char = String.fromCharCode(Number.parseInt(hex, 16));
    if (/[A-Za-z0-9_-]/.test(char)) {
      return marker.length + 2;
    }
  }
  return 0;
}

/** 不在路径里的 `%2D` 和 `%252D` 留下十六进制，后面的主机名仍能以短链结尾。 */
function openEncodedHyphenHost(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const taken = encodedHyphenHostMark(text, index);
    if (taken > 0) {
      out += ` ${text.slice(index + 1, index + taken)}`;
      index += taken;
      continue;
    }
    out += text.charAt(index);
    index += 1;
  }
  return out;
}

function encodedHyphenHostMark(text: string, index: number): number {
  const five = text.slice(index, index + 5).toLowerCase();
  const three = text.slice(index, index + 3).toLowerCase();
  const taken = five === "%252d" ? 5 : three === "%2d" ? 3 : 0;
  if (taken === 0) {
    return 0;
  }
  if (text.charAt(index - 1) === "/") {
    return 0;
  }
  if (text.slice(index - 3, index).toLowerCase() === "%2f") {
    return 0;
  }
  const rest = text.slice(index + taken);
  const scheme = rest.slice(0, 8).toLowerCase();
  if (scheme.startsWith("https://") || scheme.startsWith("http://")) {
    return 0;
  }
  if (new RegExp(`^(?:${DRAFT_IP})(?![0-9.])`, "i").test(rest)) {
    return taken;
  }
  if (
    new RegExp(
      `^(?:${DRAFT_ASCII_LABEL}\\.)+(?:${androidStrictTld})(?![A-Za-z0-9_-])`,
      "i",
    ).test(rest)
  ) {
    return taken;
  }
  return 0;
}

/** 贴在字面主机名前面的 `%2F` 留下两位十六进制，短链后缀仍对得上。 */
function openEncodedSlashHost(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    if (encodedSlashSplitsHost(text, index)) {
      out += ` ${text.slice(index + 1, index + 3)}`;
      index += 3;
      continue;
    }
    out += text.charAt(index);
    index += 1;
  }
  return out;
}

function encodedSlashSplitsHost(text: string, index: number): boolean {
  if (text.slice(index, index + 3).toLowerCase() !== "%2f") {
    return false;
  }
  const rest = text.slice(index + 3);
  if (rest.startsWith("/")) {
    return false;
  }
  const scheme = rest.slice(0, 8).toLowerCase();
  if (scheme.startsWith("https://") || scheme.startsWith("http://")) {
    return false;
  }
  if (new RegExp(`^(?:${DRAFT_IP})(?![0-9.])`, "i").test(rest)) {
    return true;
  }
  return new RegExp(
    `^(?:${DRAFT_ASCII_LABEL}\\.)+(?:${androidStrictTld})(?![A-Za-z0-9_-])`,
    "i",
  ).test(rest);
}

/** 不在路径里的 `%2B` 留下两位十六进制，后面的主机名仍能以短链结尾。 */
function openEncodedPlusHost(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    if (encodedPlusSplitsHost(text, index)) {
      out += ` ${text.slice(index + 1, index + 3)}`;
      index += 3;
      continue;
    }
    out += text.charAt(index);
    index += 1;
  }
  return out;
}

function encodedPlusSplitsHost(text: string, index: number): boolean {
  if (text.slice(index, index + 3).toLowerCase() !== "%2b") {
    return false;
  }
  if (text.charAt(index - 1) === "/") {
    return false;
  }
  if (text.slice(index - 3, index).toLowerCase() === "%2f") {
    return false;
  }
  const rest = text.slice(index + 3);
  const scheme = rest.slice(0, 8).toLowerCase();
  if (scheme.startsWith("https://") || scheme.startsWith("http://")) {
    return false;
  }
  if (new RegExp(`^(?:${DRAFT_IP})(?![0-9.])`, "i").test(rest)) {
    return true;
  }
  return new RegExp(
    `^(?:${DRAFT_ASCII_LABEL}\\.)+(?:${androidStrictTld})(?![A-Za-z0-9_-])`,
    "i",
  ).test(rest);
}

/**
 * 一层括号点。闭合括号写成百分号时，已经结束的主机名后面留下十六进制。
 * 字面闭合括号收成点，避免停住字符先把 `[.]` 拆开。
 */
const DRAFT_BRACKET_DOT =
  /(?:[[\uFF3B]|%5B)(?:\.|。|%2E)(?:[\]\uFF3D]|%5D)|(?:[(\uFF08]|%28)(?:\.|。|%2E)(?:[)\uFF09]|%29)|(?:[{\uFF5B]|%7B)(?:\.|。|%2E)(?:[}\uFF5D]|%7D)/gi;

/** 已经结束的主机名后面，编码括号点留下闭合十六进制。字面括号点收成点。 */
function openEncodedBracketHost(text: string): string {
  const pattern = new RegExp(DRAFT_BRACKET_DOT.source, "gi");
  let out = "";
  let index = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    const raw = match[0] ?? "";
    out += text.slice(index, start);
    const closer = draftEncodedBracketHex(raw);
    if (closer !== null && encodedDotAfterHost(out)) {
      out += ` ${closer}`;
    } else if (closer === null && encodedDotAfterHost(out)) {
      out += " ";
    } else if (closer === null) {
      out += ".";
    } else {
      out += raw;
    }
    index = start + raw.length;
  }
  return out + text.slice(index);
}

function draftEncodedBracketHex(raw: string): string | null {
  const tail = raw.slice(-3);
  if (/^%(?:5d|29|7d)$/i.test(tail)) {
    return tail.slice(1);
  }
  return null;
}

/**
 * 带协议的主机名在多字节百分号前停下。
 * 路径、用户信息、间隔和点状字符仍留在这一段。
 */
function openSchemedPercentHost(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const lookalike = encodedDotLookalikeLength(text, index);
    if (lookalike > 0) {
      out += text.slice(index, index + lookalike);
      index += lookalike;
      continue;
    }
    const byte = draftPercentByte(text, index);
    if (
      byte !== null &&
      byte.byte >= 0x80 &&
      draftEncodedGapLength(text, index) === 0 &&
      schemedAuthorityAt(text, index)
    ) {
      out += " ";
    }
    out += text.charAt(index);
    index += 1;
  }
  return out;
}

function encodedDotLookalikeLength(text: string, index: number): number {
  const first = draftPercentByte(text, index);
  if (first === null) {
    return 0;
  }
  const width = draftUtf8Width(first.byte);
  if (width < 2) {
    return 0;
  }
  const bytes = [first.byte];
  let next = first.next;
  for (let part = 1; part < width; part += 1) {
    const byte = draftPercentByte(text, next);
    if (byte === null || (byte.byte & 0xc0) !== 0x80) {
      return 0;
    }
    bytes.push(byte.byte);
    next = byte.next;
  }
  let char = "";
  try {
    char = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      Uint8Array.from(bytes),
    );
  } catch {
    return 0;
  }
  return DRAFT_DOT_LOOKALIKE.has(char.codePointAt(0) ?? -1) ? next - index : 0;
}

function schemedAuthorityAt(text: string, index: number): boolean {
  let from = index;
  while (from > 0) {
    const head = text.slice(0, from).toLowerCase();
    const https = head.lastIndexOf("https://");
    const http = head.lastIndexOf("http://");
    let scheme = -1;
    let mark = 0;
    if (https > http) {
      scheme = https;
      mark = 8;
    } else if (http >= 0 && !(https >= 0 && http === https + 1)) {
      scheme = http;
      mark = 7;
    } else if (https >= 0) {
      scheme = https;
      mark = 8;
    }
    if (scheme < 0) {
      return false;
    }
    if (scheme > 0 && /[A-Za-z0-9_]/.test(text.charAt(scheme - 1))) {
      from = scheme;
      continue;
    }
    const authority = text.slice(scheme + mark, index);
    if (/[/?#\s]/.test(authority)) {
      return false;
    }
    const rest = text.slice(index);
    const end = rest.search(/[/?#\s]/);
    const tail = end === -1 ? rest : rest.slice(0, end);
    return !tail.includes("@");
  }
  return false;
}

/** 已经结束的主机名后面，`%2E` 留下两位十六进制。紧挨协议的 `%2E` 仍交给粘连扫描。 */
function openFinishedEncodedDot(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    if (
      text.slice(index, index + 3).toLowerCase() === "%2e" &&
      !encodedDotBeforeScheme(text, index + 3) &&
      encodedDotAfterHost(out)
    ) {
      out += ` ${text.slice(index + 1, index + 3)}`;
      index += 3;
      continue;
    }
    out += text.charAt(index);
    index += 1;
  }
  return out;
}

function encodedDotBeforeScheme(text: string, index: number): boolean {
  const next = text.slice(index, index + 8).toLowerCase();
  return next.startsWith("https://") || next.startsWith("http://");
}

function encodedDotAfterHost(out: string): boolean {
  let host = out;
  const scheme = host.toLowerCase().lastIndexOf("://");
  if (scheme >= 0) {
    host = host.slice(scheme + 3);
  }
  const at = host.lastIndexOf("@");
  if (at >= 0) {
    host = host.slice(at + 1);
  }
  if (/[/?#\s]/.test(host)) {
    return false;
  }
  host = host.replace(/:\d{1,5}$/, "");
  if (new RegExp(`^(?:${DRAFT_IP})$`, "i").test(host)) {
    return true;
  }
  return new RegExp(
    `^(?:${DRAFT_ASCII_LABEL}\\.)+(?:${androidStrictTld})$`,
    "i",
  ).test(host);
}

/** 路径或问号已经开始后，单引号仍属于这一段。 */
function pathStarted(raw: string): boolean {
  const scheme = raw.indexOf("://");
  const body = scheme === -1 ? raw : raw.slice(scheme + 3);
  return /[/?]/.test(body);
}

/** 草稿里 Android 停住、而整段抽取不停的字符。路径里留住的增补字符另外判断。 */
const DRAFT_STOP_CHAR = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}[\\]\\\\^\`{|\\u0080-\\u009F\\uD800-\\uDFFF\\uE000-\\uF8FF\\uFDD0-\\uFDEF\\uFFF0-\\uFFFF}]`,
);

/** `://` 后面不是一到五位端口时，路径里的网址另开。 */
function openHostlessPort(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const scheme = schemeEndingAt(text, index);
    if (scheme > 0 && text.charAt(index) === ":") {
      const digits = /^\d*/.exec(text.slice(index + 1))?.[0] ?? "";
      const next = text.charAt(index + 1 + digits.length);
      const port = digits.length >= 1 && digits.length <= 5;
      if (!port && (next === "/" || next === "?")) {
        out += `${text.slice(index - scheme, index + 1 + digits.length)} `;
        index += 1 + digits.length;
        continue;
      }
    }
    out += text.charAt(index);
    index += 1;
  }
  return out;
}

/** `://` 后面紧挨的 `#` 结束这一段，后面的主机名另开。 */
function openEmptyHash(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    if (text.charAt(index) === "#" && schemeEndingAt(text, index) > 0) {
      out += " ";
    }
    out += text.charAt(index);
    index += 1;
  }
  return out;
}

function schemeEndingAt(text: string, index: number): number {
  if (index >= 8 && text.slice(index - 8, index).toLowerCase() === "https://") {
    const start = index - 8;
    if (start > 0 && /[A-Za-z0-9_]/.test(text.charAt(start - 1))) {
      return 0;
    }
    return 8;
  }
  if (index >= 7 && text.slice(index - 7, index).toLowerCase() === "http://") {
    const start = index - 7;
    if (start > 0 && /[A-Za-z0-9_]/.test(text.charAt(start - 1))) {
      return 0;
    }
    return 7;
  }
  return 0;
}

function openedDraftUrls(text: string): string[] {
  const source = `${DRAFT_URL}|\\b(?:${DRAFT_IP})\\b${DRAFT_IP_TAIL}`;
  return scanUrls(
    openPathQuote(
      openPlainTg(
        openBareEnd(
          openSchemeLetter(
            openLookalikeHost(
              openLongLabel(
                openLongUserinfo(
                  openHostlessPort(
                    openEmptyHash(
                      openDraftStops(
                        openEncodedBracketHost(
                          openStoppingSpace(
                            openFinishedEncodedDot(
                              openSchemedPercentHost(
                                openEncodedSlashBoundary(
                                  openEncodedSlashHost(
                                    openEncodedHyphenHost(
                                      openEncodedPlusHost(
                                        openEncodedHostBody(
                                          openEncodedGapHost(
                                            foldBoundaryMark(text),
                                          ),
                                        ),
                                      ),
                                    ),
                                  ),
                                ),
                              ),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
    source,
    true,
  );
}

/** 这些空白会结束网址。U+1680、U+205F 和 U+FEFF 仍留在标签里。 */
const DRAFT_STOP_SPACE = /[\u00A0\u2000-\u200A\u2028\u2029\u202F\u3000]/g;

function openStoppingSpace(text: string): string {
  return text.replace(DRAFT_STOP_SPACE, " ");
}

/** 路径还没开始的单引号，以及双引号，仍结束这一段。路径里的单引号留下。 */
function openPathQuote(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const end = text.slice(index).search(/\s/);
    const next = end === -1 ? text.length : index + end;
    const split = quoteSplit(text.slice(index, next));
    if (split === null) {
      out += text.slice(index, next);
      index = next;
      if (index < text.length) {
        out += text.charAt(index);
        index += 1;
      }
      continue;
    }
    out += split === 0 ? " " : `${text.slice(index, index + split)} `;
    index += split + 1;
  }
  return out;
}

function quoteSplit(token: string): number | null {
  let index = schemeAt(token, 0);
  while (index < token.length) {
    const current = token.charAt(index);
    if (current === "/" || current === "?") {
      const quote = token.indexOf('"', index);
      if (quote !== -1 && schemeAt(token, quote + 1) > 0) {
        return quote;
      }
      return null;
    }
    if (current === "'") {
      const rest = token.slice(index + 1);
      if (schemeAt(rest, 0) > 0 || bareHostAt(rest)) {
        return index;
      }
      return null;
    }
    if (current === '"' && schemeAt(token, index + 1) > 0) {
      return index;
    }
    index += 1;
  }
  return null;
}

function bareHostAt(rest: string): boolean {
  return bareDomainEnd(rest, 0) !== null || bareIpAt(rest);
}

/** 没有两个斜杠的 `tg:` 不盖住后面的网址。`tg://` 仍是一条。 */
function openPlainTg(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    if (!plainTgAt(text, index)) {
      out += text.charAt(index);
      index += 1;
      continue;
    }
    const rest = text.slice(index + 3);
    if (rest.startsWith("//")) {
      const end = text.slice(index).search(/\s/);
      const next = end === -1 ? text.length : index + end;
      out += text.slice(index, next);
      index = next;
      continue;
    }
    if (schemeAt(text, index + 3) > 0 || bareIpAt(rest)) {
      out += " ";
      index += 3;
      continue;
    }
    const end = text.slice(index).search(/\s/);
    const next = end === -1 ? text.length : index + end;
    out += text.slice(index, next);
    index = next;
  }
  return out;
}

function plainTgAt(text: string, index: number): boolean {
  if (index > 0 && /[A-Za-z0-9_]/.test(text.charAt(index - 1))) {
    return false;
  }
  return text.slice(index, index + 3).toLowerCase() === "tg:";
}

function bareIpAt(rest: string): boolean {
  return new RegExp(`^(?:${DRAFT_IP})(?![A-Za-z0-9_])`, "i").test(rest);
}

/** 用户名超过 64 或密码超过 25 时，Android 从 `@` 后面另开网址。放得下的仍是一条。 */
function openLongUserinfo(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const scheme = schemeAt(text, index);
    if (scheme === 0) {
      out += text.charAt(index);
      index += 1;
      continue;
    }
    const at = userinfoOverflow(text, index + scheme);
    if (at !== null) {
      out += " ";
      index = at + 1;
      continue;
    }
    const end = text.slice(index).search(/\s/);
    const next = end === -1 ? text.length : index + end;
    out += text.slice(index, next);
    index = next;
  }
  return out;
}

function schemeAt(text: string, index: number): number {
  if (index > 0 && /[A-Za-z0-9_]/.test(text.charAt(index - 1))) {
    return 0;
  }
  const slice = text.slice(index, index + 8).toLowerCase();
  if (slice.startsWith("https://")) {
    return 8;
  }
  if (slice.startsWith("http://")) {
    return 7;
  }
  return 0;
}

function userinfoOverflow(text: string, start: number): number | null {
  const user = readUserRun(text, start);
  if (text.charAt(user.index) === "@") {
    return user.count > 64 ? user.index : null;
  }
  if (text.charAt(user.index) !== ":" || user.count === 0 || user.count > 64) {
    return null;
  }
  const password = readUserRun(text, user.index + 1);
  if (text.charAt(password.index) === "@" && password.count > 25) {
    return password.index;
  }
  return null;
}

function readUserRun(
  text: string,
  index: number,
): { count: number; index: number } {
  let count = 0;
  while (index < text.length) {
    const size = userCharSize(text, index);
    if (size === 0) {
      break;
    }
    count += 1;
    index += size;
  }
  return { count, index };
}

function userCharSize(text: string, index: number): number {
  if (
    text.charAt(index) === "%" &&
    /^[0-9A-Fa-f]{2}$/.test(text.slice(index + 1, index + 3))
  ) {
    return 3;
  }
  if (/[A-Za-z0-9$._+!*'(),;?&=-]/.test(text.charAt(index))) {
    return 1;
  }
  return 0;
}

const DRAFT_LABEL = "(?:[A-Za-z0-9](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9])?)";
const DRAFT_HOST = `(?:${DRAFT_LABEL}(?:\\.${DRAFT_LABEL})*)`;
const DRAFT_HOST_END = new RegExp(`^${DRAFT_HOST}(?![A-Za-z0-9_])`);

/** 标签超过 63，或连字符让标签放不下时，Android 另开后面的网址。放得下的仍是一条。 */
function openLongLabel(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const scheme = schemeAt(text, index);
    if (scheme === 0) {
      out += text.charAt(index);
      index += 1;
      continue;
    }
    const authority = text.slice(index + scheme);
    const host = draftHostLength(authority);
    if (host === null) {
      const later = schemeAfterHostRun(authority);
      if (later !== null) {
        out += " ";
        index += scheme + later;
        continue;
      }
    } else {
      const rest = authority.slice(host);
      const atMark = lookalikeBeforeAt(rest);
      if (atMark > 0) {
        out += `${text.slice(index, index + scheme + host)} `;
        index += scheme + host + atMark;
        continue;
      }
      if (rest.startsWith("@") && !atCanFinish(rest)) {
        out += `${text.slice(index, index + scheme + host)} `;
        index = skipUnfinishedAt(text, index + scheme + host + 1);
        continue;
      }
      if (labelEndsUrl(authority.slice(0, host), rest) || hostPunctEnds(rest)) {
        out += `${text.slice(index, index + scheme + host)} `;
        index += scheme + host + 1;
        continue;
      }
      const port = /^:\d{1,5}(?!\d)/.exec(rest);
      if (port?.[0]) {
        const after = rest.slice(port[0].length);
        if (
          after.startsWith("-") ||
          (after.startsWith(".") && schemeAt(after, 1) > 0)
        ) {
          out += `${text.slice(index, index + scheme + host + port[0].length)} `;
          index += scheme + host + port[0].length + 1;
          continue;
        }
      }
      const dotted = /^\.:\d{1,5}(?!\d)/.exec(rest);
      if (dotted?.[0] && portTailSplits(rest.slice(dotted[0].length))) {
        out += `${text.slice(index, index + scheme + host + dotted[0].length)} `;
        index += scheme + host + dotted[0].length + 1;
        continue;
      }
    }
    const end = text.slice(index).search(/\s/);
    const next = end === -1 ? text.length : index + end;
    out += text.slice(index, next);
    index = next;
  }
  return out;
}

function draftHostLength(authority: string): number | null {
  const match = DRAFT_HOST_END.exec(authority);
  return match ? match[0].length : null;
}

const HOST_PUNCT = "!#$&()*+,;=~";
const DRAFT_DOT_LOOKALIKE = new Set([
  0x00b7, 0x2022, 0x2027, 0x2219, 0x22c5, 0x30fb, 0xff0e, 0xfe52, 0xff61,
]);

/** 点状字符拼成的裸主机名不盖住后面的网址。带协议的仍是一条。 */
function openLookalikeHost(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    if (schemeAt(text, index) > 0) {
      const end = text.slice(index).search(/\s/);
      const next = end === -1 ? text.length : index + end;
      out += text.slice(index, next);
      index = next;
      continue;
    }
    const skip = lookalikeHostSkip(text, index);
    if (skip > 0) {
      out += " ";
      index += skip;
      continue;
    }
    out += text.charAt(index);
    index += 1;
  }
  return out;
}

function lookalikeHostSkip(text: string, index: number): number {
  if (index > 0 && /[A-Za-z0-9_]/.test(text.charAt(index - 1))) {
    return 0;
  }
  const first = readDraftLabel(text, index);
  if (first === 0) {
    return 0;
  }
  let cursor = index + first;
  let sawLookalike = false;
  while (cursor < text.length) {
    const lookalike = DRAFT_DOT_LOOKALIKE.has(text.charCodeAt(cursor));
    if (text.charAt(cursor) !== "." && !lookalike) {
      break;
    }
    const next = readDraftLabel(text, cursor + 1);
    if (next === 0) {
      break;
    }
    if (lookalike) {
      sawLookalike = true;
    }
    cursor += 1 + next;
  }
  if (!sawLookalike) {
    return 0;
  }
  if (text.charAt(cursor) !== "/" && text.charAt(cursor) !== "?") {
    return 0;
  }
  const body = text.slice(cursor + 1);
  if (
    schemeAt(body, 0) > 0 ||
    strictBareEnd(body, 0) !== null ||
    bareIpAt(body)
  ) {
    return cursor + 1 - index;
  }
  return 0;
}

const DRAFT_SCHEME_LETTER = new Set([
  0x0406, 0x0410, 0x0415, 0x041e, 0x0420, 0x0421, 0x0423, 0x0425, 0x0430,
  0x0435, 0x043e, 0x0440, 0x0441, 0x0443, 0x0445, 0x0456,
]);

function schemeLetter(code: number): boolean {
  return (
    DRAFT_SCHEME_LETTER.has(code) ||
    (code >= 0xff21 && code <= 0xff3a) ||
    (code >= 0xff41 && code <= 0xff5a)
  );
}

/** 形近字母紧挨在协议前面时另开后面的网址。带协议的同一段仍留在一起。 */
function openSchemeLetter(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    if (schemeAt(text, index) > 0) {
      const end = text.slice(index).search(/\s/);
      const next = end === -1 ? text.length : index + end;
      out += text.slice(index, next);
      index = next;
      continue;
    }
    if (schemeLetter(text.charCodeAt(index)) && schemeAt(text, index + 1) > 0) {
      out += " ";
      index += 1;
      continue;
    }
    out += text.charAt(index);
    index += 1;
  }
  return out;
}

/** 点状字符紧挨在 `@` 前面时，带协议的主机名在这里结束。后面的网址另开。 */
function lookalikeBeforeAt(rest: string): number {
  let cursor = 0;
  while (DRAFT_DOT_LOOKALIKE.has(rest.charCodeAt(cursor))) {
    cursor += 1;
  }
  if (cursor === 0 || rest.charAt(cursor) !== "@") {
    return 0;
  }
  if (schemeAt(rest, cursor + 1) === 0) {
    return 0;
  }
  return cursor + 1;
}

function labelEndsUrl(host: string, rest: string): boolean {
  if (rest.startsWith("-")) {
    return !hyphenLabelFits(host, rest);
  }
  if (
    !rest.startsWith(".") ||
    rest.charAt(1) === "@" ||
    DRAFT_DOT_LOOKALIKE.has(rest.charCodeAt(1))
  ) {
    return false;
  }
  const next = rest.codePointAt(1);
  if (next !== undefined && draftLabelCode(next)) {
    return false;
  }
  return !/^[:/?_]/.test(rest.charAt(1));
}

/** 连字符后面的标签字仍放得进 63 个字时，这一段不切开。 */
function hyphenLabelFits(host: string, rest: string): boolean {
  const dot = host.lastIndexOf(".");
  const label = dot === -1 ? host : host.slice(dot + 1);
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?$/.test(label)) {
    return false;
  }
  let units = label.length;
  let index = 0;
  while (index < rest.length && units < 63) {
    const mark = rest.charAt(index);
    if (mark === "-" || mark === "_") {
      let look = index;
      let marks = 0;
      while (
        look < rest.length &&
        (rest.charAt(look) === "-" || rest.charAt(look) === "_")
      ) {
        look += 1;
        marks += 1;
      }
      const after = draftHostUnit(rest, look);
      if (after === 0 || units + marks >= 63) {
        break;
      }
      units += marks + 1;
      index = look + after;
      continue;
    }
    const size = draftHostUnit(rest, index);
    if (size === 0) {
      break;
    }
    units += 1;
    index += size;
  }
  if (index === 0) {
    return false;
  }
  if (
    index < rest.length &&
    (draftHostUnit(rest, index) > 0 ||
      rest.charAt(index) === "-" ||
      rest.charAt(index) === "_")
  ) {
    return false;
  }
  const next = rest.charAt(index);
  return (
    next.length === 0 ||
    next === "/" ||
    next === "?" ||
    next === "." ||
    next === ":" ||
    next === "@" ||
    next === "#" ||
    next === " "
  );
}

function draftHostUnit(text: string, index: number): number {
  const code = text.codePointAt(index);
  if (code === undefined) {
    return 0;
  }
  if (code <= 0x7f) {
    return /[A-Za-z0-9]/.test(text.charAt(index)) ? 1 : 0;
  }
  if (!draftLabelCode(code)) {
    return 0;
  }
  return code > 0xffff ? 2 : 1;
}

/** Android 收进标签的字。带协议的主机名在点号后面仍接着这个字。 */
function draftLabelCode(code: number): boolean {
  if (
    code === 0x00a0 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x3000
  ) {
    return false;
  }
  if (code >= 0x00a0 && code <= 0xd7ff) {
    return true;
  }
  if (code >= 0xf900 && code <= 0xfdcf) {
    return true;
  }
  if (code >= 0xfdf0 && code <= 0xffef) {
    return true;
  }
  if (code >= 0x20000 && code <= 0xdfffd) {
    return (code & 0xffff) <= 0xfffd;
  }
  if (code >= 0xe1000 && code <= 0xefffd) {
    return (code & 0xffff) <= 0xfffd;
  }
  return false;
}

/** 路径还没开始时，这些标点结束主机名。端口和 `user:pass@` 仍属于这一条。 */
function hostPunctEnds(rest: string): boolean {
  if (rest.startsWith("://") || isPort(rest) || passwordUserinfo(rest)) {
    return false;
  }
  if (rest.startsWith(":")) {
    return true;
  }
  return rest.length > 0 && HOST_PUNCT.includes(rest.charAt(0));
}

function isPort(rest: string): boolean {
  return /^:\d{1,5}(?!\d)/.test(rest);
}

/** 点号后面的端口仍属于这一条。端口后再遇标点，才另开后面的网址。 */
function portTailSplits(after: string): boolean {
  return (
    hostPunctEnds(after) ||
    after.startsWith("-") ||
    (after.startsWith(".") && schemeAt(after, 1) > 0)
  );
}

function passwordUserinfo(rest: string): boolean {
  const password =
    /^:(?:%[0-9A-Fa-f]{2}|[A-Za-z0-9$._+!*'(),;?&=-]){1,25}@/.exec(rest);
  if (!password?.[0]) {
    return false;
  }
  return atCanFinish(rest.slice(password[0].length - 1));
}

/** `@` 后面能接上主机名、路径、端口或 `_` 时，用户信息才成立。 */
function atCanFinish(rest: string): boolean {
  const next = rest.charAt(1);
  if (next === "" || next === "/" || next === "?" || next === "_") {
    return true;
  }
  if (/[A-Za-z0-9]/.test(next) || next.charCodeAt(0) > 0x7f) {
    return true;
  }
  if (next !== ":") {
    return false;
  }
  const port = /^:\d{1,5}(?!\d)/.exec(rest.slice(1));
  if (!port?.[0]) {
    return false;
  }
  const after = rest.charAt(1 + port[0].length);
  return after === "" || !/[A-Za-z0-9_]/.test(after);
}

function skipUnfinishedAt(text: string, index: number): number {
  while (index < text.length && !/\s/.test(text.charAt(index))) {
    if (schemeAt(text, index) > 0) {
      return index;
    }
    index += 1;
  }
  return index;
}

/** 裸域名和 `www.` 停在最后一个标签。连字符、点号或标签字符后面的网址另开一条。 */
function openBareEnd(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    if (schemeAt(text, index) > 0) {
      const end = text.slice(index).search(/\s/);
      const next = end === -1 ? text.length : index + end;
      out += text.slice(index, next);
      index = next;
      continue;
    }
    const loose = bareDomainEnd(text, index);
    const strict = strictBareEnd(text, index);
    if (loose !== null && (strict === null || strict < loose)) {
      const inner = urlAfterLoose(text.slice(loose));
      if (inner >= 0) {
        if (strict !== null) {
          out += `${text.slice(index, strict)} `;
        }
        index = loose + inner;
        continue;
      }
    }
    const domain = strict ?? loose;
    if (domain === null) {
      out += text.charAt(index);
      index += 1;
      continue;
    }
    const rest = text.slice(domain);
    const port = /^:\d{1,5}(?!\d)/.exec(rest);
    if (port?.[0]) {
      const after = rest.slice(port[0].length);
      if (
        after.startsWith("-") ||
        (after.startsWith(".") && schemeAt(after, 1) > 0)
      ) {
        out += `${text.slice(index, domain + port[0].length)} `;
        index = domain + port[0].length + 1;
        continue;
      }
    }
    const dotted = bareDotSkip(rest);
    if (dotted > 0) {
      out += `${text.slice(index, domain)} `;
      index = domain + dotted;
      continue;
    }
    const lookalike = bareLookalikeDotSkip(rest);
    if (lookalike > 0) {
      out += `${text.slice(index, domain)} `;
      index = domain + lookalike;
      continue;
    }
    const glued = gluedMappedScheme(rest);
    if (glued > 0) {
      const scheme = schemeAt(rest, glued);
      const end = text.slice(index).search(/\s/);
      const next = end === -1 ? text.length : index + end;
      const schemeAtIndex = domain + glued;
      out += text.slice(index, schemeAtIndex);
      out += `${text.slice(schemeAtIndex, schemeAtIndex + scheme - 3)}:x`;
      out += text.slice(schemeAtIndex + scheme, next);
      index = next;
      continue;
    }
    const letter = bareLetterSkip(rest);
    if (letter > 0) {
      out += `${text.slice(index, domain)} `;
      index = domain + letter;
      continue;
    }
    const label = bareLabelSkip(rest);
    if (label > 0) {
      out += `${text.slice(index, domain)} `;
      index = domain + label;
      continue;
    }
    if (
      rest.startsWith("/") ||
      rest.startsWith("?") ||
      port?.[0] ||
      !bareTailSplit(rest)
    ) {
      const end = text.slice(index).search(/\s/);
      const next = end === -1 ? text.length : index + end;
      out += text.slice(index, next);
      index = next;
      continue;
    }
    out += `${text.slice(index, domain)} `;
    index = domain + 1;
  }
  return out;
}

function isStrictTld(label: string): boolean {
  return label.length > 0 && STRICT_TLD_LABEL.test(label);
}

/** 裸域名和 `www.` 停在 Android 认的顶级域。认不出的后缀另开后面的网址。 */
function strictBareEnd(text: string, index: number): number | null {
  if (index > 0 && /[A-Za-z0-9_]/.test(text.charAt(index - 1))) {
    return null;
  }
  const address = new RegExp(`^(?:${DRAFT_IP})`, "i").exec(text.slice(index));
  if (address?.[0] && bareIpAt(text.slice(index))) {
    return index + address[0].length;
  }
  let cursor = index;
  if (text.slice(cursor, cursor + 4).toLowerCase() === "www.") {
    cursor += 4;
  }
  const first = readDraftLabel(text, cursor);
  if (first === 0) {
    return null;
  }
  let labels = 1;
  cursor += first;
  let lastStrict: number | null = null;
  while (text.charAt(cursor) === ".") {
    if (schemeAt(text, cursor + 1) > 0) {
      break;
    }
    const next = readDraftLabel(text, cursor + 1);
    if (next === 0) {
      break;
    }
    const labelStart = cursor + 1;
    cursor += 1 + next;
    labels += 1;
    if (!isStrictTld(text.slice(labelStart, cursor))) {
      break;
    }
    if (labels >= 2) {
      lastStrict = cursor;
    }
  }
  return lastStrict;
}

function urlAfterLoose(rest: string): number {
  let skip = 0;
  const port = /^:\d{1,5}(?!\d)/.exec(rest);
  if (port?.[0]) {
    skip = port[0].length;
  }
  const tail = rest.slice(skip);
  if (!tail.startsWith("/") && !tail.startsWith("?")) {
    return -1;
  }
  const body = tail.slice(1);
  if (
    schemeAt(body, 0) > 0 ||
    strictBareEnd(body, 0) !== null ||
    bareIpAt(body)
  ) {
    return skip + 1;
  }
  return -1;
}

function bareDomainEnd(text: string, index: number): number | null {
  if (index > 0 && /[A-Za-z0-9_]/.test(text.charAt(index - 1))) {
    return null;
  }
  let cursor = index;
  const www = text.slice(cursor, cursor + 4).toLowerCase() === "www.";
  if (www) {
    cursor += 4;
  }
  const first = readDraftLabel(text, cursor);
  if (first === 0) {
    return null;
  }
  let labels = 1;
  cursor += first;
  while (text.charAt(cursor) === ".") {
    if (schemeAt(text, cursor + 1) > 0) {
      break;
    }
    const next = readDraftLabel(text, cursor + 1);
    if (next === 0) {
      break;
    }
    cursor += 1 + next;
    labels += 1;
  }
  if (www ? labels < 1 : labels < 2) {
    return null;
  }
  return cursor;
}

function readDraftLabel(text: string, index: number): number {
  if (!/[A-Za-z0-9]/.test(text.charAt(index))) {
    return 0;
  }
  let cursor = index + 1;
  const limit = Math.min(text.length, index + 63);
  while (cursor < limit) {
    const current = text.charAt(cursor);
    if (!/[A-Za-z0-9_-]/.test(current)) {
      break;
    }
    if (
      (current === "-" || current === "_") &&
      schemeAt(text, cursor + 1) > 0
    ) {
      break;
    }
    cursor += 1;
  }
  while (cursor > index && /[-_]/.test(text.charAt(cursor - 1))) {
    cursor -= 1;
  }
  return cursor === index ? 0 : cursor - index;
}

function bareTailSplit(rest: string): boolean {
  const code = rest.codePointAt(0);
  if (code !== undefined && boundaryMark(code)) {
    return false;
  }
  if (rest.startsWith("-") || rest.startsWith(".")) {
    return schemeAt(rest, 1) > 0;
  }
  return (
    rest.length > 0 &&
    schemeAt(rest, 1) > 0 &&
    !/[A-Za-z0-9_./?#:]/.test(rest.charAt(0))
  );
}

/** 裸域名和 `www.` 不把路径前的点号留在这一段。点号后面的网址另开。 */
function bareDotSkip(rest: string): number {
  if (!rest.startsWith(".")) {
    return 0;
  }
  const afterDot = rest.slice(1);
  if (!/^[:/?]/.test(afterDot)) {
    return 0;
  }
  let skip = 1;
  const port = /^:\d{1,5}(?!\d)/.exec(afterDot);
  if (port?.[0]) {
    skip += port[0].length;
  }
  const tail = rest.slice(skip);
  if (tail.startsWith("/") || tail.startsWith("?")) {
    const body = tail.slice(1);
    if (
      schemeAt(body, 0) > 0 ||
      bareDomainEnd(body, 0) !== null ||
      bareIpAt(body)
    ) {
      skip += 1;
    }
  }
  return skip;
}

/** 裸域名和 `www.` 在 ASCII 点后的点状字符前结束。后面的网址另开。 */
function bareLookalikeDotSkip(rest: string): number {
  if (!rest.startsWith(".")) {
    return 0;
  }
  let index = 1;
  while (DRAFT_DOT_LOOKALIKE.has(rest.charCodeAt(index))) {
    index += 1;
  }
  if (index === 1) {
    return 0;
  }
  const after = rest.slice(index);
  if (schemeAt(after, 0) > 0) {
    return index;
  }
  if (!after.startsWith("/") && !after.startsWith("?")) {
    return 0;
  }
  const body = after.slice(1);
  if (
    schemeAt(body, 0) > 0 ||
    strictBareEnd(body, 0) !== null ||
    bareIpAt(body)
  ) {
    return index + 1;
  }
  return 0;
}

/** 没有协议的主机名在 Android 留在标签里的字前面结束。后面是严格域名时，标签字、句号和点状间隔号留给主机名扫描。 */
function bareLabelSkip(rest: string): number {
  const code = rest.codePointAt(0);
  if (code === undefined || !draftLabelCode(code) || boundaryMark(code)) {
    return 0;
  }
  if (code === 0x3002 || DRAFT_DOT_LOOKALIKE.has(code)) {
    return joiningDotSkip(rest);
  }
  const run = labelRunLength(rest);
  if (strictLabelTail(rest.slice(run))) {
    return 0;
  }
  const after = rest.slice(String.fromCodePoint(code).length);
  if (
    draftMappedTail(code) &&
    (draftDomainContinues(after) || schemeAt(after, 0) > 0)
  ) {
    return 0;
  }
  return String.fromCodePoint(code).length;
}

/** 连续的标签字。句号和点状间隔号另外判断。 */
function labelRunLength(rest: string): number {
  let index = 0;
  while (index < rest.length) {
    const code = rest.codePointAt(index);
    if (
      code === undefined ||
      code === 0x3002 ||
      DRAFT_DOT_LOOKALIKE.has(code) ||
      !draftLabelCode(code) ||
      boundaryMark(code)
    ) {
      break;
    }
    index += String.fromCodePoint(code).length;
  }
  return index;
}

/** 标签字后面是 Android 认的域名时，这一段留给主机名扫描收成 x。 */
function strictLabelTail(rest: string): boolean {
  const head = /^[^/?#\s]+/.exec(rest)?.[0] ?? "";
  const labels = head.split(".");
  if (labels.length < 2) {
    return false;
  }
  const tld = labels[labels.length - 1] ?? "";
  if (!isStrictTld(tld)) {
    return false;
  }
  return labels.every((label) => label.length > 0 && label.length <= 63);
}

/** 一段句号或点状间隔号后面是 ASCII 域名时留下。否则在这里结束主机名。 */
function joiningDotSkip(rest: string): number {
  let index = 0;
  while (index < rest.length) {
    const code = rest.codePointAt(index);
    if (
      code === undefined ||
      (code !== 0x3002 && !DRAFT_DOT_LOOKALIKE.has(code))
    ) {
      break;
    }
    index += String.fromCodePoint(code).length;
  }
  if (index === 0 || draftDomainContinues(rest.slice(index))) {
    return 0;
  }
  return index;
}

/** 写完的主机名后面紧挨协议时，映射字母不另开后面的网址。 */
function gluedMappedScheme(rest: string): number {
  const code = rest.codePointAt(0);
  if (code === undefined || !draftMappedTail(code)) {
    return 0;
  }
  const size = String.fromCodePoint(code).length;
  return schemeAt(rest, size) > 0 ? size : 0;
}

function draftDomainContinues(rest: string): boolean {
  return /^[A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,63}(?![A-Za-z0-9-])/.test(
    rest,
  );
}

function draftMappedTail(code: number): boolean {
  if (code <= 0x7f) {
    return false;
  }
  const sample = `b${String.fromCodePoint(code)}t`;
  return (
    foldMappedLatin(sample) !== sample ||
    foldCyrillicLookalikes(sample) !== sample ||
    foldFullwidthLatin(sample) !== sample
  );
}

function bareLetterSkip(rest: string): number {
  let index = 0;
  while (rest.charAt(index) === "_") {
    index += 1;
  }
  const code = rest.codePointAt(index);
  if (code === undefined || code <= 0x7f || boundaryMark(code)) {
    return 0;
  }
  const after = rest.slice(index + String.fromCodePoint(code).length);
  if (schemeAt(after, 0) > 0) {
    if (draftMappedTail(code)) {
      return 0;
    }
    return rest.length - after.length;
  }
  if (!after.startsWith("/") && !after.startsWith("?")) {
    return 0;
  }
  const body = after.slice(1);
  if (
    schemeAt(body, 0) > 0 ||
    strictBareEnd(body, 0) !== null ||
    bareIpAt(body)
  ) {
    return rest.length - body.length;
  }
  return 0;
}

function schemeAfterHostRun(authority: string): number | null {
  if (!/[A-Za-z0-9.-]/.test(authority.charAt(0))) {
    return null;
  }
  for (let index = 1; index < authority.length; index += 1) {
    if (schemeAt(authority, index) > 0) {
      return index;
    }
    if (!/[A-Za-z0-9.-]/.test(authority.charAt(index))) {
      return null;
    }
  }
  return null;
}

/** 停住的字符改成空格，后面的网址另算一条。紧挨着协议的 `%` 也停住。`%2http` 仍粘住。 */
function openDraftStops(text: string): string {
  let out = "";
  for (let index = 0; index < text.length; index += 1) {
    if (isPathPair(text, index)) {
      out += text.charAt(index) + text.charAt(index + 1);
      index += 1;
      continue;
    }
    const current = text.charAt(index);
    if (keepLookalikeNewline(text, index)) {
      out += current;
      continue;
    }
    if (DRAFT_STOP_CHAR.test(current) || isSchemePercent(text, index)) {
      out += " ";
      continue;
    }
    out += current;
  }
  return out;
}

/** 点状字符旁边的换行仍交给粘连扫描吃掉，短链才接得上。 */
function keepLookalikeNewline(text: string, index: number): boolean {
  if (text.charAt(index) !== "\n" || schemeAt(text, index + 1) > 0) {
    return false;
  }
  if (!/[A-Za-z0-9]/.test(text.charAt(index + 1))) {
    return false;
  }
  if (index > 0 && DRAFT_DOT_LOOKALIKE.has(text.charCodeAt(index - 1))) {
    return true;
  }
  let cursor = index - 1;
  if (cursor < 0 || !/[A-Za-z0-9]/.test(text.charAt(cursor))) {
    return false;
  }
  while (cursor >= 0 && /[A-Za-z0-9_-]/.test(text.charAt(cursor))) {
    cursor -= 1;
  }
  return cursor >= 0 && DRAFT_DOT_LOOKALIKE.has(text.charCodeAt(cursor));
}

function isSchemePercent(text: string, index: number): boolean {
  if (text.charAt(index) !== "%") {
    return false;
  }
  const next = text.slice(index + 1, index + 9).toLowerCase();
  return (
    next.startsWith("http://") ||
    next.startsWith("https://") ||
    next.startsWith("tg://")
  );
}

/** Android 路径类留住的增补字符。高位代理和低位代理成对出现。 */
function isPathPair(text: string, index: number): boolean {
  const high = text.charCodeAt(index);
  const low = text.charCodeAt(index + 1);
  if (!Number.isInteger(low) || low < 0xdc00 || low > 0xdffd) {
    return false;
  }
  return (
    (high >= 0xd840 && high <= 0xd87f) ||
    (high >= 0xd880 && high <= 0xd8ff) ||
    (high >= 0xd900 && high <= 0xdb3f) ||
    (high >= 0xdb44 && high <= 0xdb7f)
  );
}

function sideUrls(message: Record<string, unknown>): string[] {
  const urls: string[] = [];
  pushContactUrls(message, urls);
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
    if (gameDescriptionOpen(message, game)) {
      pushOpenedSpans(game.description, urls);
    }
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
    if (invoiceDescriptionOpen(message)) {
      pushOpenedSpans(invoice.description, urls);
    }
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

function pushOpenedSpans(value: unknown, urls: string[]): void {
  if (typeof value !== "string") {
    return;
  }
  for (const url of urlsInText(value)) {
    const span = androidUrlSpan(url);
    if (span !== null) {
      urls.push(span);
    }
  }
}

/** 正文为空时，游戏说明才画出来并按网页链接高亮。 */
function gameDescriptionOpen(
  message: Record<string, unknown>,
  game: Record<string, unknown>,
): boolean {
  if (typeof message.text === "string" && message.text.length > 0) {
    return false;
  }
  if (typeof message.caption === "string" && message.caption.length > 0) {
    return false;
  }
  return typeof game.text !== "string" || game.text.length === 0;
}

/** 账单说明会被当成正文。已有实体时客户端不再自动加链接。 */
function invoiceDescriptionOpen(message: Record<string, unknown>): boolean {
  if (Array.isArray(message.entities) && message.entities.length > 0) {
    return false;
  }
  return !(
    Array.isArray(message.caption_entities) &&
    message.caption_entities.length > 0
  );
}

/** 联系人卡片里的 URL 行会打开浏览器。电话、邮箱和备注不打开。 */
function pushContactUrls(
  message: Record<string, unknown>,
  urls: string[],
): void {
  const contact = message.contact;
  if (!isRecord(contact) || typeof contact.vcard !== "string") {
    return;
  }
  for (const value of vcardUrlValues(contact.vcard)) {
    urls.push(/^https?:/i.test(value) ? value : `http://${value}`);
  }
}

function vcardUrlValues(vcard: string): string[] {
  const found: string[] = [];
  for (const line of vcardLines(vcard)) {
    const colon = line.indexOf(":");
    if (colon <= 0) {
      continue;
    }
    const left = line.slice(0, colon);
    const name = left.split(";")[0]?.trim().toLowerCase();
    if (name !== "url") {
      continue;
    }
    let value = line.slice(colon + 1).trim();
    if (/encoding=quoted-printable/i.test(left)) {
      value = decodeQuotedPrintable(value).trim();
    }
    if (value.length === 0 || value.length > MAX_LINK) {
      continue;
    }
    found.push(value);
    if (found.length >= MAX_HOSTS) {
      break;
    }
  }
  return found;
}

function vcardLines(vcard: string): string[] {
  const raw = vcard.slice(0, 16384).split(/\r\n|\n|\r/);
  const lines: string[] = [];
  for (const rawLine of raw) {
    const previous = lines[lines.length - 1];
    if (
      previous !== undefined &&
      (rawLine.startsWith(" ") || rawLine.startsWith("\t"))
    ) {
      lines[lines.length - 1] = previous + rawLine.slice(1);
      continue;
    }
    if (
      previous?.endsWith("=") &&
      /encoding=quoted-printable/i.test(previous)
    ) {
      lines[lines.length - 1] = previous.slice(0, -1) + rawLine;
      continue;
    }
    lines.push(rawLine);
  }
  return lines;
}

function decodeQuotedPrintable(value: string): string {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const char = value.charAt(index);
    const hex = value.slice(index + 1, index + 3);
    if (char === "=" && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      index += 2;
      continue;
    }
    const code = char.charCodeAt(0);
    if (code < 128) {
      bytes.push(code);
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
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
  pushOpenedQuery(button.switch_inline_query, urls);
  pushOpenedQuery(button.switch_inline_query_current_chat, urls);
  const chosen = button.switch_inline_query_chosen_chat;
  if (isRecord(chosen)) {
    pushOpenedQuery(chosen.query, urls);
  }
}

/** 查询会写进输入框。发送预览对这段文字做网页链接高亮。 */
function pushOpenedQuery(value: unknown, urls: string[]): void {
  pushPlainUrls(value, urls);
  pushOpenedSpans(value, urls);
}

/** 普通链接仍停在 2048。分享、私聊预填和 Passport 回调可以到草稿上限。 */
function withinLinkLimit(value: string): boolean {
  if (value.length <= MAX_LINK) {
    return true;
  }
  if (value.length > OPENED_DRAFT) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(/^(?:https?:|tg:)/i.test(value) ? value : `http://${value}`);
  } catch {
    return false;
  }
  return (
    isTelegramShare(url) || isTelegramMsg(url) || isTelegramPassport(value, url)
  );
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
    !withinLinkLimit(value)
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
                foldMappedLatin(
                  foldFullwidthLatin(
                    foldCyrillicLookalikes(foldEncodedGaps(value)),
                  ),
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
        ...wrappedExtras(folded, url, value),
        ...msgTextExtras(folded, url, value),
        ...usernameDraftExtras(folded, url, value),
        ...passportExtras(folded, url, value),
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
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
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
  const rawPath = url.pathname || "/";
  const path = rawPath.replace(/\/+$/, "") || "/";
  return packHost(
    host,
    isTelegramInvite(host, path) ||
      isBusinessChatLink(host, rawPath) ||
      isPercentSpaceInvite(folded, host),
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
  source = folded,
): { host: string; invite: boolean }[] {
  if (!isTelegramShare(url)) {
    return [];
  }
  const found: { host: string; invite: boolean }[] = [];
  const embedded = openedDraft(queryValue(source, "url"));
  if (embedded !== null) {
    for (const raw of queryUrls(embedded)) {
      pushClosedUrl(raw, found);
    }
  }
  const text = openedDraft(queryValue(source, "text"));
  if (text !== null) {
    for (const raw of openedDraftUrls(text)) {
      pushDraftUrl(raw, found, false);
    }
  }
  return found;
}

function msgTextExtras(
  folded: string,
  url: URL,
  source = folded,
): { host: string; invite: boolean }[] {
  if (!isTelegramMsg(url)) {
    return [];
  }
  const found: { host: string; invite: boolean }[] = [];
  const embedded = openedDraft(queryValue(source, "url"));
  if (embedded !== null) {
    for (const raw of queryUrls(embedded)) {
      pushClosedUrl(raw, found);
    }
  }
  const text = openedDraft(queryValue(source, "text"));
  if (text === null) {
    return found;
  }
  for (const raw of openedDraftUrls(text)) {
    pushDraftUrl(raw, found, true);
  }
  return found;
}

function passportExtras(
  folded: string,
  url: URL,
  source = folded,
): { host: string; invite: boolean }[] {
  const callback = passportCallback(folded, url, source);
  if (callback === null) {
    return [];
  }
  const found: { host: string; invite: boolean }[] = [];
  for (const raw of queryUrls(callback)) {
    pushClosedUrl(raw, found);
  }
  return found;
}

/** 桌面端取消 Passport 时打开 `callback_url`。只留主机名。 */
function passportCallback(raw: string, url: URL, source = raw): string | null {
  if (!isTelegramPassport(raw, url)) {
    return null;
  }
  return openedDraft(queryValue(source, "callback_url"));
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
  return parts.length === 1 && only !== undefined && /^\d+$/.test(only);
}

function isPassportPath(parts: readonly string[]): boolean {
  if (parts[0] !== "telegrampassport") {
    return false;
  }
  if (parts.length === 1) {
    return true;
  }
  if (parts.length === 2) {
    return /^[A-Za-z0-9._-]+$/.test(parts[1] ?? "");
  }
  if (parts.length === 3) {
    const mid = (parts[1] ?? "").toLowerCase();
    const last = (parts[2] ?? "").toLowerCase();
    if (mid === "s" && (/^\d+$/.test(last) || last === "live")) {
      return true;
    }
    if ((mid === "a" || mid === "c") && /^\d+$/.test(last)) {
      return true;
    }
    return /^\d+$/.test(parts[1] ?? "") && /^\d+$/.test(parts[2] ?? "");
  }
  return false;
}

function usernameDraftExtras(
  folded: string,
  url: URL,
  source = folded,
): { host: string; invite: boolean }[] {
  if (!isUsernameDraft(url)) {
    return [];
  }
  const text = queryValue(source, "text");
  if (text === null || text.length === 0 || text.length > MAX_TEXT) {
    return [];
  }
  const found: { host: string; invite: boolean }[] = [];
  for (const raw of openedDraftUrls(text)) {
    pushDraftUrl(raw, found, true);
  }
  return found;
}

const DRAFT_URL_GAP = new RegExp(
  `[ \\t\\n\\r${String.fromCharCode(0x0b)}${String.fromCharCode(0x0c)}\u00A0\u2000-\u200A\u2028\u2029\u202F\u3000]+`,
);

function queryUrls(value: string): string[] {
  return value.split(DRAFT_URL_GAP).filter((part) => part.length > 0);
}

function closedIpUrl(raw: string): string {
  if (!new RegExp(`^(?:${DRAFT_IP})${DRAFT_IP_TAIL}$`, "i").test(raw)) {
    return "";
  }
  return `http://${raw}`;
}

function closedBareUrl(raw: string): string {
  if (!new RegExp(`^${DRAFT_BARE}$`, "i").test(raw)) {
    return "";
  }
  return `http://${raw}`;
}

function pushClosedUrl(
  raw: string,
  found: { host: string; invite: boolean }[],
): void {
  const opened = openPathQuote(
    openPlainTg(
      openBareEnd(
        openSchemeLetter(
          openLookalikeHost(
            openLongLabel(
              openLongUserinfo(
                openStoppingSpace(
                  openFinishedEncodedDot(foldBoundaryMark(raw)),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  if (opened !== raw) {
    for (const part of queryUrls(opened)) {
      pushClosedUrl(part, found);
    }
    return;
  }
  const inner =
    hostFromUrl(raw, false) ??
    hostFromUrl(closedIpUrl(raw), false) ??
    hostFromUrl(closedBareUrl(raw), false);
  if (inner) {
    found.push({ host: inner.host, invite: inner.invite });
    for (const extra of inner.extras ?? []) {
      found.push(extra);
    }
  }
  const span = androidUrlSpan(raw);
  if (span === null) {
    return;
  }
  const shortened = hostFromUrl(span, false);
  if (!shortened) {
    return;
  }
  found.push({ host: shortened.host, invite: shortened.invite });
  for (const extra of shortened.extras ?? []) {
    found.push(extra);
  }
}

function pushDraftUrl(
  raw: string,
  found: { host: string; invite: boolean }[],
  nested: boolean,
): void {
  appendParsed(hostFromUrl(raw, false), found, nested);
  const span = androidUrlSpan(raw);
  if (span === null) {
    return;
  }
  appendParsed(hostFromUrl(span, false), found, nested);
}

function appendParsed(
  link: {
    host: string;
    invite: boolean;
    extras?: { host: string; invite: boolean }[];
  } | null,
  found: { host: string; invite: boolean }[],
  nested: boolean,
): void {
  if (!link) {
    return;
  }
  found.push({ host: link.host, invite: link.invite });
  if (!nested) {
    return;
  }
  for (const extra of link.extras ?? []) {
    found.push(extra);
  }
}

function isUsernameDraft(url: URL): boolean {
  if (profileReplacesDraft(url) || resolveMediaReplacesDraft(url)) {
    return false;
  }
  if (url.protocol === "tg:") {
    const host = url.hostname.toLowerCase();
    const path = url.pathname.replace(/^\/+|\/+$/g, "").toLowerCase();
    const command = host.length > 0 ? host : path;
    if (command !== "resolve") {
      return false;
    }
    const domain = searchParam(url, "domain");
    if (domain !== null && domain.length > 0) {
      if (domain === "s") {
        const appname = searchParam(url, "appname");
        return appname !== null && isPublicUsername(appname);
      }
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
  if (isGroupCallPath(host, url.pathname)) {
    return false;
  }
  if (host === "call.t.me" && parts.length > 0) {
    return false;
  }
  if (aiStyleReplacesDraft(host, parts)) {
    return false;
  }
  if (invoiceReplacesDraft(host, parts)) {
    return false;
  }
  if (emojiSetReplacesDraft(host, url.pathname, parts)) {
    return false;
  }
  if (stickerSetReplacesDraft(host, url.pathname, parts)) {
    return false;
  }
  if (themeSlugReplacesDraft(host, url.pathname, parts)) {
    return false;
  }
  if (languagePackReplacesDraft(host, url.pathname, parts)) {
    return false;
  }
  if (giftSlugReplacesDraft(host, url.pathname, parts)) {
    return false;
  }
  if (auctionSlugReplacesDraft(host, url.pathname, parts)) {
    return false;
  }
  if (wallPaperReplacesDraft(host, url.pathname, parts)) {
    return false;
  }
  if (contactTokenReplacesDraft(host, url.pathname, parts)) {
    return false;
  }
  if (newBotReplacesDraft(host, parts)) {
    return false;
  }
  if (boostReplacesDraft(host, url, parts)) {
    return false;
  }
  if (folderInviteDropsDraft(host, parts)) {
    return false;
  }
  if (addListReplacesDraft(host, url.pathname, parts)) {
    return false;
  }
  if (joinChatReplacesDraft(host, url.pathname, parts)) {
    return false;
  }
  if (businessChatReplacesDraft(host, url.pathname, parts)) {
    return false;
  }
  if (privatePostDropsDraft(host, parts)) {
    return false;
  }
  if (confirmPhoneDropsDraft(host, parts)) {
    return false;
  }
  if (isUserSubdomain(host) && isUserSubdomainPath(parts)) {
    return true;
  }
  const first = parts[0];
  if (parts.length === 1 && first !== undefined && isExactDraftHost(host)) {
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
  if (host === "s.t.me" && parts.length === 1) {
    const label = parts[0];
    return label !== undefined && isPublicUsername(label);
  }
  if (isAndroidStrippedDraft(host, parts)) {
    return true;
  }
  if (isAppNamePath(host, parts)) {
    return true;
  }
  return isUserPostPath(host, parts);
}

/** Android 先拿掉路径开头的 `s`，剩下的用户名加一段仍会写草稿。 */
function isAndroidStrippedDraft(
  host: string,
  parts: readonly string[],
): boolean {
  const rest = androidDraftRest(host, parts);
  if (rest === null) {
    return false;
  }
  return isAppNamePath("t.me", rest) || isUserPostPath("t.me", rest);
}

function androidDraftRest(
  host: string,
  parts: readonly string[],
): readonly string[] | null {
  if (host === "s.t.me" && parts.length === 2) {
    return parts;
  }
  if (
    (host === "t.me" || host === "telegram.me" || host === "telegram.dog") &&
    parts.length === 3 &&
    parts[0] === "s"
  ) {
    return parts.slice(1);
  }
  return null;
}

/** 查询名正好是 `profile` 且值不是 `0` 或 `false` 时打开资料页。会改掉资料页的参数仍写草稿。 */
function profileReplacesDraft(url: URL): boolean {
  return androidOpensProfile(url) && !desktopOverridesProfile(url);
}

/** `tg://resolve` 上的非零动态、相册或礼物收集打开媒体，不写草稿。网页上的同名查询仍写。 */
function resolveMediaReplacesDraft(url: URL): boolean {
  if (url.protocol !== "tg:") {
    return false;
  }
  return (
    nonzeroClientInt(firstExactParam(url, "story")) ||
    nonzeroClientInt(firstExactParam(url, "album")) ||
    nonzeroClientInt(firstExactParam(url, "collection"))
  );
}

function firstExactParam(url: URL, name: string): string | null {
  for (const [key, value] of url.searchParams) {
    if (key === name) {
      return value;
    }
  }
  return null;
}

function nonzeroClientInt(value: string | null): boolean {
  if (value === null || !/^-?\d+$/.test(value)) {
    return false;
  }
  const parsed = Number(value);
  return (
    Number.isInteger(parsed) &&
    parsed !== 0 &&
    parsed >= -2147483648 &&
    parsed <= 2147483647
  );
}

function androidOpensProfile(url: URL): boolean {
  for (const [key, value] of url.searchParams) {
    if (key !== "profile") {
      continue;
    }
    const flag = value.toLowerCase();
    return flag !== "false" && flag !== "0";
  }
  return false;
}

function desktopOverridesProfile(url: URL): boolean {
  const start = searchParam(url, "start");
  if (start !== null && start.length > 0) {
    return true;
  }
  if (
    searchParam(url, "startgroup") !== null ||
    searchParam(url, "startchannel") !== null ||
    searchParam(url, "direct") !== null
  ) {
    return true;
  }
  const boost = searchParam(url, "boost");
  if (boost !== null && boost.length > 0) {
    return true;
  }
  const game = searchParam(url, "game");
  if (game !== null && game.length > 0 && /^[A-Za-z0-9._]+$/.test(game)) {
    return true;
  }
  const domain = searchParam(url, "domain");
  const appname = searchParam(url, "appname");
  if (appname !== null && appname.length > 0 && domain?.toLowerCase() !== "s") {
    return true;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return false;
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const parts = url.pathname.split("/").filter((part) => part.length > 0);
  return isAppNamePath(host, parts);
}

/** 第二段是文风短码。没有这段时 `addstyle` 仍是用户名。 */
function aiStyleReplacesDraft(host: string, parts: readonly string[]): boolean {
  if (host === "addstyle.t.me") {
    return parts.length > 0;
  }
  if (!isExactDraftHost(host)) {
    return false;
  }
  return parts[0]?.toLowerCase() === "addstyle" && parts.length >= 2;
}

/** 第二段是账单短码。字符集之外时桌面端仍按应用名写草稿。没有这段时 `invoice` 仍是用户名。 */
function invoiceReplacesDraft(host: string, parts: readonly string[]): boolean {
  if (host === "invoice.t.me") {
    return parts.length === 1 && /^[A-Za-z0-9_-]+$/.test(parts[0] ?? "");
  }
  if (!isExactDraftHost(host)) {
    return false;
  }
  const slug = parts[1];
  return (
    parts[0]?.toLowerCase() === "invoice" &&
    parts.length === 2 &&
    slug !== undefined &&
    /^[A-Za-z0-9_-]+$/.test(slug)
  );
}

/** 第二段是表情包短名。连字符、末尾斜杠或命令大小写不同时仍写草稿。没有这段时 `addemoji` 仍是用户名。 */
function emojiSetReplacesDraft(
  host: string,
  pathname: string,
  parts: readonly string[],
): boolean {
  if (host === "addemoji.t.me") {
    return parts.length === 1 && /^[A-Za-z0-9._]+$/.test(parts[0] ?? "");
  }
  if (!isExactDraftHost(host) || pathname.endsWith("/")) {
    return false;
  }
  const slug = parts[1];
  return (
    parts[0] === "addemoji" &&
    parts.length === 2 &&
    slug !== undefined &&
    /^[A-Za-z0-9._]+$/.test(slug)
  );
}

/** 第二段是贴纸包短名。连字符、末尾斜杠或命令大小写不同时仍写草稿。没有这段时 `addstickers` 仍是用户名。 */
function stickerSetReplacesDraft(
  host: string,
  pathname: string,
  parts: readonly string[],
): boolean {
  if (host === "addstickers.t.me") {
    return parts.length === 1 && /^[A-Za-z0-9._]+$/.test(parts[0] ?? "");
  }
  if (!isExactDraftHost(host) || pathname.endsWith("/")) {
    return false;
  }
  const slug = parts[1];
  return (
    parts[0] === "addstickers" &&
    parts.length === 2 &&
    slug !== undefined &&
    /^[A-Za-z0-9._]+$/.test(slug)
  );
}

/** 第二段是主题短名。连字符、末尾斜杠或命令大小写不同时仍写草稿。没有这段时 `addtheme` 仍是用户名。 */
function themeSlugReplacesDraft(
  host: string,
  pathname: string,
  parts: readonly string[],
): boolean {
  if (host === "addtheme.t.me") {
    return parts.length === 1 && /^[A-Za-z0-9._]+$/.test(parts[0] ?? "");
  }
  if (!isExactDraftHost(host) || pathname.endsWith("/")) {
    return false;
  }
  const slug = parts[1];
  return (
    parts[0] === "addtheme" &&
    parts.length === 2 &&
    slug !== undefined &&
    /^[A-Za-z0-9._]+$/.test(slug)
  );
}

/** 第二段是语言包短名。末尾斜杠或命令大小写不同时仍写草稿。没有这段时 `setlanguage` 仍是用户名。 */
function languagePackReplacesDraft(
  host: string,
  pathname: string,
  parts: readonly string[],
): boolean {
  if (host === "setlanguage.t.me") {
    return parts.length === 1 && /^[A-Za-z0-9._-]+$/.test(parts[0] ?? "");
  }
  if (!isExactDraftHost(host) || pathname.endsWith("/")) {
    return false;
  }
  const slug = parts[1];
  return (
    parts[0] === "setlanguage" &&
    parts.length === 2 &&
    slug !== undefined &&
    /^[A-Za-z0-9._-]+$/.test(slug)
  );
}

/** 第二段是礼物短名。末尾斜杠或命令大小写不同时仍写草稿。没有这段时 `nft` 仍是用户名。 */
function giftSlugReplacesDraft(
  host: string,
  pathname: string,
  parts: readonly string[],
): boolean {
  if (host === "nft.t.me") {
    return parts.length === 1 && /^[A-Za-z0-9._-]+$/.test(parts[0] ?? "");
  }
  if (!isExactDraftHost(host) || pathname.endsWith("/")) {
    return false;
  }
  const slug = parts[1];
  return (
    parts[0] === "nft" &&
    parts.length === 2 &&
    slug !== undefined &&
    /^[A-Za-z0-9._-]+$/.test(slug)
  );
}

/** 第二段是拍卖短名。末尾斜杠或命令大小写不同时仍写草稿。没有这段时 `auction` 仍是用户名。 */
function auctionSlugReplacesDraft(
  host: string,
  pathname: string,
  parts: readonly string[],
): boolean {
  if (host === "auction.t.me") {
    return parts.length === 1 && /^[A-Za-z0-9._-]+$/.test(parts[0] ?? "");
  }
  if (!isExactDraftHost(host) || pathname.endsWith("/")) {
    return false;
  }
  const slug = parts[1];
  return (
    parts[0] === "auction" &&
    parts.length === 2 &&
    slug !== undefined &&
    /^[A-Za-z0-9._-]+$/.test(slug)
  );
}

/** 第二段是壁纸短名。末尾斜杠或命令大小写不同时仍写草稿。没有这段时 `bg` 仍是用户名。 */
function wallPaperReplacesDraft(
  host: string,
  pathname: string,
  parts: readonly string[],
): boolean {
  if (host === "bg.t.me") {
    return parts.length === 1 && /^[A-Za-z0-9._~-]+$/.test(parts[0] ?? "");
  }
  if (!isExactDraftHost(host) || pathname.endsWith("/")) {
    return false;
  }
  const slug = parts[1];
  return (
    parts[0] === "bg" &&
    parts.length === 2 &&
    slug !== undefined &&
    /^[A-Za-z0-9._~-]+$/.test(slug)
  );
}

/** 路径里带了联系人令牌。命令大小写不同时仍写草稿。没有这段时 `contact` 仍是用户名。 */
function contactTokenReplacesDraft(
  host: string,
  pathname: string,
  parts: readonly string[],
): boolean {
  if (host === "contact.t.me") {
    return parts.length > 0;
  }
  if (!isExactDraftHost(host) || parts[0] !== "contact") {
    return false;
  }
  return parts.length > 1 || pathname.endsWith("/");
}

/** 后面一段是机器人管理员用户名。连字符仍写草稿。没有这段时 `newbot` 仍是用户名。 */
function newBotReplacesDraft(host: string, parts: readonly string[]): boolean {
  const slug = (value: string | undefined) =>
    value !== undefined && /^[A-Za-z0-9._]+$/.test(value);
  if (host === "newbot.t.me") {
    return (
      parts.length >= 1 &&
      parts.length <= 2 &&
      parts.every((part) => slug(part))
    );
  }
  if (!isExactDraftHost(host) || parts[0]?.toLowerCase() !== "newbot") {
    return false;
  }
  if (parts.length < 2 || parts.length > 3) {
    return false;
  }
  return parts.slice(1).every((part) => slug(part));
}

/** 小写 `boost` 后面是频道用户名时打开助推。连字符和没有这段时仍写草稿。 */
function boostReplacesDraft(
  host: string,
  url: URL,
  parts: readonly string[],
): boolean {
  const channel = (value: string | undefined) =>
    value !== undefined && /^[A-Za-z0-9._]+$/.test(value);
  if (host === "boost.t.me") {
    return parts.length === 1 && /^\d+$/.test(parts[0] ?? "");
  }
  if (!isExactDraftHost(host) || parts[0] !== "boost") {
    return false;
  }
  if (searchParam(url, "c") !== null) {
    return true;
  }
  return parts.length === 2 && channel(parts[1]);
}

/** 小写 `folder` 后面是邀请码时打开文件夹。带点的短名和没有这段时仍写草稿。 */
function folderInviteDropsDraft(
  host: string,
  parts: readonly string[],
): boolean {
  const code = (value: string | undefined) =>
    value !== undefined && /^[A-Za-z0-9_-]{1,128}$/.test(value);
  if (host === "folder.t.me") {
    return parts.length === 1 && code(parts[0]);
  }
  if (!isExactDraftHost(host) || parts[0] !== "folder") {
    return false;
  }
  return parts.length === 2 && code(parts[1]);
}

/** 小写 `addlist` 后面没有末尾斜杠时打开聊天列表。末尾斜杠和大写命令仍写草稿。 */
function addListReplacesDraft(
  host: string,
  pathname: string,
  parts: readonly string[],
): boolean {
  const slug = (value: string | undefined) =>
    value !== undefined && /^[A-Za-z0-9._-]+$/.test(value);
  if (host === "addlist.t.me") {
    return parts.length === 1 && slug(parts[0]);
  }
  if (!isExactDraftHost(host) || parts[0] !== "addlist") {
    return false;
  }
  return parts.length === 2 && slug(parts[1]) && !pathname.endsWith("/");
}

/** 小写 `joinchat` 后面没有末尾斜杠时打开邀请。末尾斜杠和大写命令仍写草稿。 */
function joinChatReplacesDraft(
  host: string,
  pathname: string,
  parts: readonly string[],
): boolean {
  const slug = (value: string | undefined) =>
    value !== undefined && /^[A-Za-z0-9._-]+$/.test(value);
  if (host === "joinchat.t.me") {
    return parts.length === 1 && slug(parts[0]);
  }
  if (!isExactDraftHost(host) || parts[0] !== "joinchat") {
    return false;
  }
  return parts.length === 2 && slug(parts[1]) && !pathname.endsWith("/");
}

/** 小写 `m` 后面没有末尾斜杠时打开业务聊天。末尾斜杠和大写命令仍写草稿。 */
function businessChatReplacesDraft(
  host: string,
  pathname: string,
  parts: readonly string[],
): boolean {
  const slug = (value: string | undefined) =>
    value !== undefined && /^[A-Za-z0-9._-]+$/.test(value);
  if (host === "m.t.me") {
    return parts.length === 1 && slug(parts[0]);
  }
  if (!isExactDraftHost(host) || parts[0] !== "m") {
    return false;
  }
  return parts.length === 2 && slug(parts[1]) && !pathname.endsWith("/");
}

/** 小写 `c` 后面是频道数字时打开私密帖。其它短名和大写命令仍写草稿。 */
function privatePostDropsDraft(
  host: string,
  parts: readonly string[],
): boolean {
  const channel = (value: string | undefined) =>
    value !== undefined && /^-?\d+$/.test(value);
  if (host === "c.t.me") {
    return parts.length === 1 && channel(parts[0]);
  }
  if (!isExactDraftHost(host) || parts[0] !== "c") {
    return false;
  }
  return parts.length === 2 && channel(parts[1]);
}

/** 小写 `confirmphone` 没有下一段时确认电话。后面的短名和大写命令仍写草稿。 */
function confirmPhoneDropsDraft(
  host: string,
  parts: readonly string[],
): boolean {
  if (host === "confirmphone.t.me") {
    return parts.length === 0;
  }
  if (!isExactDraftHost(host) || parts[0] !== "confirmphone") {
    return false;
  }
  return parts.length === 1;
}

/** 小写 `call/` 打开群通话，不把 `text` 写进输入框。`call.t.me/后面` 先收成同一条。 */
function isGroupCallPath(host: string, pathname: string): boolean {
  return isExactDraftHost(host) && pathname.startsWith("/call/");
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
  return parts.length === 1 && only !== undefined && /^\d+$/.test(only);
}

/** 桌面端把用户名后的一段收成 appname。对方不是 bot 时仍写入草稿。 */
function isAppNamePath(host: string, parts: readonly string[]): boolean {
  if (!isExactDraftHost(host) || parts.length !== 2) {
    return false;
  }
  const name = parts[0];
  const app = parts[1];
  return (
    name !== undefined &&
    app !== undefined &&
    isPublicUsername(name) &&
    /^[A-Za-z0-9._-]+$/.test(app) &&
    !/^\d+$/.test(app)
  );
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
    /^\d+$/.test(post)
  );
}

function isTelegramPhoneSegment(host: string, segment: string): boolean {
  const bare = host.startsWith("www.") ? host.slice(4) : host;
  if (bare !== "t.me" && bare !== "telegram.me" && bare !== "telegram.dog") {
    return false;
  }
  return /^\+\d{1,128}$/.test(segment);
}

/** 小写 `s` 是预览路径。大写 `S` 仍按用户名写草稿。 */
function isPublicUsername(value: string): boolean {
  return (
    /^[A-Za-z0-9_]{1,32}$/.test(value) &&
    value !== "s" &&
    !reservedUsernames.has(value.toLowerCase())
  );
}

const reservedUsernames = new Set(["getpremium", "telegrampassport"]);

function isTelegramMsg(url: URL): boolean {
  if (url.protocol !== "tg:") {
    return false;
  }
  const host = url.hostname.toLowerCase();
  const path = url.pathname.replace(/^\/+|\/+$/g, "").toLowerCase();
  const command = host.length > 0 ? host : path;
  return command === "msg";
}

/** 查询名不区分大小写，取第一次出现的值。`+` 是空格。 */
function searchParam(url: URL, name: string): string | null {
  const wanted = name.toLowerCase();
  for (const [key, value] of url.searchParams) {
    if (key.toLowerCase() === wanted) {
      return value;
    }
  }
  return null;
}

/** Android 把分享草稿截到 4096 × 4。再往后的字不再打开。 */
const OPENED_DRAFT = 4096 * 4;

function openedDraft(value: string | null): string | null {
  if (value === null || value.length === 0) {
    return null;
  }
  return value.length > OPENED_DRAFT ? value.slice(0, OPENED_DRAFT) : value;
}

/** 查询里的 `+` 是空格。不完整的 `%` 留下。非法 UTF-8 换成替换字符。`%2B` 仍是加号。 */
function queryValue(raw: string, name: string): string | null {
  const match = new RegExp(`[?&]${name}=([^&#]*)`, "i").exec(raw);
  const value = match?.[1];
  if (value === undefined || value.length === 0) {
    return null;
  }
  return formDecode(value);
}

function formDecode(value: string): string {
  const source = value.replace(/\+/g, " ");
  const bytes: number[] = [];
  let out = "";
  const flush = (): void => {
    if (bytes.length === 0) {
      return;
    }
    out += new TextDecoder().decode(Uint8Array.from(bytes));
    bytes.length = 0;
  };
  for (let index = 0; index < source.length; index += 1) {
    const current = source.charAt(index);
    const hex = source.slice(index + 1, index + 3);
    if (current === "%" && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      index += 2;
      continue;
    }
    flush();
    out += current;
  }
  flush();
  return out;
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
    path === "/msg/url" ||
    (host === "share.t.me" && path === "/url") ||
    (host === "msg.t.me" && path === "/url")
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
      : command === "addlist" || command === "message"
        ? searchParam(url, "slug")
        : null;
  const pattern =
    command === "message"
      ? /^[A-Za-z0-9._-]{1,128}$/
      : /^[A-Za-z0-9_-]{1,128}$/;
  if (code === null || !pattern.test(code)) {
    return null;
  }
  return { host: "t.me", invite: true };
}

/** 桌面端把 `t.me/m/短码` 收成 `tg://message`。末尾斜杠不算。 */
function isBusinessChatLink(host: string, path: string): boolean {
  const bare = host.startsWith("www.") ? host.slice(4) : host;
  if (
    (bare === "t.me" || bare === "telegram.me" || bare === "telegram.dog") &&
    /^\/m\/[A-Za-z0-9._-]{1,128}$/i.test(path)
  ) {
    return true;
  }
  return host === "m.t.me" && /^\/[A-Za-z0-9._-]{1,128}$/i.test(path);
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
