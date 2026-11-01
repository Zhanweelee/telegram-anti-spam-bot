import {
  type Detector,
  type DetectorHit,
  defineDetector,
  foldCyrillicLookalikes,
  foldDotLookalikes,
  foldEncodedAlphabet,
  foldEncodedGaps,
  foldEncodedMiddleDot,
  foldEncodedSeparators,
  foldFullwidthLatin,
  foldHostInterrupters,
  foldMatchText,
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
      if (!message) {
        return null;
      }
      const inviteNames = new Set(
        (parsed.inviteHosts ?? defaultInviteHosts).map((item) =>
          item.toLowerCase(),
        ),
      );
      const compared = foldEncodedAlphabet(
        foldEncodedSeparators(
          foldEncodedGaps(
            foldMatchText(
              foldDotLookalikes(
                foldEncodedMiddleDot(
                  foldHostInterrupters(
                    foldFullwidthLatin(foldCyrillicLookalikes(message.text)),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
      const invites = mergeHosts(
        extractInviteHosts(compared, inviteNames),
        message.invites,
      );
      const hosts = mergeHosts(extractHosts(compared), message.hosts);
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
  token.lastIndex = 0;
  for (const match of text.matchAll(token)) {
    const raw = match[0];
    if (!raw) {
      continue;
    }
    const host = inviteHost(raw.replace(/[),.;!?]+$/g, ""), names);
    if (!host || seen.has(host)) {
      continue;
    }
    seen.add(host);
    found.push(host);
    if (found.length >= 8) {
      break;
    }
  }
  return found;
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
  token.lastIndex = 0;
  for (const match of text.matchAll(token)) {
    const raw = match[0];
    if (!raw) {
      continue;
    }
    const host = hostname(raw.replace(/[),.;!?]+$/g, ""));
    if (!host || seen.has(host)) {
      continue;
    }
    seen.add(host);
    found.push(host);
    if (found.length >= 8) {
      break;
    }
  }
  return found;
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
