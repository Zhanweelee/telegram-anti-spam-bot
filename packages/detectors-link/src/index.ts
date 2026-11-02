import {
  type Detector,
  type DetectorHit,
  defineDetector,
  foldHostScan,
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

const token =
  /(?:https?:\/\/|www\.)[^\s<>"']+|\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s<>"']*)?/gi;

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
      const invites = mergeHosts(
        extractInviteHosts(compared, inviteNames),
        message?.invites,
      );
      const hosts = mergeHosts(extractHosts(compared), message?.hosts);
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
      ? url.searchParams.get("invite")
      : command === "addlist"
        ? url.searchParams.get("slug")
        : null;
  if (code === null || !/^[A-Za-z0-9_-]{1,128}$/.test(code)) {
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
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (
    /^\/\+[A-Za-z0-9_-]{1,128}$/.test(path) ||
    /^\/joinchat\/[A-Za-z0-9_-]{1,128}$/.test(path) ||
    /^\/addlist\/[A-Za-z0-9_-]{1,128}$/.test(path)
  ) {
    return host;
  }
  return null;
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
    push(hostname(raw));
    push(proxyServerHost(raw));
    pushWrappedHosts(raw, push);
    pushMsgTextHosts(raw, push);
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
    push(hostname(wrapped.url));
    push(proxyServerHost(wrapped.url));
  }
  if (!wrapped.text) {
    return;
  }
  for (const inner of linkTokens(wrapped.text)) {
    push(hostname(inner));
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
    push(hostname(embedded));
    push(proxyServerHost(embedded));
  }
  const text = telegramMsgText(raw);
  if (!text) {
    return;
  }
  for (const inner of linkTokens(text)) {
    push(hostname(inner));
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
    path === "/msg/url"
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
  const server = url.searchParams.get("server");
  if (server === null || server.length === 0) {
    return null;
  }
  return hostname(server);
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
