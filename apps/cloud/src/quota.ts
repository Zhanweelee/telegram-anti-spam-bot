import {
  type QuotaPeriod,
  type QuotaSnapshot,
  quotaPeriods,
  type RuleSet,
  ruleSurvivesQuota,
} from "@tasb/core";
import { z } from "zod";

const pluginIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const dayMs = 24 * 60 * 60 * 1000;
const rollingWindowMs = 30 * dayMs;
const maxChatsDefault = 256;
const maxCount = 1_000_000;
const seenEventLimit = 64;
const seenEventIdPattern = /^[A-Za-z0-9_.:-]{1,128}$/;

export const defaultQuotaLimit = 3000;

export const defaultBasicDetectorIds = [
  "keyword",
  "join",
  "flood",
  "repeat",
  "link",
  "blocklist",
  "forward",
  "regex",
] as const;

export const quotaPolicySchema = z.strictObject({
  enabled: z.boolean(),
  limit: z.number().int().positive().max(maxCount),
  period: z.enum(quotaPeriods),
  basicDetectorIds: z.array(pluginIdSchema).min(1).max(32),
});

export type QuotaPolicy = z.output<typeof quotaPolicySchema>;

export interface QuotaUsage {
  readonly tenantId: string;
  readonly chatId: string;
  readonly atIso: string;
  readonly policy: QuotaPolicy;
  /** When set, a repeat of this id does not increment the counter. */
  readonly eventId?: string;
}

export interface QuotaStore {
  consume(input: QuotaUsage): Promise<QuotaSnapshot | null>;
  read(input: QuotaUsage): Promise<QuotaSnapshot | null>;
}

interface Bucket {
  used: number;
  startedAtMs: number;
  seen: string[];
}

export function defaultQuotaPolicy(enabled: boolean): QuotaPolicy {
  return {
    enabled,
    limit: defaultQuotaLimit,
    period: "calendar_month",
    basicDetectorIds: [...defaultBasicDetectorIds],
  };
}

export function quotaPolicyFromEnv(env: {
  readonly DEPLOYMENT_MODE?: string;
  readonly QUOTA_ENABLED?: string;
  readonly QUOTA_LIMIT?: string;
  readonly QUOTA_PERIOD?: string;
  readonly QUOTA_BASIC?: string;
}): QuotaPolicy {
  const enabled = enabledFromEnv(env);
  const base = defaultQuotaPolicy(enabled);
  const limit = positiveInt(env.QUOTA_LIMIT);
  const period = periodFromEnv(env.QUOTA_PERIOD);
  const basic = basicFromEnv(env.QUOTA_BASIC);
  return quotaPolicySchema.parse({
    enabled,
    limit: limit ?? base.limit,
    period: period ?? base.period,
    basicDetectorIds: basic ?? base.basicDetectorIds,
  });
}

export function degradeRules(
  rules: RuleSet,
  basicDetectorIds: readonly string[],
): RuleSet {
  return {
    version: rules.version,
    aggregate: rules.aggregate,
    rules: rules.rules.filter((rule) =>
      ruleSurvivesQuota(rule.detectorIds, basicDetectorIds),
    ),
  };
}

export function createMemoryQuotaStore(options?: {
  readonly maxChats?: number;
}): QuotaStore {
  const maxChats = options?.maxChats ?? maxChatsDefault;
  const buckets = new Map<string, Bucket>();
  return {
    async consume(input) {
      return touch(buckets, maxChats, input, true);
    },
    async read(input) {
      return touch(buckets, maxChats, input, false);
    },
  };
}

function enabledFromEnv(env: {
  readonly DEPLOYMENT_MODE?: string;
  readonly QUOTA_ENABLED?: string;
}): boolean {
  if (env.QUOTA_ENABLED === "false") {
    return false;
  }
  if (env.QUOTA_ENABLED === "true") {
    return true;
  }
  return env.DEPLOYMENT_MODE === "cloud";
}

function positiveInt(value: string | undefined): number | null {
  if (value === undefined || !/^[1-9]\d{0,6}$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maxCount) {
    return null;
  }
  return parsed;
}

function periodFromEnv(value: string | undefined): QuotaPeriod | null {
  if (value === "calendar_month" || value === "rolling_30d") {
    return value;
  }
  return null;
}

function basicFromEnv(value: string | undefined): string[] | null {
  if (value === undefined) {
    return null;
  }
  const ids: string[] = [];
  for (const part of value.split(",")) {
    const id = part.trim();
    if (!pluginIdSchema.safeParse(id).success || ids.includes(id)) {
      continue;
    }
    ids.push(id);
    if (ids.length >= 32) {
      break;
    }
  }
  return ids.length === 0 ? null : ids;
}

function touch(
  buckets: Map<string, Bucket>,
  maxChats: number,
  input: QuotaUsage,
  increment: boolean,
): QuotaSnapshot | null {
  const policy = input.policy;
  if (!policy.enabled) {
    return {
      enabled: false,
      used: 0,
      limit: policy.limit,
      period: policy.period,
      degraded: false,
    };
  }
  const nowMs = Date.parse(input.atIso);
  if (!Number.isFinite(nowMs)) {
    return null;
  }
  const key = `${input.tenantId}\n${input.chatId}`;
  let bucket = buckets.get(key);
  if (bucket && !samePeriod(bucket.startedAtMs, nowMs, policy.period)) {
    if (nowMs < bucket.startedAtMs) {
      return snapshot(
        policy,
        increment ? bucket.used : 0,
        nowMs,
        bucket.startedAtMs,
      );
    }
    bucket.used = 0;
    bucket.startedAtMs = nowMs;
    bucket.seen = [];
  }
  if (!bucket) {
    if (!increment) {
      return snapshot(policy, 0, nowMs, null);
    }
    if (buckets.size >= maxChats) {
      sweep(buckets, nowMs, policy.period);
    }
    if (buckets.size >= maxChats) {
      return null;
    }
    bucket = { used: 0, startedAtMs: nowMs, seen: [] };
    buckets.set(key, bucket);
  }
  if (increment && bucket.used < maxCount) {
    const eventId = rememberedEventId(input.eventId);
    if (eventId !== null && bucket.seen.includes(eventId)) {
      return snapshot(policy, bucket.used, nowMs, bucket.startedAtMs);
    }
    bucket.used += 1;
    rememberEvent(bucket, eventId);
  }
  return snapshot(policy, bucket.used, nowMs, bucket.startedAtMs);
}

function rememberedEventId(value: string | undefined): string | null {
  if (value === undefined || !seenEventIdPattern.test(value)) {
    return null;
  }
  return value;
}

function rememberEvent(bucket: Bucket, eventId: string | null): void {
  if (eventId === null) {
    return;
  }
  bucket.seen.push(eventId);
  if (bucket.seen.length > seenEventLimit) {
    bucket.seen.shift();
  }
}

function snapshot(
  policy: QuotaPolicy,
  used: number,
  atMs: number,
  startedAtMs: number | null,
): QuotaSnapshot {
  const base = {
    enabled: true as const,
    used,
    limit: policy.limit,
    period: policy.period,
    degraded: used > policy.limit,
  };
  const resetsAt = resetInstant(policy.period, atMs, startedAtMs);
  if (resetsAt === undefined) {
    return base;
  }
  return { ...base, resetsAt };
}

function resetInstant(
  period: QuotaPeriod,
  atMs: number,
  startedAtMs: number | null,
): string | undefined {
  if (period === "calendar_month") {
    const anchor = new Date(atMs);
    return new Date(
      Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 1),
    ).toISOString();
  }
  if (startedAtMs === null) {
    return undefined;
  }
  return new Date(startedAtMs + rollingWindowMs).toISOString();
}

function samePeriod(
  startedAtMs: number,
  nowMs: number,
  period: QuotaPeriod,
): boolean {
  if (period === "rolling_30d") {
    return nowMs - startedAtMs < rollingWindowMs;
  }
  const start = new Date(startedAtMs);
  const now = new Date(nowMs);
  return (
    start.getUTCFullYear() === now.getUTCFullYear() &&
    start.getUTCMonth() === now.getUTCMonth()
  );
}

function sweep(
  buckets: Map<string, Bucket>,
  nowMs: number,
  period: QuotaPeriod,
): void {
  for (const [key, bucket] of buckets) {
    if (!samePeriod(bucket.startedAtMs, nowMs, period)) {
      buckets.delete(key);
    }
  }
}
