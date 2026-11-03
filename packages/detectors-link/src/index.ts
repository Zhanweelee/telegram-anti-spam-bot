import {
  androidStrictTld,
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
 * A URL token ends at whitespace Android stops on, a double quote,
 * characters Android's path cannot include, a `%` that is not two hex
 * digits, and a code point the path class omits. U+1680, U+205F, and
 * U+FEFF stay inside a label or a path. An apostrophe inside a path stays
 * with this URL.
 * Punctuation that can sit in a path ends the host when
 * the path has not started, so the next URL is its own match. A scheme
 * stuck to an ASCII word character is not a match. A non-spacing mark
 * after that word does not open a boundary, so a bare host stuck to
 * `http://` through the mark is not its own short link. A slash after
 * the mark still starts the next URL. The host after
 * `://` is not read again. A bare domain and a `www.` host end at the last
 * label Android accepts as a top-level domain, so the next URL is its own
 * match. A hyphen or an underscore can join letters inside one bare label.
 * The label still cannot start or end with either mark. Letters written
 * against each other still start at the ASCII word, and `http://`
 * is not itself a label. A dot in a schemed host
 * starts another label only when a label character follows. A percent
 * encoding inside that host ends it, so the hex digits are their own match.
 * A percent encoding in the path stays with this URL. A dot lookalike
 * that follows an ASCII dot stays in that label, so the next URL is not its
 * own match. A dot lookalike written immediately before `@` also stays, so
 * the next URL is its own match. A dot before
 * a port, a slash, or a question mark stays with this URL. A `?` or `/`
 * right after `://` is an empty authority, so that query stays here.
 * A one-to-five digit port with no host stays on that URL when `/` or `?`
 * follows. Six digits are not a port. `http:///…` still opens the host the
 * parser reads. A label character Android keeps stays on a schemed host
 * when a path, a dot and another label, or a finished port follows.
 * `@`, `#`, and a space still open the host that ends on the previous word.
 * `@` is user
 * info when the next character can start the host label Android keeps,
 * so that label swallows a following `http` before `://`. A dot, `!`, or
 * `~` still ends the first host. User info is at most
 * 64 characters, and the password is at most 25. A label is at most 63
 * characters and cannot end in the middle of an ASCII word. A hyphen stays
 * inside the label only when the finished label still fits. A dotted IPv4
 * with no scheme is its own match when Android opens it. That bare host
 * keeps a port of one to five digits and a path or query. A dot before
 * the path does not stay on a bare host or a `www.` host, so the next URL
 * is its own match. A schemed host keeps that dot. An address
 * inside a `tg://` link stays with that link. `tg:` without slashes does
 * not hide the URL Android opens after it.
 */
const URL_STOP =
  "\\t\\n\\v\\f\\r \\u00A0\\u2000-\\u200A\\u2028\\u2029\\u202F\\u3000";
const URL_BREAK = `${URL_STOP}<>"[\\\\\\]^\`{|}\\u0000-\\u001F\\u007F`;
const URL_OMIT =
  "\\u0080-\\u009F\\uD800-\\uDFFF\\uE000-\\uF8FF\\uFDD0-\\uFDEF\\uFFF0-\\uFFFF";
const URL_PAIR =
  "(?:[\\uD840-\\uD87F]|[\\uD880-\\uD8BF]|[\\uD8C0-\\uD8FF]|[\\uD900-\\uD93F]|[\\uD940-\\uD97F]|[\\uD980-\\uD9BF]|[\\uD9C0-\\uD9FF]|[\\uDA00-\\uDA3F]|[\\uDA40-\\uDA7F]|[\\uDA80-\\uDABF]|[\\uDAC0-\\uDAFF]|[\\uDB00-\\uDB3F]|[\\uDB44-\\uDB7F])[\\uDC00-\\uDFFD]";
const URL_BODY = `(?:[^${URL_BREAK}%${URL_OMIT}]|${URL_PAIR}|%[0-9A-Fa-f]{2})`;
const URL_LABEL_CHAR = `(?:\\uFEFF|[^${URL_STOP}\\u0000-\\u007F${URL_OMIT}]|${URL_PAIR})`;
const URL_LABEL_ATOM = `(?:[A-Za-z0-9]|${URL_LABEL_CHAR})`;
const URL_LABEL_MORE = `(?:[A-Za-z0-9_-]|${URL_LABEL_CHAR})`;
const URL_LABEL = `(?:${URL_LABEL_ATOM}(?:${URL_LABEL_MORE}{0,61}${URL_LABEL_ATOM})?)`;
const URL_HOST = `(?:${URL_LABEL}(?:\\.${URL_LABEL})*)`;
const URL_USER = "(?:%[0-9A-Fa-f]{2}|[A-Za-z0-9$._+!*'(),;?&=-])";
const URL_USERINFO = `(?:${URL_USER}){1,64}(?::(?:${URL_USER}){1,25})?@(?=$|[/?_]|[A-Za-z0-9]|${URL_LABEL_CHAR}|:\\d{1,5}(?!\\d)(?![A-Za-z0-9_]))`;
const URL_TAIL = `(?:\\.(?=[:/?]))?(?::\\d{1,5}(?!\\d))?(?:[/?](?:${URL_BODY})*)?`;
const URL_BARE_TAIL = `(?::\\d{1,5}(?!\\d))?(?:[/?](?:${URL_BODY})*)?`;
const URL_ASCII_LABEL = "[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?";
const URL_UNI_LABEL = `(?:[^${URL_STOP}\\u0000-\\u007F${URL_OMIT}]|${URL_PAIR}){1,63}`;
const URL_ATOM = `(?:[A-Za-z0-9]|[^${URL_STOP}\\u0000-\\u007F${URL_OMIT}]|${URL_PAIR})`;
const URL_BRIDGED = `(?=[^.]{0,62}[_-])${URL_ATOM}(?:${URL_ATOM}|[_-]){0,61}${URL_ATOM}`;
const URL_NAME = `(?:${URL_BRIDGED}|${URL_ASCII_LABEL}|${URL_UNI_LABEL})`;
const URL_TLD = androidStrictTld;
const URL_WWW = `www\\.(?:${URL_NAME}\\.)+${URL_TLD}${URL_BARE_TAIL}`;
const URL_BARE = `(?:${URL_NAME}\\.)+${URL_TLD}`;
const URL_IP_HEAD = "(?:25[0-5]|2[0-4][0-9]|[0-1][0-9]{2}|[1-9][0-9]|[1-9])";
const URL_IP_MID = "(?:25[0-5]|2[0-4][0-9]|[0-1][0-9]{2}|[1-9][0-9]|[1-9]|0)";
const URL_IP_LAST = "(?:25[0-5]|2[0-4][0-9]|[0-1][0-9]{2}|[1-9][0-9]|[0-9])";
const URL_IP = `${URL_IP_HEAD}\\.${URL_IP_MID}\\.${URL_IP_MID}\\.${URL_IP_LAST}`;
const URL_MARK =
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
const URL_END = `(?![A-Za-z0-9_])(?!${URL_MARK})`;
const URL_BEFORE = `(?<![A-Za-z0-9_](?:${URL_MARK})*)`;
const URL_EDGE = `(?:${URL_BEFORE}(?=[A-Za-z0-9_])|(?<=[A-Za-z0-9_](?:${URL_MARK})*)(?![A-Za-z0-9_]))`;
const token = new RegExp(
  `${URL_BEFORE}(?:https?:\\/\\/(?:${URL_USERINFO}(?:${URL_HOST})?${URL_TAIL}|(?:${URL_HOST})${URL_TAIL}|(?:[/?]|:\\d{1,5}[/?])(?:${URL_BODY})*)|${URL_WWW})${URL_END}|(?<!:\\/\\/)(?:^|${URL_EDGE})(?:${URL_BARE}|${URL_IP})${URL_BARE_TAIL}${URL_END}`,
  "gi",
);

const deepLink = /(?<![A-Za-z0-9./])tg:(?:\/\/)?[^\s<>"']+/gi;

function withBoundaryMarks(text: string): string {
  return text.replaceAll("\u0345", "\u0300");
}

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
      const gapInvites =
        shaped === compared ? [] : extractInviteHosts(shaped, inviteNames);
      const invites = mergeHosts(extractInviteHosts(compared, inviteNames), [
        ...gapInvites,
        ...(message?.invites ?? []),
      ]);
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
  const marked = withBoundaryMarks(text);
  token.lastIndex = 0;
  for (const match of marked.matchAll(token)) {
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

function deepCovers(text: string): (start: number, end: number) => boolean {
  const spans: Array<[number, number]> = [];
  for (const match of text.matchAll(new RegExp(deepLink.source, "gi"))) {
    const raw = match[0] ?? "";
    if (!/^tg:\/\//i.test(raw)) {
      continue;
    }
    const from = match.index ?? 0;
    spans.push([from, from + raw.length]);
  }
  return (start, end) => spans.some(([from, to]) => start >= from && end <= to);
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
  const covered = deepCovers(text);
  const marked = withBoundaryMarks(text);
  token.lastIndex = 0;
  for (const match of marked.matchAll(token)) {
    const start = match.index ?? 0;
    const full = match[0] ?? "";
    const raw = full.replace(/[),.;!?]+$/g, "");
    if (!raw || covered(start, start + full.length)) {
      continue;
    }
    const end = start + raw.length;
    const follow = end < marked.length ? marked.charAt(end) : "";
    pushLinkHost(cutClosedHostSlash(marked, raw, end), push, follow);
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
      (name) => host === name || host.endsWith(`.${name}`),
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

function isPublicUsername(value: string): boolean {
  return (
    /^[A-Za-z0-9_]{1,32}$/.test(value) &&
    !reservedUsernames.has(value.toLowerCase())
  );
}

const reservedUsernames = new Set([
  "addlist",
  "c",
  "confirmphone",
  "folder",
  "getpremium",
  "iv",
  "joinchat",
  "m",
  "proxy",
  "s",
  "socks",
  "telegrampassport",
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
  const marked = withBoundaryMarks(text);
  for (const match of marked.matchAll(new RegExp(token.source, "gi"))) {
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

/**
 * A division slash at the end of this match stays when `/`, `?`, or the end
 * follows. Android keeps that slash in the host. Any other follower makes
 * the label end before the slash.
 */
function cutClosedHostSlash(text: string, raw: string, end: number): string {
  let out = raw;
  let cursor = end;
  while (out.endsWith("\u2215") || out.endsWith("\u2044")) {
    if (cursor >= text.length) {
      break;
    }
    const follow = text.charAt(cursor);
    if (follow === "/" || follow === "?") {
      break;
    }
    out = out.slice(0, -1);
    cursor -= 1;
  }
  return out;
}

function pushLinkHost(
  raw: string,
  push: (host: string | null) => void,
  follow = "",
): void {
  push(hostname(raw));
  const schemed = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  const span = androidUrlSpan(follow === "" ? schemed : `${schemed}${follow}`);
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
