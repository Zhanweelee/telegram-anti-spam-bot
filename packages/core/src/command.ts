import {
  type BlocklistEntry,
  type BlocklistStore,
  blocklistEntrySchema,
} from "./blocklist.js";
import type { Cache } from "./cache.js";
import type { ChatDirectory } from "./chats.js";
import type { Event } from "./event.js";
import { feedbackEvalDocument } from "./feedback-eval.js";
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
  type QuotaReader,
  quotaSnapshotSchema,
  ruleSurvivesQuota,
} from "./quota.js";
import {
  buildReviewSample,
  type ReviewLabel,
  type ReviewQueue,
} from "./review.js";
import type { RuleSet } from "./rule.js";
import {
  parseRulePackId,
  type RulePackArchive,
  type RulePackSource,
  type RuleSubscriptionStore,
} from "./rule-pack.js";
import {
  loadRuleSet,
  type RulePackRequest,
  type RuleSource,
  resolveRuleSet,
} from "./rules-load.js";
import type { RuleSwitch, RuntimeStore } from "./runtime.js";

const COMMAND_NAMES = [
  "help",
  "rules",
  "rule",
  "whitelist",
  "logs",
  "dryrun",
  "export",
  "forget",
  "blocklist",
  "appeal",
  "evals",
  "packs",
  "quota",
  "chats",
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
  readonly rulePacks?: RuleSubscriptionStore;
  readonly rulePackSource?: RulePackSource;
  readonly rulePackArchive?: RulePackArchive;
  readonly quota?: QuotaReader;
  readonly chats?: ChatDirectory;
  readonly scope?: CommandScope;
}

interface CommandScope {
  readonly all: boolean;
  readonly ids: readonly string[];
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
  const scope = admins.has(input.event.actor.id)
    ? { all: true, ids: [] }
    : await actorScope(input, parsed.name);
  if (!scope) {
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
  const textReply = await dispatch(
    { ...input, scope },
    parsed.name,
    parsed.args,
  );
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
    case "rule":
      return editRule(input, args);
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
    case "evals":
      return exportEvals(input, args);
    case "packs":
      return editPacks(input, args);
    case "quota":
      return showQuota(input, args);
    case "chats":
      return showChats(input, args);
  }
}

async function actorScope(
  input: OperatorCommandInput,
  command: CommandName,
): Promise<CommandScope | null> {
  const directory = input.chats;
  if (!directory) {
    deny(input, command);
    return null;
  }
  try {
    const ids = await directory.chatsFor(
      input.event.tenantId,
      input.event.actor.id,
    );
    if (ids.length === 0) {
      deny(input, command);
      return null;
    }
    return { all: false, ids };
  } catch {
    input.logger.warn("operator_rejected", {
      eventId: input.event.id,
      chatId: input.event.chatId,
      command,
    });
    return null;
  }
}

function deny(input: OperatorCommandInput, command: CommandName): void {
  input.logger.warn("operator_denied", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command,
  });
}

function scopeOf(input: OperatorCommandInput): CommandScope {
  return input.scope ?? { all: false, ids: [] };
}

function defaultChat(scope: CommandScope): string | undefined {
  if (scope.all || scope.ids.length !== 1) {
    return undefined;
  }
  return scope.ids[0];
}

function refuseChat(
  input: OperatorCommandInput,
  chatId: string | undefined,
): string | undefined {
  const scope = scopeOf(input);
  if (scope.all) {
    return undefined;
  }
  if (chatId !== undefined && scope.ids.includes(chatId)) {
    return undefined;
  }
  return say(input, "command.denied");
}

async function showRules(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length > 1) {
    return say(input, "command.rules.usage");
  }
  const scope = scopeOf(input);
  const chatId =
    args[0] ?? (scope.all ? input.event.chatId : defaultChat(scope));
  if (!chatId || !isTargetId(chatId)) {
    return say(input, scope.all ? "command.invalid" : "command.rules.usage");
  }
  const refused = refuseChat(input, chatId);
  if (refused) {
    return refused;
  }
  const switches = await readRuleSwitches(input, chatId);
  if (!switches) {
    return say(input, "command.invalid");
  }
  const pack = await commandPack(input, chatId);
  if (pack === "failed") {
    return say(input, "command.invalid");
  }
  const rules = await resolveRuleSet({
    tenantId: input.event.tenantId,
    chatId,
    cache: input.cache,
    source: input.source,
    logger: input.logger,
    switches,
    ...(pack ? { pack } : {}),
  });
  const paused = await quotaPausedIds(input, chatId, rules);
  const lines = [
    pack
      ? say(input, "command.rules.pack", { chatId, pack: pack.id })
      : say(input, "command.rules.header", { chatId }),
  ];
  if (rules.rules.length === 0) {
    lines.push(say(input, "command.rules.empty"));
    return lines.join("\n");
  }
  for (const rule of rules.rules) {
    const state = say(
      input,
      rule.enabled ? "command.rules.enabled" : "command.rules.disabled",
    );
    const override = switches.some((item) => item.ruleId === rule.id);
    const line = say(input, "command.rules.line", {
      id: rule.id,
      state,
      source: say(
        input,
        override ? "command.rule.switch" : "command.rule.file",
      ),
      threshold: rule.threshold,
      actions: rule.actions.join(","),
    });
    lines.push(
      paused.has(rule.id)
        ? `${line} ${say(input, "command.rules.paused")}`
        : line,
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
  const refused = refuseChat(input, chatId);
  if (refused) {
    return refused;
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
  const scope = scopeOf(input);
  let chatId = args[0];
  if (chatId === undefined && !scope.all) {
    chatId = defaultChat(scope);
    if (chatId === undefined) {
      return say(input, "command.logs.usage");
    }
  }
  if (chatId !== undefined && !isTargetId(chatId)) {
    return say(input, "command.invalid");
  }
  const refused = refuseChat(input, chatId);
  if (refused) {
    return refused;
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

async function exportEvals(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  const queue = input.review;
  if (!queue) {
    rejectEvals(input);
    return say(input, "command.invalid");
  }
  const scope = resolveScope(input, args, "command.evals.usage");
  if (typeof scope === "string") {
    return scope;
  }
  try {
    const samples = await queue.list(scope);
    const json = feedbackEvalDocument(scope, samples);
    if (json.length > EXPORT_REPLY_LIMIT) {
      return say(input, "command.evals.too_long", { count: samples.length });
    }
    return json;
  } catch {
    rejectEvals(input);
    return say(input, "command.invalid");
  }
}

function rejectEvals(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "evals",
  });
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
  const scope = scopeOf(input);
  let chatId = args[0];
  if (chatId === undefined && !scope.all) {
    chatId = defaultChat(scope);
    if (chatId === undefined) {
      return say(input, usageKey);
    }
  }
  if (chatId !== undefined && !isTargetId(chatId)) {
    return say(input, "command.invalid");
  }
  const refused = refuseChat(input, chatId);
  if (refused) {
    return refused;
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
  const refused = refuseChat(input, chatId);
  if (refused) {
    return refused;
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

async function editRule(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length === 0 || args.length > 3) {
    return say(input, "command.rule.usage");
  }
  const parsed = parseRuleArgs(input, args);
  if (!parsed) {
    return say(input, "command.rule.usage");
  }
  const refused = refuseChat(input, parsed.chatId);
  if (refused) {
    return refused;
  }
  if (!isRuleId(parsed.ruleId)) {
    return say(input, "command.invalid");
  }
  const mode = parsed.mode;
  if (
    mode !== undefined &&
    mode !== "on" &&
    mode !== "off" &&
    mode !== "reset"
  ) {
    return say(input, "command.rule.usage");
  }
  const tenantId = input.event.tenantId;
  const switches = await readRuleSwitches(input, parsed.chatId);
  if (!switches) {
    return say(input, "command.invalid");
  }
  const rules = await loadRuleSet({
    tenantId,
    chatId: parsed.chatId,
    cache: input.cache,
    source: input.source,
    logger: input.logger,
    switches,
  });
  if (!rules.rules.some((rule) => rule.id === parsed.ruleId)) {
    return say(input, "command.rule.missing", { id: parsed.ruleId });
  }
  if (mode === "on" || mode === "off") {
    const saved = await writeRuleSwitch(
      input,
      parsed.chatId,
      parsed.ruleId,
      mode === "on",
    );
    if (saved === "invalid") {
      return say(input, "command.invalid");
    }
    if (saved === "full") {
      input.logger.warn("rule_switch_full", {
        eventId: input.event.id,
        chatId: parsed.chatId,
        command: "rule",
      });
      return say(input, "command.invalid");
    }
  } else if (mode === "reset") {
    const cleared = await removeRuleSwitch(input, parsed.chatId, parsed.ruleId);
    if (!cleared) {
      return say(input, "command.invalid");
    }
  }
  return formatRule(input, parsed.chatId, parsed.ruleId);
}

function parseRuleArgs(
  input: OperatorCommandInput,
  args: readonly string[],
): {
  readonly chatId: string;
  readonly ruleId: string;
  readonly mode?: string;
} | null {
  const head = args[0];
  if (!head) {
    return null;
  }
  if (isTargetId(head)) {
    const ruleId = args[1];
    if (!ruleId) {
      return null;
    }
    const mode = args[2];
    return mode === undefined
      ? { chatId: head, ruleId }
      : { chatId: head, ruleId, mode };
  }
  if (args.length > 2) {
    return null;
  }
  const chatId = defaultChat(scopeOf(input));
  if (!chatId) {
    return null;
  }
  const mode = args[1];
  return mode === undefined
    ? { chatId, ruleId: head }
    : { chatId, ruleId: head, mode };
}

async function readRuleSwitches(
  input: OperatorCommandInput,
  chatId: string,
): Promise<readonly RuleSwitch[] | null> {
  try {
    return await input.runtime.listRuleSwitches(input.event.tenantId, chatId);
  } catch {
    rejectRule(input);
    return null;
  }
}

async function writeRuleSwitch(
  input: OperatorCommandInput,
  chatId: string,
  ruleId: string,
  enabled: boolean,
): Promise<"ok" | "full" | "invalid"> {
  try {
    const saved = await input.runtime.setRuleSwitch(
      input.event.tenantId,
      chatId,
      ruleId,
      enabled,
    );
    return saved ? "ok" : "full";
  } catch {
    rejectRule(input);
    return "invalid";
  }
}

async function removeRuleSwitch(
  input: OperatorCommandInput,
  chatId: string,
  ruleId: string,
): Promise<boolean> {
  try {
    await input.runtime.clearRuleSwitch(input.event.tenantId, chatId, ruleId);
    return true;
  } catch {
    rejectRule(input);
    return false;
  }
}

async function formatRule(
  input: OperatorCommandInput,
  chatId: string,
  ruleId: string,
): Promise<string> {
  const switches = await readRuleSwitches(input, chatId);
  if (!switches) {
    return say(input, "command.invalid");
  }
  const rules = await loadRuleSet({
    tenantId: input.event.tenantId,
    chatId,
    cache: input.cache,
    source: input.source,
    logger: input.logger,
    switches,
  });
  const rule = rules.rules.find((item) => item.id === ruleId);
  if (!rule) {
    return say(input, "command.rule.missing", { id: ruleId });
  }
  const override = switches.some((item) => item.ruleId === ruleId);
  return say(input, "command.rule.status", {
    chatId,
    ruleId,
    state: say(
      input,
      rule.enabled ? "command.rules.enabled" : "command.rules.disabled",
    ),
    source: say(input, override ? "command.rule.switch" : "command.rule.file"),
  });
}

function rejectRule(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "rule",
  });
}

function isRuleId(value: string): boolean {
  return /^[a-z][a-z0-9_-]{0,63}$/.test(value);
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
  const refused = refuseChat(input, chatId);
  if (refused) {
    return refused;
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
  const refused = refuseChat(input, chatId);
  if (refused) {
    return refused;
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

async function editPacks(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  const store = input.rulePacks;
  if (!store) {
    rejectPacks(input);
    return say(input, "command.invalid");
  }
  const chatId = args[0];
  if (!chatId || !isTargetId(chatId) || args.length > 2) {
    return say(input, "command.packs.usage");
  }
  const refused = refuseChat(input, chatId);
  if (refused) {
    return refused;
  }
  const verb = args[1];
  if (verb === undefined) {
    return showPack(input, store, chatId);
  }
  if (verb === "off") {
    return writePack(input, store, chatId, null);
  }
  const packId = parseRulePackId(verb);
  if (!packId) {
    return say(input, "command.invalid");
  }
  return writePack(input, store, chatId, packId);
}

async function showPack(
  input: OperatorCommandInput,
  store: RuleSubscriptionStore,
  chatId: string,
): Promise<string> {
  try {
    const packId = await store.get(input.event.tenantId, chatId);
    return packStatus(input, chatId, packId);
  } catch {
    rejectPacks(input);
    return say(input, "command.invalid");
  }
}

async function writePack(
  input: OperatorCommandInput,
  store: RuleSubscriptionStore,
  chatId: string,
  packId: string | null,
): Promise<string> {
  try {
    await store.put(input.event.tenantId, chatId, packId);
  } catch {
    rejectPacks(input);
    return say(input, "command.invalid");
  }
  return packStatus(input, chatId, packId);
}

function packStatus(
  input: OperatorCommandInput,
  chatId: string,
  packId: string | null,
): string {
  return say(input, "command.packs.status", {
    chatId,
    pack: packId ?? say(input, "command.allow.empty"),
  });
}

async function showQuota(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  const reader = input.quota;
  if (!reader) {
    return say(input, "command.quota.disabled");
  }
  if (args.length !== 1) {
    return say(input, "command.quota.usage");
  }
  const chatId = args[0] ?? "";
  if (!isTargetId(chatId)) {
    return say(input, "command.invalid");
  }
  const refused = refuseChat(input, chatId);
  if (refused) {
    return refused;
  }
  try {
    const parsed = quotaSnapshotSchema.safeParse(
      await reader.read(input.event.tenantId, chatId, input.event.occurredAt),
    );
    if (!parsed.success || !parsed.data.enabled) {
      return say(input, "command.quota.disabled");
    }
    const snapshot = parsed.data;
    const status = say(input, "command.quota.status", {
      chatId,
      used: snapshot.used,
      limit: snapshot.limit,
      period: snapshot.period,
      state: say(
        input,
        snapshot.degraded ? "command.quota.basic" : "command.quota.full",
      ),
    });
    const dated =
      snapshot.resetsAt === undefined
        ? status
        : say(input, "command.quota.until", {
            status,
            resetsAt: snapshot.resetsAt,
          });
    const basics = snapshot.basicDetectorIds;
    if (snapshot.degraded && basics !== undefined && basics.length > 0) {
      return say(input, "command.quota.basics", {
        status: dated,
        basic: basics.join(","),
      });
    }
    return dated;
  } catch {
    input.logger.warn("operator_rejected", {
      eventId: input.event.id,
      chatId: input.event.chatId,
      command: "quota",
    });
    return say(input, "command.invalid");
  }
}

async function showChats(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length !== 0) {
    return say(input, "command.chats.usage");
  }
  const directory = input.chats;
  if (!directory) {
    return say(input, "command.chats.disabled");
  }
  const scope = scopeOf(input);
  try {
    const ids = scope.all
      ? await directory.list(input.event.tenantId)
      : scope.ids;
    if (ids.length === 0) {
      return say(input, "command.chats.empty");
    }
    return say(input, "command.chats.body", { chats: ids.join("\n") });
  } catch {
    input.logger.warn("operator_rejected", {
      eventId: input.event.id,
      chatId: input.event.chatId,
      command: "chats",
    });
    return say(input, "command.invalid");
  }
}

async function commandPack(
  input: OperatorCommandInput,
  chatId: string,
): Promise<RulePackRequest | null | "failed"> {
  const store = input.rulePacks;
  const source = input.rulePackSource;
  const archive = input.rulePackArchive;
  if (!store || !source || !archive) {
    return null;
  }
  try {
    const id = await store.get(input.event.tenantId, chatId);
    if (!id) {
      return null;
    }
    return { id, source, archive };
  } catch {
    input.logger.warn("pack_store_failed", {
      eventId: input.event.id,
      tenantId: input.event.tenantId,
      chatId,
    });
    return "failed";
  }
}

async function quotaPausedIds(
  input: OperatorCommandInput,
  chatId: string,
  rules: RuleSet,
): Promise<ReadonlySet<string>> {
  const reader = input.quota;
  if (!reader) {
    return new Set();
  }
  try {
    const parsed = quotaSnapshotSchema.safeParse(
      await reader.read(input.event.tenantId, chatId, input.event.occurredAt),
    );
    if (!parsed.success) {
      warnQuota(input, chatId);
      return new Set();
    }
    const basic = parsed.data.basicDetectorIds;
    if (!parsed.data.enabled || !parsed.data.degraded || !basic) {
      return new Set();
    }
    return new Set(
      rules.rules
        .filter((rule) => !ruleSurvivesQuota(rule.detectorIds, basic))
        .map((rule) => rule.id),
    );
  } catch {
    warnQuota(input, chatId);
    return new Set();
  }
}

function warnQuota(input: OperatorCommandInput, chatId: string): void {
  input.logger.warn("quota_failed", {
    eventId: input.event.id,
    tenantId: input.event.tenantId,
    chatId,
  });
}

function rejectPacks(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "packs",
  });
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
