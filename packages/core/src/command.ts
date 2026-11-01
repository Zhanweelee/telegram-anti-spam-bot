import type { Cache } from "./cache.js";
import type { Event } from "./event.js";
import type { Logger } from "./logger.js";
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
] as const;
type CommandName = (typeof COMMAND_NAMES)[number];

const HELP = [
  "命令：",
  "/help",
  "/rules [chatId]",
  "/whitelist <chatId>",
  "/whitelist <chatId> add <actorId>",
  "/whitelist <chatId> remove <actorId>",
  "/logs [chatId]",
  "/dryrun <chatId>",
  "/dryrun <chatId> on|off",
  "/export [chatId]",
  "/forget [chatId]",
].join("\n");

const DENIED = "没有权限";
const INVALID = "参数无效";
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
    return { status: "reply", command: parsed.name, text: DENIED };
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
      return HELP;
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
  }
}

async function showRules(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length > 1) {
    return "用法：/rules [chatId]";
  }
  const chatId = args[0] ?? input.event.chatId;
  if (!isTargetId(chatId)) {
    return INVALID;
  }
  const rules = await loadRuleSet({
    tenantId: input.event.tenantId,
    chatId,
    cache: input.cache,
    source: input.source,
    logger: input.logger,
  });
  const lines = [`rules ${chatId}`];
  if (rules.rules.length === 0) {
    lines.push("none");
    return lines.join("\n");
  }
  for (const rule of rules.rules) {
    const state = rule.enabled ? "enabled" : "disabled";
    lines.push(
      `${rule.id} ${state} threshold ${rule.threshold} actions ${rule.actions.join(",")}`,
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
    return "用法：/whitelist <chatId> [add|remove <actorId>]";
  }
  const op = args[1];
  const actorId = args[2];
  if (
    args.length > 3 ||
    (op !== undefined && op !== "add" && op !== "remove")
  ) {
    return "用法：/whitelist <chatId> [add|remove <actorId>]";
  }
  if (
    (op === "add" || op === "remove") &&
    (actorId === undefined || !isTargetId(actorId))
  ) {
    return INVALID;
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
    return formatPolicy(chatId, current);
  }
  const nextIds =
    op === "add"
      ? addActor(current.allowActorIds, actorId ?? "")
      : current.allowActorIds.filter((id) => id !== actorId);
  if (sameIds(current.allowActorIds, nextIds)) {
    return formatPolicy(chatId, current);
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
    return INVALID;
  }
  return formatPolicy(chatId, next);
}

async function showLogs(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length > 1) {
    return "用法：/logs [chatId]";
  }
  const chatId = args[0];
  if (chatId !== undefined && !isTargetId(chatId)) {
    return INVALID;
  }
  const records = await input.storage.listAudits(
    chatId === undefined
      ? { tenantId: input.event.tenantId, limit: LOG_LIMIT }
      : { tenantId: input.event.tenantId, chatId, limit: LOG_LIMIT },
  );
  if (records.length === 0) {
    return "no audits";
  }
  return records.map(formatAudit).join("\n");
}

async function exportAudits(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  const scope = resolveScope(input, args, "/export [chatId]");
  if (typeof scope === "string") {
    return scope;
  }
  try {
    const records = await input.storage.exportAudits(scope);
    const json = auditExportDocument(scope, records);
    if (json.length > EXPORT_REPLY_LIMIT) {
      return `导出 ${records.length} 条，超过私聊长度`;
    }
    return json;
  } catch {
    input.logger.warn("operator_rejected", {
      eventId: input.event.id,
      chatId: input.event.chatId,
      command: "export",
    });
    return INVALID;
  }
}

async function forgetAudits(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  const scope = resolveScope(input, args, "/forget [chatId]");
  if (typeof scope === "string") {
    return scope;
  }
  try {
    const records = await input.storage.exportAudits(scope);
    await input.storage.deleteAudits(scope);
    return `已删除 ${records.length} 条`;
  } catch {
    input.logger.warn("operator_rejected", {
      eventId: input.event.id,
      chatId: input.event.chatId,
      command: "forget",
    });
    return INVALID;
  }
}

function resolveScope(
  input: OperatorCommandInput,
  args: readonly string[],
  usage: string,
): AuditScope | string {
  if (args.length > 1) {
    return `用法：${usage}`;
  }
  const chatId = args[0];
  if (chatId !== undefined && !isTargetId(chatId)) {
    return INVALID;
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
    return "用法：/dryrun <chatId> [on|off]";
  }
  const mode = args[1];
  if (mode !== undefined && mode !== "on" && mode !== "off") {
    return "用法：/dryrun <chatId> [on|off]";
  }
  if (mode === "on" || mode === "off") {
    await input.runtime.setDryRun(input.event.tenantId, chatId, mode === "on");
  }
  const enabled = await input.runtime.getDryRun(input.event.tenantId, chatId);
  return `dry-run ${chatId} ${enabled ? "on" : "off"}`;
}

function formatPolicy(chatId: string, policy: PrefilterPolicy): string {
  const allow =
    policy.allowActorIds.length === 0 ? "none" : policy.allowActorIds.join(",");
  return `whitelist ${chatId}\nexemptAdmins ${policy.exemptAdmins}\nallow ${allow}`;
}

function formatAudit(record: AuditRecord): string {
  const reasons = record.reasons.map(safeToken).join(",");
  const rules = record.ruleIds.map(safeToken).join(",");
  return `${record.createdAt} ${safeToken(record.eventId)} ${record.action} score ${record.score} rules ${rules} reasons ${reasons}`;
}

function safeToken(value: string): string {
  if (
    value.length === 0 ||
    value.length > TOKEN_LIMIT ||
    /[\r\n]/.test(value)
  ) {
    return "redacted";
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

function isCommandName(value: string): value is CommandName {
  return (COMMAND_NAMES as readonly string[]).includes(value);
}
