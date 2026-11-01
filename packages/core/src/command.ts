import {
  type BlocklistEntry,
  type BlocklistStore,
  blocklistEntrySchema,
} from "./blocklist.js";
import type { Cache } from "./cache.js";
import type { Event } from "./event.js";
import type { Logger } from "./logger.js";
import type { Locale } from "./messages.js";
import { translate } from "./messages.js";
import {
  defaultPrefilterPolicy,
  loadPolicy,
  savePolicy,
} from "./policy-load.js";
import type { PolicyStore } from "./policy-store.js";
import {
  type AuditRecord,
  type AuditScope,
  auditExportDocument,
  type Storage,
} from "./ports.js";
import type { PrefilterPolicy } from "./prefilter.js";
import {
  buildReviewSample,
  type ReviewLabel,
  type ReviewQueue,
} from "./review.js";
import { loadRuleSet, type RuleSource } from "./rules-load.js";
import type { RuntimeStore } from "./runtime.js";

const COMMAND_NAMES = [
  "help",
  "rules",
  "whitelist",
  "logs",
  "dryrun",
  "export",
  "forget",
  "blocklist",
  "appeal",
] as const;
type CommandName = (typeof COMMAND_NAMES)[number];

const LOG_LIMIT = 10;
const TOKEN_LIMIT = 80;
const EXPORT_REPLY_LIMIT = 3500;

export interface OperatorCommandInput {
  readonly event: Event;
  readonly adminActorIds: readonly string[];
  readonly cache: Cache;
  readonly policyStore: PolicyStore;
  readonly runtime: RuntimeStore;
  readonly source: RuleSource;
  readonly storage: Storage;
  readonly logger: Logger;
  readonly fallback?: PrefilterPolicy;
  readonly blocklist?: BlocklistStore;
  readonly review?: ReviewQueue;
  readonly locale?: Locale;
}

export type OperatorCommandResult =
  | { readonly status: "skip" }
  | {
      readonly status: "reply";
      readonly command: CommandName;
      readonly text: string;
    };

export async function runOperatorCommand(
  input: OperatorCommandInput,
): Promise<OperatorCommandResult> {
  if (input.event.direct !== true) {
    return { status: "skip" };
  }
  const text = input.event.message?.text ?? "";
  const parsed = parseOperatorCommand(text);
  if (!parsed) {
    return { status: "skip" };
  }
  const admins = new Set(input.adminActorIds.slice(0, 64));
  if (!admins.has(input.event.actor.id)) {
    input.logger.warn("operator_denied", {
      eventId: input.event.id,
      chatId: input.event.chatId,
      command: parsed.name,
    });
    return {
      status: "reply",
      command: parsed.name,
      text: say(input, "command.denied"),
    };
  }
  input.logger.info("operator_command", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: parsed.name,
  });
  const textReply = await dispatch(input, parsed.name, parsed.args);
  return { status: "reply", command: parsed.name, text: textReply };
}

export function parseOperatorCommand(
  text: string,
): { readonly name: CommandName; readonly args: readonly string[] } | null {
  const parts = text.trim().split(/\s+/);
  const head = parts[0];
  if (!head) {
    return null;
  }
  const match = /^\/([a-z]+)(?:@[A-Za-z0-9_]{1,64})?$/.exec(head);
  const name = match?.[1];
  if (!name || !isCommandName(name)) {
    return null;
  }
  return { name, args: parts.slice(1) };
}

async function dispatch(
  input: OperatorCommandInput,
  name: CommandName,
  args: readonly string[],
): Promise<string> {
  switch (name) {
    case "help":
      return say(input, "command.help");
    case "rules":
      return showRules(input, args);
    case "whitelist":
      return editWhitelist(input, args);
    case "logs":
      return showLogs(input, args);
    case "dryrun":
      return editDryRun(input, args);
    case "export":
      return exportAudits(input, args);
    case "forget":
      return forgetAudits(input, args);
    case "blocklist":
      return editBlocklist(input, args);
    case "appeal":
      return appealAudit(input, args);
  }
}

async function showRules(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length > 1) {
    return say(input, "command.rules.usage");
  }
  const chatId = args[0] ?? input.event.chatId;
  if (!isTargetId(chatId)) {
    return say(input, "command.invalid");
  }
  const rules = await loadRuleSet({
    tenantId: input.event.tenantId,
    chatId,
    cache: input.cache,
    source: input.source,
    logger: input.logger,
  });
  const lines = [say(input, "command.rules.header", { chatId })];
  if (rules.rules.length === 0) {
    lines.push(say(input, "command.rules.empty"));
    return lines.join("\n");
  }
  for (const rule of rules.rules) {
    const state = say(
      input,
      rule.enabled ? "command.rules.enabled" : "command.rules.disabled",
    );
    lines.push(
      say(input, "command.rules.line", {
        id: rule.id,
        state,
        threshold: rule.threshold,
        actions: rule.actions.join(","),
      }),
    );
  }
  return lines.join("\n");
}

async function editWhitelist(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  const chatId = args[0];
  if (!chatId || !isTargetId(chatId)) {
    return say(input, "command.whitelist.usage");
  }
  const op = args[1];
  const actorId = args[2];
  if (
    args.length > 3 ||
    (op !== undefined && op !== "add" && op !== "remove")
  ) {
    return say(input, "command.whitelist.usage");
  }
  if (
    (op === "add" || op === "remove") &&
    (actorId === undefined || !isTargetId(actorId))
  ) {
    return say(input, "command.invalid");
  }
  const current = await loadPolicy({
    tenantId: input.event.tenantId,
    chatId,
    cache: input.cache,
    store: input.policyStore,
    logger: input.logger,
    fallback: input.fallback ?? defaultPrefilterPolicy,
  });
  if (op === undefined) {
    return formatPolicy(input, chatId, current);
  }
  const nextIds =
    op === "add"
      ? addActor(current.allowActorIds, actorId ?? "")
      : current.allowActorIds.filter((id) => id !== actorId);
  if (sameIds(current.allowActorIds, nextIds)) {
    return formatPolicy(input, chatId, current);
  }
  const next = { exemptAdmins: current.exemptAdmins, allowActorIds: nextIds };
  try {
    await savePolicy({
      tenantId: input.event.tenantId,
      chatId,
      policy: next,
      cache: input.cache,
      store: input.policyStore,
      logger: input.logger,
    });
  } catch {
    input.logger.warn("operator_rejected", {
      eventId: input.event.id,
      chatId: input.event.chatId,
      command: "whitelist",
    });
    return say(input, "command.invalid");
  }
  return formatPolicy(input, chatId, next);
}

async function showLogs(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length > 1) {
    return say(input, "command.logs.usage");
  }
  const chatId = args[0];
  if (chatId !== undefined && !isTargetId(chatId)) {
    return say(input, "command.invalid");
  }
  const records = await input.storage.listAudits(
    chatId === undefined
      ? { tenantId: input.event.tenantId, limit: LOG_LIMIT }
      : { tenantId: input.event.tenantId, chatId, limit: LOG_LIMIT },
  );
  if (records.length === 0) {
    return say(input, "command.logs.empty");
  }
  return records.map((record) => formatAudit(input, record)).join("\n");
}

async function exportAudits(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  const scope = resolveScope(input, args, "command.export.usage");
  if (typeof scope === "string") {
    return scope;
  }
  try {
    const records = await input.storage.exportAudits(scope);
    const json = auditExportDocument(scope, records);
    if (json.length > EXPORT_REPLY_LIMIT) {
      return say(input, "command.export.too_long", { count: records.length });
    }
    return json;
  } catch {
    input.logger.warn("operator_rejected", {
      eventId: input.event.id,
      chatId: input.event.chatId,
      command: "export",
    });
    return say(input, "command.invalid");
  }
}

async function forgetAudits(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  const scope = resolveScope(input, args, "command.forget.usage");
  if (typeof scope === "string") {
    return scope;
  }
  try {
    const records = await input.storage.exportAudits(scope);
    await input.storage.deleteAudits(scope);
    return say(input, "command.forget.deleted", { count: records.length });
  } catch {
    input.logger.warn("operator_rejected", {
      eventId: input.event.id,
      chatId: input.event.chatId,
      command: "forget",
    });
    return say(input, "command.invalid");
  }
}

function resolveScope(
  input: OperatorCommandInput,
  args: readonly string[],
  usageKey: string,
): AuditScope | string {
  if (args.length > 1) {
    return say(input, usageKey);
  }
  const chatId = args[0];
  if (chatId !== undefined && !isTargetId(chatId)) {
    return say(input, "command.invalid");
  }
  return chatId === undefined
    ? { tenantId: input.event.tenantId }
    : { tenantId: input.event.tenantId, chatId };
}

async function editDryRun(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  const chatId = args[0];
  if (!chatId || !isTargetId(chatId) || args.length > 2) {
    return say(input, "command.dryrun.usage");
  }
  const mode = args[1];
  if (mode !== undefined && mode !== "on" && mode !== "off") {
    return say(input, "command.dryrun.usage");
  }
  if (mode === "on" || mode === "off") {
    await input.runtime.setDryRun(input.event.tenantId, chatId, mode === "on");
  }
  const enabled = await input.runtime.getDryRun(input.event.tenantId, chatId);
  return say(input, "command.dryrun.status", {
    chatId,
    state: say(input, enabled ? "command.switch.on" : "command.switch.off"),
  });
}

function formatPolicy(
  input: OperatorCommandInput,
  chatId: string,
  policy: PrefilterPolicy,
): string {
  const allow =
    policy.allowActorIds.length === 0
      ? say(input, "command.allow.empty")
      : policy.allowActorIds.join(",");
  return say(input, "command.whitelist.body", {
    chatId,
    exemptAdmins: String(policy.exemptAdmins),
    allow,
  });
}

function formatAudit(input: OperatorCommandInput, record: AuditRecord): string {
  const reasons = record.reasons
    .map((reason) => safeToken(input, reason))
    .join(",");
  const rules = record.ruleIds
    .map((ruleId) => safeToken(input, ruleId))
    .join(",");
  return say(input, "command.logs.line", {
    createdAt: record.createdAt,
    eventId: safeToken(input, record.eventId),
    action: record.action,
    score: record.score,
    rules,
    reasons,
  });
}

function safeToken(input: OperatorCommandInput, value: string): string {
  if (
    value.length === 0 ||
    value.length > TOKEN_LIMIT ||
    /[\r\n]/.test(value)
  ) {
    return say(input, "command.redacted");
  }
  return value;
}

function addActor(ids: readonly string[], actorId: string): string[] {
  if (ids.includes(actorId)) {
    return [...ids];
  }
  return [...ids, actorId];
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((id, index) => id === right[index])
  );
}

function isTargetId(value: string): boolean {
  return /^-?\d{1,20}$/.test(value);
}

async function editBlocklist(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  const store = input.blocklist;
  if (!store) {
    rejectBlocklist(input);
    return say(input, "command.invalid");
  }
  const chatId = args[0];
  if (!chatId || !isTargetId(chatId)) {
    return args.length === 0
      ? say(input, "command.blocklist.usage")
      : say(input, "command.invalid");
  }
  const op = args[1];
  if (op === undefined) {
    const enabled = await readEnabled(input, store, chatId);
    return enabled === null
      ? say(input, "command.invalid")
      : formatBlocklist(input, chatId, enabled);
  }
  if (op === "on" || op === "off") {
    if (args.length !== 2) {
      return say(input, "command.blocklist.usage");
    }
    const wrote = await writeBlocklist(input, () =>
      store.setEnabled(input.event.tenantId, chatId, op === "on"),
    );
    if (!wrote) {
      return say(input, "command.invalid");
    }
    const enabled = await readEnabled(input, store, chatId);
    return enabled === null
      ? say(input, "command.invalid")
      : formatBlocklist(input, chatId, enabled);
  }
  if (op !== "add" || args.length !== 4) {
    return say(input, "command.blocklist.usage");
  }
  const kind = args[2];
  const raw = args[3];
  if ((kind !== "actor" && kind !== "hash") || raw === undefined) {
    return say(input, "command.blocklist.usage");
  }
  const candidate: BlocklistEntry =
    kind === "hash"
      ? { kind: "hash", value: raw.toLowerCase() }
      : { kind: "actor", value: raw };
  const parsed = blocklistEntrySchema.safeParse(candidate);
  if (!parsed.success) {
    return say(input, "command.invalid");
  }
  const wrote = await writeBlocklist(input, () =>
    store.add(input.event.tenantId, parsed.data),
  );
  if (!wrote) {
    return say(input, "command.invalid");
  }
  const enabled = await readEnabled(input, store, chatId);
  if (enabled === null) {
    return say(input, "command.invalid");
  }
  return say(input, "command.blocklist.added", {
    status: formatBlocklist(input, chatId, enabled),
  });
}

async function readEnabled(
  input: OperatorCommandInput,
  store: BlocklistStore,
  chatId: string,
): Promise<boolean | null> {
  try {
    return await store.isEnabled(input.event.tenantId, chatId);
  } catch {
    rejectBlocklist(input);
    return null;
  }
}

async function writeBlocklist(
  input: OperatorCommandInput,
  run: () => Promise<void>,
): Promise<boolean> {
  try {
    await run();
    return true;
  } catch {
    rejectBlocklist(input);
    return false;
  }
}

function rejectBlocklist(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "blocklist",
  });
}

function formatBlocklist(
  input: OperatorCommandInput,
  chatId: string,
  enabled: boolean,
): string {
  return say(input, "command.blocklist.status", {
    chatId,
    state: say(input, enabled ? "command.switch.on" : "command.switch.off"),
  });
}

function say(
  input: OperatorCommandInput,
  key: string,
  vars?: Readonly<Record<string, string | number>>,
): string {
  return translate(input.locale ?? "zh", key, vars);
}

function isEventId(value: string): boolean {
  return /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
}

async function appealAudit(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  const queue = input.review;
  if (!queue) {
    rejectAppeal(input);
    return say(input, "command.invalid");
  }
  if (args.length !== 3) {
    return say(input, "command.appeal.usage");
  }
  const chatId = args[0];
  const eventId = args[1];
  const verb = args[2];
  if (!chatId || !isTargetId(chatId) || !eventId || !isEventId(eventId)) {
    return say(input, "command.invalid");
  }
  const label = appealLabel(verb);
  if (!label) {
    return say(input, "command.appeal.usage");
  }
  const audit = await readAudit(input, chatId, eventId);
  if (audit === "failed") {
    return say(input, "command.invalid");
  }
  if (audit === null) {
    return say(input, "command.appeal.missing");
  }
  try {
    await queue.enqueue(
      buildReviewSample(audit, label, input.event.occurredAt),
    );
  } catch {
    rejectAppeal(input);
    return say(input, "command.invalid");
  }
  input.logger.info("review_queued", {
    eventId: input.event.id,
    chatId,
    label,
  });
  return say(input, "command.appeal.queued", {
    chatId,
    eventId,
    label: say(input, appealLabelKey(label)),
  });
}

function appealLabel(value: string | undefined): ReviewLabel | null {
  if (value === "false") {
    return "false_positive";
  }
  if (value === "confirm") {
    return "confirmed";
  }
  return null;
}

function appealLabelKey(
  label: ReviewLabel,
): "command.appeal.false_positive" | "command.appeal.confirmed" {
  return label === "false_positive"
    ? "command.appeal.false_positive"
    : "command.appeal.confirmed";
}

async function readAudit(
  input: OperatorCommandInput,
  chatId: string,
  eventId: string,
): Promise<AuditRecord | null | "failed"> {
  try {
    return await input.storage.getAudit(input.event.tenantId, chatId, eventId);
  } catch {
    rejectAppeal(input);
    return "failed";
  }
}

function rejectAppeal(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "appeal",
  });
}

function isCommandName(value: string): value is CommandName {
  return (COMMAND_NAMES as readonly string[]).includes(value);
}
