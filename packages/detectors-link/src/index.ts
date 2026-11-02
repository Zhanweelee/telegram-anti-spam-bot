import {
  androidUrlSpan,
  type Detector,
  type DetectorHit,
  defineDetector,
  foldHostScan,
  foldHostScanKeepingStops,
  withTimeout,
} from "@tasb/core";
import { z } from "zod";

const hostSchema = z.string().min(1).max(253);

export const linkConfigSchema = z.strictObject({
  shorteners: z.array(hostSchema).max(32).optional(),
  denylist: z.array(hostSchema).max(64).optional(),
  inviteHosts: z.array(hostSchema).max(32).optional(),
  sourceTimeoutMs: z.number().int().positive().max(40).optional(),
});

export type LinkConfig = z.input<typeof linkConfigSchema>;

export type ReputationVerdict = "bad" | "unknown";

/** Optional lookup. The default worker does not pass one, so no network runs. */
export interface ReputationSource {
  lookup(host: string): Promise<ReputationVerdict>;
}

export interface LinkDetectorDeps {
  readonly shorteners?: readonly string[];
  readonly denylist?: readonly string[];
  readonly inviteHosts?: readonly string[];
  readonly source?: ReputationSource;
  readonly sourceTimeoutMs?: number;
}

export const defaultInviteHosts = [
  "t.me",
  "telegram.me",
  "telegram.dog",
] as const;

export const defaultShorteners = [
  "bit.ly",
  "tinyurl.com",
  "t.co",
  "goo.gl",
  "is.gd",
  "cutt.ly",
  "ow.ly",
  "buff.ly",
  "rb.gy",
  "shorturl.at",
] as const;

/**
 * A URL token ends at whitespace, quotes, characters Android's path
 * cannot include, a `%` that is not two hex digits, and a code point the
 * path class omits. Punctuation that can sit in a path ends the host when
 * the path has not started, so the next URL is its own match. A scheme
 * stuck to an ASCII word character is not a match, and the host after
 * `://` is not read again. A bare domain and a `www.` host end at the last
 * label, so the next URL is its own match. A label cannot start with a
 * hyphen, and `http://` is not itself a label. A dot in a schemed host
 * starts another label only when a label character follows. A dot before
 * a port, a slash, or a question mark stays with this URL. `@` is user
 * info only when the next character can finish it.
 */
const URL_BREAK = "\\s<>\"'[\\\\\\]^`{|}\\u0000-\\u001F\\u007F";
const URL_OMIT =
  "\\u0080-\\u009F\\uD800-\\uDFFF\\uE000-\\uF8FF\\uFDD0-\\uFDEF\\uFFF0-\\uFFFF";
const URL_PAIR =
  "(?:[\\uD840-\\uD87F]|[\\uD880-\\uD8BF]|[\\uD8C0-\\uD8FF]|[\\uD900-\\uD93F]|[\\uD940-\\uD97F]|[\\uD980-\\uD9BF]|[\\uD9C0-\\uD9FF]|[\\uDA00-\\uDA3F]|[\\uDA40-\\uDA7F]|[\\uDA80-\\uDABF]|[\\uDAC0-\\uDAFF]|[\\uDB00-\\uDB3F]|[\\uDB44-\\uDB7F])[\\uDC00-\\uDFFD]";
const URL_BODY = `(?:[^${URL_BREAK}%${URL_OMIT}]|${URL_PAIR}|%[0-9A-Fa-f]{2})`;
const URL_LABEL_ATOM = `(?:%[0-9A-Fa-f]{2}|[A-Za-z0-9]|[^\\s\\u0000-\\u007F${URL_OMIT}]|${URL_PAIR})`;
const URL_LABEL_MORE = `(?:%[0-9A-Fa-f]{2}|[A-Za-z0-9_-]|[^\\s\\u0000-\\u007F${URL_OMIT}]|${URL_PAIR})`;
const URL_LABEL = `(?:${URL_LABEL_ATOM}${URL_LABEL_MORE}*)`;
const URL_HOST = `(?:${URL_LABEL}(?:\\.${URL_LABEL})*)`;
const URL_USER = "(?:%[0-9A-Fa-f]{2}|[A-Za-z0-9$._+!*'(),;?&=-])";
const URL_USERINFO = `(?:${URL_USER})+(?::(?:${URL_USER})+)?@(?=$|[/?_]|[A-Za-z0-9]|:\\d{1,5}(?!\\d)(?![A-Za-z0-9_]))`;
const URL_TAIL = `(?:\\.(?=[:/?]))?(?::\\d{1,5}(?!\\d))?(?:[/?](?:${URL_BODY})*)?`;
const URL_ASCII_LABEL = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?";
const URL_UNI_LABEL = `(?:[^\\s\\u0000-\\u007F${URL_OMIT}]|${URL_PAIR})+`;
const URL_NAME = `(?:${URL_ASCII_LABEL}|${URL_UNI_LABEL})`;
const URL_TLD = "(?!https?:\\/\\/)[a-z]{2,}";
const URL_WWW = `www\\.(?:${URL_NAME}\\.)+${URL_TLD}${URL_TAIL}`;
const URL_BARE = `(?:${URL_ASCII_LABEL}\\.)+${URL_TLD}`;
const token = new RegExp(
  `(?<![A-Za-z0-9_])(?:https?:\\/\\/(?:${URL_USERINFO}(?:${URL_HOST})?${URL_TAIL}|(?:${URL_HOST})${URL_TAIL})|${URL_WWW})|(?<!:\\/\\/)\\b${URL_BARE}(?:\\/(?:${URL_BODY})+)?`,
  "gi",
);

const deepLink = /(?<![A-Za-z0-9./])tg:(?:\/\/)?[^\s<>"']+/gi;

export function createLinkDetector(deps: LinkDetectorDeps = {}): Detector {
  return defineDetector({
    id: "link",
    version: "0.1.0",
    capabilities: ["link"],
    configSchema: linkConfigSchema,
    config: {
      ...(deps.shorteners === undefined
        ? {}
        : { shorteners: [...deps.shorteners] }),
      ...(deps.denylist === undefined ? {} : { denylist: [...deps.denylist] }),
      ...(deps.inviteHosts === undefined
        ? {}
        : { inviteHosts: [...deps.inviteHosts] }),
      ...(deps.sourceTimeoutMs === undefined
        ? {}
        : { sourceTimeoutMs: deps.sourceTimeoutMs }),
    },
    async detect(ctx, parsed) {
      const message = ctx.event.message;
      const text = message?.text ?? ctx.event.profile?.text;
      if (text === undefined) {
        return null;
      }
      const inviteNames = new Set(
        (parsed.inviteHosts ?? defaultInviteHosts).map((item) =>
          item.toLowerCase(),
        ),
      );
      const compared = foldHostScan(text);
      const shaped = foldHostScanKeepingStops(text);
      const invites = mergeHosts(
        extractInviteHosts(compared, inviteNames),
        message?.invites,
      );
      const gapHosts = shaped === compared ? [] : extractHosts(shaped);
      const hosts = mergeHosts(extractHosts(compared), [
        ...gapHosts,
        ...(message?.hosts ?? []),
      ]);
      if (hosts.length === 0 && invites.length === 0) {
        return null;
      }
      const shorteners = new Set(
        (parsed.shorteners ?? defaultShorteners).map((item) =>
          item.toLowerCase(),
        ),
      );
      const denied = new Set(
        (parsed.denylist ?? []).map((item) => item.toLowerCase()),
      );
      const reasons: string[] = [];
      const evidence: DetectorHit["evidence"][number][] = [];
      for (const host of invites) {
        if (!matchesHost(host, inviteNames) || reasons.includes("invite")) {
          continue;
        }
        reasons.push("invite");
        evidence.push({
          kind: "feature",
          summary: summaryFor("invite", host),
        });
      }
      for (const host of hosts) {
        const local = localReason(host, shorteners, denied);
        if (!local || reasons.includes(local)) {
          continue;
        }
        reasons.push(local);
        evidence.push({
          kind: "feature",
          summary: summaryFor(local, host),
        });
        if (reasons.length >= 4) {
          break;
        }
      }
      if (reasons.length > 0) {
        return hit(reasons, evidence);
      }
      if (!deps.source) {
        return null;
      }
      const timeoutMs = parsed.sourceTimeoutMs ?? 20;
      for (const host of hosts.slice(0, 3)) {
        try {
          const verdict = await withTimeout(
            deps.source.lookup(host),
            timeoutMs,
          );
          if (verdict === "bad") {
            return hit(
              ["reputation"],
              [{ kind: "feature", summary: summaryFor("reputation", host) }],
            );
          }
        } catch {
          ctx.logger.warn("reputation_failed", {
            eventId: ctx.event.id,
            tenantId: ctx.event.tenantId,
            chatId: ctx.event.chatId,
            detectorId: "link",
          });
          return null;
        }
      }
      return null;
    },
  });
}

function hit(
  reasons: readonly string[],
  evidence: DetectorHit["evidence"],
): DetectorHit {
  return {
    detectorId: "link",
    score: 1,
    reasons: [...reasons],
    evidence: [...evidence],
  };
}

function localReason(
  host: string,
  shorteners: ReadonlySet<string>,
  denied: ReadonlySet<string>,
): "ip_host" | "short_link" | "denylist" | null {
  if (isIp(host)) {
    return "ip_host";
  }
  if (matchesHost(host, shorteners)) {
    return "short_link";
  }
  if (matchesHost(host, denied)) {
    return "denylist";
  }
  return null;
}

function summaryFor(reason: string, host: string): string {
  return `${reason}:${host}`.slice(0, 80);
}

function matchesHost(host: string, names: ReadonlySet<string>): boolean {
  for (const name of names) {
    if (host === name || host.endsWith(`.${name}`)) {
      return true;
    }
  }
  return false;
}

function isIp(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) {
    return false;
  }
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) {
      return false;
    }
    const value = Number(part);
    return value >= 0 && value <= 255;
  });
}

function mergeHosts(
  fromText: readonly string[],
  extra: readonly string[] | undefined,
): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const host of extra === undefined ? fromText : [...fromText, ...extra]) {
    const normalized = host.toLowerCase();
    if (normalized.length === 0 || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    found.push(normalized);
    if (found.length >= 8) {
      break;
    }
  }
  return found;
}

function extractInviteHosts(
  text: string,
  names: ReadonlySet<string>,
): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const pushInvite = (host: string | null): void => {
    if (!host || seen.has(host) || found.length >= 8) {
      return;
    }
    seen.add(host);
    found.push(host);
  };
  token.lastIndex = 0;
  for (const match of text.matchAll(token)) {
    const raw = match[0];
    if (!raw) {
      continue;
    }
    const stripped = raw.replace(/[),.;!?]+$/g, "");
    pushInvite(inviteHost(stripped, names));
    pushWrappedInvites(stripped, names, pushInvite);
    pushMsgTextInvites(stripped, names, pushInvite);
    pushUsernameDraftInvites(stripped, names, pushInvite);
    pushPassportInvites(stripped, names, pushInvite);
    if (found.length >= 8) {
      return found;
    }
  }
  deepLink.lastIndex = 0;
  for (const match of text.matchAll(deepLink)) {
    const raw = match[0];
    if (!raw) {
      continue;
    }
    const stripped = raw.replace(/[),.;!?]+$/g, "");
    pushInvite(deepInviteHost(stripped, names));
    pushWrappedInvites(stripped, names, pushInvite);
    pushMsgTextInvites(stripped, names, pushInvite);
    pushUsernameDraftInvites(stripped, names, pushInvite);
    pushPassportInvites(stripped, names, pushInvite);
    if (found.length >= 8) {
      return found;
    }
  }
  return found;
}

function deepInviteHost(
  raw: string,
  names: ReadonlySet<string>,
): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const canonical = canonicalDeepInvite(url);
  if (canonical === null || !matchesHost(canonical, names)) {
    return null;
  }
  return canonical;
}

function canonicalDeepInvite(url: URL): string | null {
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
  return "t.me";
}

function inviteHost(raw: string, names: ReadonlySet<string>): string | null {
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!matchesHost(host, names)) {
    return null;
  }
  const rawPath = url.pathname || "/";
  const path = rawPath.replace(/\/+$/, "") || "/";
  if (isTelegramPhonePath(host, path)) {
    return null;
  }
  if (
    /^\/\+[A-Za-z0-9_-]{1,128}$/.test(path) ||
    /^\/joinchat\/[A-Za-z0-9_-]{1,128}$/i.test(path) ||
    /^\/addlist\/[A-Za-z0-9_-]{1,128}$/i.test(path) ||
    /^\/folder\/[A-Za-z0-9_-]{1,128}$/.test(path) ||
    isAndroidPrefixInvite(host, path) ||
    isBusinessChatLink(host, rawPath) ||
    isPercentSpaceInvite(withScheme, host)
  ) {
    return host;
  }
  return null;
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

function isTelegramPhonePath(host: string, path: string): boolean {
  const bare = host.startsWith("www.") ? host.slice(4) : host;
  if (bare !== "t.me" && bare !== "telegram.me" && bare !== "telegram.dog") {
    return false;
  }
  const segment = path.startsWith("/") ? path.slice(1) : path;
  return /^\+\d{1,128}$/.test(segment);
}

export function extractHosts(text: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const push = (host: string | null): void => {
    if (!host || seen.has(host) || found.length >= 8) {
      return;
    }
    seen.add(host);
    found.push(host);
  };
  token.lastIndex = 0;
  for (const match of text.matchAll(token)) {
    const raw = match[0]?.replace(/[),.;!?]+$/g, "");
    if (!raw) {
      continue;
    }
    pushLinkHost(raw, push);
    push(proxyServerHost(raw));
    pushWrappedHosts(raw, push);
    pushMsgTextHosts(raw, push);
    pushUsernameDraftHosts(raw, push);
    pushPassportHosts(raw, push);
    if (found.length >= 8) {
      return found;
    }
  }
  deepLink.lastIndex = 0;
  for (const match of text.matchAll(deepLink)) {
    const raw = match[0]?.replace(/[),.;!?]+$/g, "");
    if (!raw) {
      continue;
    }
    push(proxyServerHost(raw));
    pushWrappedHosts(raw, push);
    pushMsgTextHosts(raw, push);
    pushUsernameDraftHosts(raw, push);
    pushPassportHosts(raw, push);
    if (found.length >= 8) {
      return found;
    }
  }
  return found;
}

function pushWrappedHosts(
  raw: string,
  push: (host: string | null) => void,
): void {
  const wrapped = telegramWrapped(raw);
  if (!wrapped) {
    return;
  }
  if (wrapped.url) {
    pushLinkHost(wrapped.url, push);
    push(proxyServerHost(wrapped.url));
  }
  if (!wrapped.text) {
    return;
  }
  for (const inner of linkTokens(wrapped.text)) {
    pushLinkHost(inner, push);
    push(proxyServerHost(inner));
  }
}

function pushWrappedInvites(
  raw: string,
  names: ReadonlySet<string>,
  push: (host: string | null) => void,
): void {
  const wrapped = telegramWrapped(raw);
  if (!wrapped) {
    return;
  }
  if (wrapped.url) {
    push(inviteHost(wrapped.url, names));
    push(deepInviteHost(wrapped.url, names));
  }
  if (!wrapped.text) {
    return;
  }
  for (const inner of linkTokens(wrapped.text)) {
    push(inviteHost(inner, names));
  }
  for (const inner of deepTokens(wrapped.text)) {
    push(deepInviteHost(inner, names));
  }
}

function telegramWrapped(
  raw: string,
): { url: string | null; text: string | null } | null {
  let url: URL;
  try {
    url = new URL(/^(?:https?:|tg:)/i.test(raw) ? raw : `http://${raw}`);
  } catch {
    return null;
  }
  if (!isTelegramShare(url)) {
    return null;
  }
  const embedded = queryValue(raw, "url");
  const text = queryValue(raw, "text");
  return {
    url:
      embedded !== null && embedded.length > 0 && embedded.length <= 2048
        ? embedded
        : null,
    text: text !== null && text.length > 0 && text.length <= 4096 ? text : null,
  };
}

function pushMsgTextHosts(
  raw: string,
  push: (host: string | null) => void,
): void {
  const embedded = telegramMsgUrl(raw);
  if (embedded) {
    pushLinkHost(embedded, push);
    push(proxyServerHost(embedded));
  }
  const text = telegramMsgText(raw);
  if (!text) {
    return;
  }
  for (const inner of linkTokens(text)) {
    pushLinkHost(inner, push);
    push(proxyServerHost(inner));
  }
}

function pushMsgTextInvites(
  raw: string,
  names: ReadonlySet<string>,
  push: (host: string | null) => void,
): void {
  const embedded = telegramMsgUrl(raw);
  if (embedded) {
    push(inviteHost(embedded, names));
    push(deepInviteHost(embedded, names));
  }
  const text = telegramMsgText(raw);
  if (!text) {
    return;
  }
  for (const inner of linkTokens(text)) {
    push(inviteHost(inner, names));
  }
  for (const inner of deepTokens(text)) {
    push(deepInviteHost(inner, names));
  }
}

function telegramMsgUrl(raw: string): string | null {
  if (!isTelegramMsgRaw(raw)) {
    return null;
  }
  const embedded = queryValue(raw, "url");
  if (embedded === null || embedded.length === 0 || embedded.length > 2048) {
    return null;
  }
  return embedded;
}

function pushUsernameDraftHosts(
  raw: string,
  push: (host: string | null) => void,
): void {
  const text = usernameDraftText(raw);
  if (!text) {
    return;
  }
  for (const inner of linkTokens(text)) {
    pushLinkHost(inner, push);
    push(proxyServerHost(inner));
  }
}

function pushUsernameDraftInvites(
  raw: string,
  names: ReadonlySet<string>,
  push: (host: string | null) => void,
): void {
  const text = usernameDraftText(raw);
  if (!text) {
    return;
  }
  for (const inner of linkTokens(text)) {
    push(inviteHost(inner, names));
  }
  for (const inner of deepTokens(text)) {
    push(deepInviteHost(inner, names));
  }
}

function pushPassportHosts(
  raw: string,
  push: (host: string | null) => void,
): void {
  const callback = passportCallback(raw);
  if (!callback) {
    return;
  }
  for (const inner of linkTokens(callback)) {
    pushLinkHost(inner, push);
    push(proxyServerHost(inner));
  }
}

function pushPassportInvites(
  raw: string,
  names: ReadonlySet<string>,
  push: (host: string | null) => void,
): void {
  const callback = passportCallback(raw);
  if (!callback) {
    return;
  }
  for (const inner of linkTokens(callback)) {
    push(inviteHost(inner, names));
  }
  for (const inner of deepTokens(callback)) {
    push(deepInviteHost(inner, names));
  }
}

/** 桌面端取消 Passport 时打开 `callback_url`。只留主机名。 */
function passportCallback(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(/^(?:https?:|tg:)/i.test(raw) ? raw : `http://${raw}`);
  } catch {
    return null;
  }
  if (!isTelegramPassport(raw, url)) {
    return null;
  }
  const callback = queryValue(raw, "callback_url");
  if (callback === null || callback.length === 0 || callback.length > 2048) {
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

function usernameDraftText(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(/^(?:https?:|tg:)/i.test(raw) ? raw : `http://${raw}`);
  } catch {
    return null;
  }
  if (!isUsernameDraft(url)) {
    return null;
  }
  const text = queryValue(raw, "text");
  if (text === null || text.length === 0 || text.length > 4096) {
    return null;
  }
  return text;
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
      (name) => host === name || host.endsWith(`.${name}`),
    )
  ) {
    return false;
  }
  const parts = url.pathname.split("/").filter((part) => part.length > 0);
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

function telegramMsgText(raw: string): string | null {
  if (!isTelegramMsgRaw(raw)) {
    return null;
  }
  const text = queryValue(raw, "text");
  if (text === null || text.length === 0 || text.length > 4096) {
    return null;
  }
  return text;
}

function isTelegramMsgRaw(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(/^(?:https?:|tg:)/i.test(raw) ? raw : `http://${raw}`);
  } catch {
    return false;
  }
  return isTelegramMsg(url);
}

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
      (name) => host === name || host.endsWith(`.${name}`),
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

function linkTokens(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(new RegExp(token.source, "gi"))) {
    const raw = match[0]?.replace(/[),.;!?]+$/g, "");
    if (raw) {
      found.push(raw);
    }
  }
  return found;
}

function deepTokens(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(new RegExp(deepLink.source, "gi"))) {
    const raw = match[0]?.replace(/[),.;!?]+$/g, "");
    if (raw) {
      found.push(raw);
    }
  }
  return found;
}

const telegramProxyHosts = ["t.me", "telegram.me", "telegram.dog"];

function proxyServerHost(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(/^(?:https?:|tg:)/i.test(raw) ? raw : `http://${raw}`);
  } catch {
    return null;
  }
  if (!isTelegramProxy(url)) {
    return null;
  }
  const server = proxyAddress(url);
  if (server === null || server.length === 0) {
    return null;
  }
  return hostname(server);
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

function pushLinkHost(raw: string, push: (host: string | null) => void): void {
  push(hostname(raw));
  const schemed = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  const span = androidUrlSpan(schemed);
  if (span !== null) {
    push(hostname(span));
  }
}

function hostname(raw: string): string | null {
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host.length === 0 || host.length > 253) {
    return null;
  }
  return host;
}
