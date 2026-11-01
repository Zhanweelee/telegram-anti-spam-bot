import { decisionActions } from "./decision.js";
import type { LogEntry, LogFields } from "./logger.js";

const LABEL = /^[A-Za-z0-9_.:-]{1,64}$/;
const INTERCEPT = new Set(["captcha", "delete", "mute", "ban"]);
const DETECTOR_ERRORS = new Set([
  "detector_error",
  "llm_failed",
  "blocklist_failed",
  "reputation_failed",
  "rate_window_failed",
]);
const ACTIONS = new Set<string>(decisionActions);

export interface MetricCounts {
  readonly screened: number;
  readonly exempt: number;
  readonly intercepted: number;
  readonly interceptRate: number;
  readonly dryRun: number;
  readonly actions: Readonly<Record<string, number>>;
  readonly detectorErrors: number;
  readonly storageFailures: number;
}

export interface ChatMetrics extends MetricCounts {
  readonly tenantId: string;
  readonly chatId: string;
}

export interface MetricReport {
  readonly totals: MetricCounts;
  readonly chats: readonly ChatMetrics[];
}

interface Bucket {
  screened: number;
  exempt: number;
  intercepted: number;
  dryRun: number;
  actions: Record<string, number>;
  detectorErrors: number;
  storageFailures: number;
}

/** Fold structured logs into counts. Labels are ids only. */
export function aggregateMetrics(entries: readonly LogEntry[]): MetricReport {
  const totals = emptyBucket();
  const chats = new Map<
    string,
    { tenantId: string; chatId: string; bucket: Bucket }
  >();
  for (const entry of entries) {
    const kind = classify(entry);
    if (!kind) {
      continue;
    }
    apply(totals, kind);
    const scope = chatScope(entry.fields);
    if (!scope) {
      continue;
    }
    const key = `${scope.tenantId}\n${scope.chatId}`;
    const existing = chats.get(key);
    const bucket = existing?.bucket ?? emptyBucket();
    apply(bucket, kind);
    chats.set(key, { ...scope, bucket });
  }
  return {
    totals: finish(totals),
    chats: [...chats.values()].sort(byChat).map((item) => ({
      tenantId: item.tenantId,
      chatId: item.chatId,
      ...finish(item.bucket),
    })),
  };
}

type Kind =
  | { readonly type: "screen"; readonly action: string }
  | { readonly type: "exempt" }
  | { readonly type: "dry_run" }
  | { readonly type: "detector_error" }
  | { readonly type: "storage_failure" };

function classify(entry: LogEntry): Kind | null {
  if (entry.message === "pipeline_completed") {
    const action = label(entry.fields, "action");
    if (!action || !ACTIONS.has(action)) {
      return null;
    }
    if (entry.fields.dryRun === true) {
      return { type: "dry_run" };
    }
    return { type: "screen", action };
  }
  if (entry.message === "pipeline_exempt") {
    return { type: "exempt" };
  }
  if (DETECTOR_ERRORS.has(entry.message)) {
    return { type: "detector_error" };
  }
  if (isStorageFailure(entry)) {
    return { type: "storage_failure" };
  }
  return null;
}

function isStorageFailure(entry: LogEntry): boolean {
  if (entry.message === "policy_store_failed") {
    return true;
  }
  return (
    entry.message === "audit_failed" && entry.fields.code === "storage_failed"
  );
}

function apply(bucket: Bucket, kind: Kind): void {
  if (kind.type === "screen") {
    bucket.screened += 1;
    bucket.actions[kind.action] = (bucket.actions[kind.action] ?? 0) + 1;
    if (INTERCEPT.has(kind.action)) {
      bucket.intercepted += 1;
    }
    return;
  }
  if (kind.type === "exempt") {
    bucket.screened += 1;
    bucket.exempt += 1;
    return;
  }
  if (kind.type === "dry_run") {
    bucket.dryRun += 1;
    return;
  }
  if (kind.type === "detector_error") {
    bucket.detectorErrors += 1;
    return;
  }
  bucket.storageFailures += 1;
}

function chatScope(
  fields: LogFields,
): { tenantId: string; chatId: string } | null {
  const tenantId = label(fields, "tenantId");
  const chatId = label(fields, "chatId");
  if (!tenantId || !chatId) {
    return null;
  }
  return { tenantId, chatId };
}

function label(fields: LogFields, key: string): string | null {
  const value = fields[key];
  if (typeof value !== "string" || !LABEL.test(value)) {
    return null;
  }
  return value;
}

function emptyBucket(): Bucket {
  return {
    screened: 0,
    exempt: 0,
    intercepted: 0,
    dryRun: 0,
    actions: {},
    detectorErrors: 0,
    storageFailures: 0,
  };
}

function finish(bucket: Bucket): MetricCounts {
  const actions: Record<string, number> = {};
  for (const action of decisionActions) {
    const count = bucket.actions[action];
    if (count !== undefined && count > 0) {
      actions[action] = count;
    }
  }
  return {
    screened: bucket.screened,
    exempt: bucket.exempt,
    intercepted: bucket.intercepted,
    interceptRate:
      bucket.screened === 0 ? 0 : bucket.intercepted / bucket.screened,
    dryRun: bucket.dryRun,
    actions,
    detectorErrors: bucket.detectorErrors,
    storageFailures: bucket.storageFailures,
  };
}

function byChat(
  left: { tenantId: string; chatId: string },
  right: { tenantId: string; chatId: string },
): number {
  const tenant = left.tenantId.localeCompare(right.tenantId);
  if (tenant !== 0) {
    return tenant;
  }
  return left.chatId.localeCompare(right.chatId);
}
