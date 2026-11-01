import {
  type Detector,
  type DetectorHit,
  defineDetector,
  withTimeout,
} from "@tasb/core";
import { z } from "zod";

const hostSchema = z.string().min(1).max(253);

export const linkConfigSchema = z.strictObject({
  shorteners: z.array(hostSchema).max(32).optional(),
  denylist: z.array(hostSchema).max(64).optional(),
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
  readonly source?: ReputationSource;
  readonly sourceTimeoutMs?: number;
}

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
      ...(deps.sourceTimeoutMs === undefined
        ? {}
        : { sourceTimeoutMs: deps.sourceTimeoutMs }),
    },
    async detect(ctx, parsed) {
      const text = ctx.event.message?.text;
      if (!text) {
        return null;
      }
      const hosts = extractHosts(text);
      if (hosts.length === 0) {
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

export function extractHosts(text: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
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
