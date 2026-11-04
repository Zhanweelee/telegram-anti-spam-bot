import {
  type BlocklistEntry,
  type BlocklistStore,
  blocklistEntrySchema,
} from "./blocklist.js";
import type { Cache } from "./cache.js";
import type { ChatDirectory } from "./chats.js";
import type { Event } from "./event.js";
import { fitFeedbackEvalDocument } from "./feedback-eval.js";
import type { Logger } from "./logger.js";
import type { Locale, MessageKey } from "./messages.js";
import { translate } from "./messages.js";
import {
  defaultPrefilterPolicy,
  loadPolicy,
  savePolicy,
} from "./policy-load.js";
import type { PolicyStore } from "./policy-store.js";
import {
  type AdministratorRight,
  type AuditRecord,
  type AuditScope,
  administratorRights,
  auditExportDocument,
  type ChatAdministrator,
  type DefaultChatPermissions,
  fitAuditExportDocument,
  type MemberStanding,
  type ModerationPort,
  minimumAuditExportLength,
  type PermissionState,
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
  "unban",
  "unmute",
  "ban",
  "mute",
  "member",
  "delete",
  "deletes",
  "decline",
  "approve",
  "bansender",
  "unbansender",
  "lock",
  "unlock",
  "perms",
  "clearreact",
  "revoke",
  "unpin",
  "admins",
  "untopic",
  "closetopic",
  "opentopic",
  "hidegeneral",
  "showgeneral",
  "deltopic",
  "count",
  "pin",
  "unpinmsg",
  "unreact",
  "delphoto",
  "leave",
  "tag",
  "delstickers",
] as const;
type CommandName = (typeof COMMAND_NAMES)[number];

const LOG_LIMIT = 10;
const DEFAULT_MUTE_SECONDS = 60 * 60;
const MIN_MUTE_SECONDS = 30;
const MAX_MUTE_SECONDS = 366 * 24 * 60 * 60;
const TOKEN_LIMIT = 80;
const MAX_DELETE_MESSAGES = 100;
const EXPORT_REPLY_LIMIT = 3500;
const MEMBER_TAG_LIMIT = 16;

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
  readonly moderator?: Partial<
    Pick<
      ModerationPort,
      | "approveJoin"
      | "banActor"
      | "banSenderChat"
      | "clearReactions"
      | "closeTopic"
      | "declineJoin"
      | "deleteMessage"
      | "deleteMessages"
      | "deletePhoto"
      | "deleteStickerSet"
      | "deleteTopic"
      | "hideGeneral"
      | "leaveChat"
      | "lockChat"
      | "muteActor"
      | "openTopic"
      | "pinMessage"
      | "readAdministrators"
      | "readMember"
      | "readMemberCount"
      | "readPermissions"
      | "removeReaction"
      | "revokeInvite"
      | "setMemberTag"
      | "showGeneral"
      | "unbanActor"
      | "unbanSenderChat"
      | "unmuteActor"
      | "unlockChat"
      | "unpinChat"
      | "unpinMessage"
      | "unpinTopic"
    >
  >;
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
    case "unban":
      return unbanMember(input, args);
    case "unmute":
      return unmuteMember(input, args);
    case "ban":
      return banMember(input, args);
    case "mute":
      return muteMember(input, args);
    case "member":
      return showMember(input, args);
    case "delete":
      return deleteOne(input, args);
    case "deletes":
      return deleteMany(input, args);
    case "decline":
      return declineRequest(input, args);
    case "approve":
      return approveRequest(input, args);
    case "bansender":
      return banSender(input, args);
    case "unbansender":
      return unbanSender(input, args);
    case "lock":
      return closeChat(input, args);
    case "unlock":
      return openChat(input, args);
    case "perms":
      return showPermissions(input, args);
    case "clearreact":
      return clearActorReactions(input, args);
    case "revoke":
      return revokeChatInvite(input, args);
    case "unpin":
      return unpinAll(input, args);
    case "admins":
      return showAdministrators(input, args);
    case "untopic":
      return clearTopicPins(input, args);
    case "closetopic":
      return closeForum(input, args);
    case "opentopic":
      return openForum(input, args);
    case "hidegeneral":
      return hideGeneralTopic(input, args);
    case "showgeneral":
      return showGeneralTopic(input, args);
    case "deltopic":
      return deleteOneTopic(input, args);
    case "count":
      return showMemberCount(input, args);
    case "pin":
      return pinOneMessage(input, args);
    case "unpinmsg":
      return unpinOneMessage(input, args);
    case "unreact":
      return removeOneReaction(input, args);
    case "delphoto":
      return deleteChatPhoto(input, args);
    case "leave":
      return leaveOneChat(input, args);
    case "tag":
      return setOneMemberTag(input, args);
    case "delstickers":
      return deleteGroupStickerSet(input, args);
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
  const mark = await quotaRuleMark(input, chatId, rules);
  const header = pack
    ? say(input, "command.rules.pack", { chatId, pack: pack.id })
    : say(input, "command.rules.header", { chatId });
  const lines = [
    mark.resetsAt === undefined
      ? header
      : say(input, "command.rules.until", {
          status: header,
          resetsAt: mark.resetsAt,
        }),
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
      mark.paused.has(rule.id)
        ? `${line} ${say(input, "command.rules.paused")}`
        : line,
    );
  }
  return fitRuleLines(input, lines);
}

function fitRuleLines(
  input: OperatorCommandInput,
  lines: readonly string[],
): string {
  const full = lines.join("\n");
  if (full.length <= EXPORT_REPLY_LIMIT) {
    return full;
  }
  const header = lines[0] ?? "";
  const rules = lines.slice(1);
  const rest = (omitted: number): string =>
    say(input, "command.rules.more", { count: omitted });
  for (let kept = rules.length - 1; kept >= 0; kept -= 1) {
    const omitted = rules.length - kept;
    const body =
      kept === 0
        ? rest(omitted)
        : `${rules.slice(0, kept).join("\n")}\n${rest(omitted)}`;
    const text = `${header}\n${body}`;
    if (text.length <= EXPORT_REPLY_LIMIT) {
      return text;
    }
  }
  return `${header}\n${rest(rules.length)}`;
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
      ? { tenantId: input.event.tenantId, limit: LOG_LIMIT + 1 }
      : { tenantId: input.event.tenantId, chatId, limit: LOG_LIMIT + 1 },
  );
  if (records.length === 0) {
    return say(input, "command.logs.empty");
  }
  const page = records.length > LOG_LIMIT ? records.slice(-LOG_LIMIT) : records;
  const footer =
    records.length > LOG_LIMIT ? say(input, "command.logs.more") : "";
  return fitLogPage(input, page, footer);
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
    const total = await input.storage.countAudits(scope);
    if (total === 0) {
      return auditExportDocument(scope, []);
    }
    if (minimumAuditExportLength(scope, total) > EXPORT_REPLY_LIMIT) {
      const page = await input.storage.listAudits({
        tenantId: scope.tenantId,
        ...(scope.chatId === undefined ? {} : { chatId: scope.chatId }),
        limit: Math.min(total, 100),
      });
      const fitted = fitAuditExportDocument(
        scope,
        page,
        total,
        EXPORT_REPLY_LIMIT,
      );
      if (fitted === null) {
        return say(input, "command.export.too_long", { count: total });
      }
      return fitted;
    }
    const records = await input.storage.exportAudits(scope);
    const json = fitAuditExportDocument(
      scope,
      records,
      records.length,
      EXPORT_REPLY_LIMIT,
    );
    if (json === null) {
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
    const json = fitFeedbackEvalDocument(scope, samples, EXPORT_REPLY_LIMIT);
    if (json === null) {
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

async function approveRequest(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length !== 2) {
    return say(input, "command.approve.usage");
  }
  const chatId = args[0];
  const actorId = args[1];
  if (
    chatId === undefined ||
    actorId === undefined ||
    !isTargetId(chatId) ||
    !isTargetId(actorId)
  ) {
    return say(input, "command.invalid");
  }
  const refused = refuseChat(input, chatId);
  if (refused) {
    return refused;
  }
  const approve = input.moderator?.approveJoin;
  if (!approve) {
    rejectApprove(input);
    return say(input, "command.invalid");
  }
  try {
    await approve({
      tenantId: input.event.tenantId,
      chatId,
      actorId,
    });
  } catch {
    rejectApprove(input);
    return say(input, "command.invalid");
  }
  return say(input, "command.approve.done", { chatId, actorId });
}

function rejectApprove(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "approve",
  });
}

async function declineRequest(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length !== 2) {
    return say(input, "command.decline.usage");
  }
  const chatId = args[0];
  const actorId = args[1];
  if (
    chatId === undefined ||
    actorId === undefined ||
    !isTargetId(chatId) ||
    !isTargetId(actorId)
  ) {
    return say(input, "command.invalid");
  }
  const refused = refuseChat(input, chatId);
  if (refused) {
    return refused;
  }
  const decline = input.moderator?.declineJoin;
  if (!decline) {
    rejectDecline(input);
    return say(input, "command.invalid");
  }
  try {
    await decline({
      tenantId: input.event.tenantId,
      chatId,
      actorId,
    });
  } catch {
    rejectDecline(input);
    return say(input, "command.invalid");
  }
  return say(input, "command.decline.done", { chatId, actorId });
}

function rejectDecline(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "decline",
  });
}

async function deleteOne(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length !== 2) {
    return say(input, "command.delete.usage");
  }
  const chatId = args[0];
  const messageId = args[1];
  if (
    chatId === undefined ||
    messageId === undefined ||
    !isTargetId(chatId) ||
    !isMessageId(messageId)
  ) {
    return say(input, "command.invalid");
  }
  const refused = refuseChat(input, chatId);
  if (refused) {
    return refused;
  }
  const remove = input.moderator?.deleteMessage;
  if (!remove) {
    rejectDelete(input);
    return say(input, "command.invalid");
  }
  try {
    await remove({
      tenantId: input.event.tenantId,
      chatId,
      messageId,
    });
  } catch {
    rejectDelete(input);
    return say(input, "command.invalid");
  }
  return say(input, "command.delete.done", { chatId, messageId });
}

function isMessageId(value: string): boolean {
  if (!/^[1-9]\d{0,15}$/.test(value)) {
    return false;
  }
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0;
}

function rejectDelete(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "delete",
  });
}

async function deleteMany(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length < 2) {
    return say(input, "command.deletes.usage");
  }
  const chatId = args[0];
  const messageIds = args.slice(1);
  if (
    chatId === undefined ||
    !isTargetId(chatId) ||
    !isMessageIdList(messageIds)
  ) {
    return say(input, "command.invalid");
  }
  const refused = refuseChat(input, chatId);
  if (refused) {
    return refused;
  }
  const remove = input.moderator?.deleteMessages;
  if (!remove) {
    rejectDeletes(input);
    return say(input, "command.invalid");
  }
  try {
    await remove({
      tenantId: input.event.tenantId,
      chatId,
      messageIds,
    });
  } catch {
    rejectDeletes(input);
    return say(input, "command.invalid");
  }
  return say(input, "command.deletes.done", {
    chatId,
    count: messageIds.length,
  });
}

function isMessageIdList(values: readonly string[]): boolean {
  if (values.length < 1 || values.length > MAX_DELETE_MESSAGES) {
    return false;
  }
  const seen = new Set<string>();
  for (const value of values) {
    if (!isMessageId(value) || seen.has(value)) {
      return false;
    }
    seen.add(value);
  }
  return true;
}

function rejectDeletes(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "deletes",
  });
}

async function showMember(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length !== 2) {
    return say(input, "command.member.usage");
  }
  const chatId = args[0];
  const actorId = args[1];
  if (
    chatId === undefined ||
    actorId === undefined ||
    !isTargetId(chatId) ||
    !isTargetId(actorId)
  ) {
    return say(input, "command.invalid");
  }
  const refused = refuseChat(input, chatId);
  if (refused) {
    return refused;
  }
  const read = input.moderator?.readMember;
  if (!read) {
    rejectMember(input);
    return say(input, "command.invalid");
  }
  try {
    const standing = await read({
      tenantId: input.event.tenantId,
      chatId,
      actorId,
    });
    return describeMember(input, standing, chatId, actorId);
  } catch {
    rejectMember(input);
    return say(input, "command.invalid");
  }
}

function describeMember(
  input: OperatorCommandInput,
  standing: MemberStanding,
  chatId: string,
  actorId: string,
): string {
  const names = { chatId, actorId };
  switch (standing.status) {
    case "creator":
      return say(input, "command.member.creator", names);
    case "administrator":
      return say(input, "command.member.administrator", names);
    case "member":
      return say(input, "command.member.member", names);
    case "left":
      return say(input, "command.member.left", names);
    case "kicked":
      return standing.untilDate === null
        ? say(input, "command.member.kicked", names)
        : say(input, "command.member.kicked.until", {
            ...names,
            until: standing.untilDate,
          });
    case "restricted":
      if (!standing.inChat) {
        return standing.untilDate === null
          ? say(input, "command.member.restricted.away", names)
          : say(input, "command.member.restricted.away.until", {
              ...names,
              until: standing.untilDate,
            });
      }
      return standing.untilDate === null
        ? say(input, "command.member.restricted", names)
        : say(input, "command.member.restricted.until", {
            ...names,
            until: standing.untilDate,
          });
  }
}

function rejectMember(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "member",
  });
}

const permissionLines = [
  ["command.perms.send_messages", "sendMessages"],
  ["command.perms.send_audios", "sendAudios"],
  ["command.perms.send_documents", "sendDocuments"],
  ["command.perms.send_photos", "sendPhotos"],
  ["command.perms.send_videos", "sendVideos"],
  ["command.perms.send_video_notes", "sendVideoNotes"],
  ["command.perms.send_voice_notes", "sendVoiceNotes"],
  ["command.perms.send_polls", "sendPolls"],
  ["command.perms.send_other_messages", "sendOtherMessages"],
  ["command.perms.add_web_page_previews", "addWebPagePreviews"],
  ["command.perms.react_to_messages", "reactToMessages"],
  ["command.perms.edit_tag", "editTag"],
  ["command.perms.change_info", "changeInfo"],
  ["command.perms.invite_users", "inviteUsers"],
  ["command.perms.pin_messages", "pinMessages"],
  ["command.perms.manage_topics", "manageTopics"],
] as const satisfies ReadonlyArray<
  readonly [string, keyof DefaultChatPermissions]
>;

async function showPermissions(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length !== 1) {
    return say(input, "command.perms.usage");
  }
  const chatId = args[0];
  if (chatId === undefined || !isTargetId(chatId)) {
    return say(input, "command.invalid");
  }
  const refused = refuseChat(input, chatId);
  if (refused) {
    return refused;
  }
  const read = input.moderator?.readPermissions;
  if (!read) {
    rejectPermissions(input);
    return say(input, "command.invalid");
  }
  try {
    const permissions = await read({
      tenantId: input.event.tenantId,
      chatId,
    });
    return describePermissions(input, chatId, permissions);
  } catch {
    rejectPermissions(input);
    return say(input, "command.invalid");
  }
}

function describePermissions(
  input: OperatorCommandInput,
  chatId: string,
  permissions: DefaultChatPermissions,
): string {
  const lines = [say(input, "command.perms.header", { chatId })];
  for (const [label, field] of permissionLines) {
    lines.push(
      `${say(input, label)} ${say(input, permissionStateKey(permissions[field]))}`,
    );
  }
  return lines.join("\n");
}

function permissionStateKey(state: PermissionState): string {
  if (state === "on") {
    return "command.switch.on";
  }
  if (state === "off") {
    return "command.switch.off";
  }
  return "command.perms.unknown";
}

const administratorLabels = {
  manageChat: "command.admins.manage_chat",
  deleteMessages: "command.admins.delete_messages",
  manageVideoChats: "command.admins.manage_video_chats",
  restrictMembers: "command.admins.restrict_members",
  promoteMembers: "command.admins.promote_members",
  changeInfo: "command.admins.change_info",
  inviteUsers: "command.admins.invite_users",
  postStories: "command.admins.post_stories",
  editStories: "command.admins.edit_stories",
  deleteStories: "command.admins.delete_stories",
  postMessages: "command.admins.post_messages",
  editMessages: "command.admins.edit_messages",
  pinMessages: "command.admins.pin_messages",
  manageTopics: "command.admins.manage_topics",
  manageDirectMessages: "command.admins.manage_direct_messages",
  manageTags: "command.admins.manage_tags",
  sendWelcomeMessages: "command.admins.send_welcome_messages",
} as const satisfies Record<AdministratorRight, MessageKey>;

async function showAdministrators(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length !== 1) {
    return say(input, "command.admins.usage");
  }
  const chatId = args[0];
  if (chatId === undefined || !isTargetId(chatId)) {
    return say(input, "command.invalid");
  }
  const refused = refuseChat(input, chatId);
  if (refused) {
    return refused;
  }
  const read = input.moderator?.readAdministrators;
  if (!read) {
    rejectAdministrators(input);
    return say(input, "command.invalid");
  }
  try {
    const admins = await read({
      tenantId: input.event.tenantId,
      chatId,
    });
    return describeAdministrators(input, chatId, admins);
  } catch {
    rejectAdministrators(input);
    return say(input, "command.invalid");
  }
}

function describeAdministrators(
  input: OperatorCommandInput,
  chatId: string,
  admins: readonly ChatAdministrator[],
): string {
  const header = say(input, "command.admins.header", { chatId });
  if (admins.length === 0) {
    return `${header}\n${say(input, "command.admins.empty")}`;
  }
  return fitAdministratorLines(
    header,
    admins.map((admin) => administratorLine(input, admin)),
    (count) => say(input, "command.admins.more", { count }),
  );
}

function administratorLine(
  input: OperatorCommandInput,
  admin: ChatAdministrator,
): string {
  const parts = [admin.actorId];
  if (admin.bot) {
    parts.push(say(input, "command.admins.bot"));
  }
  parts.push(
    say(
      input,
      admin.role === "creator"
        ? "command.admins.creator"
        : "command.admins.administrator",
    ),
  );
  if (admin.anonymous) {
    parts.push(say(input, "command.admins.anonymous"));
  }
  for (const right of administratorRights) {
    if (admin.rights.includes(right)) {
      parts.push(say(input, administratorLabels[right]));
    }
  }
  return parts.join(" ");
}

function fitAdministratorLines(
  header: string,
  lines: readonly string[],
  more: (count: number) => string,
): string {
  const full = [header, ...lines].join("\n");
  if (full.length <= EXPORT_REPLY_LIMIT) {
    return full;
  }
  for (let kept = lines.length - 1; kept >= 0; kept -= 1) {
    const tail = more(lines.length - kept);
    const body =
      kept === 0 ? tail : `${lines.slice(0, kept).join("\n")}\n${tail}`;
    const text = `${header}\n${body}`;
    if (text.length <= EXPORT_REPLY_LIMIT) {
      return text;
    }
  }
  return `${header}\n${more(lines.length)}`;
}

function rejectAdministrators(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "admins",
  });
}

function rejectPermissions(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "perms",
  });
}

async function clearActorReactions(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length !== 2) {
    return say(input, "command.clearreact.usage");
  }
  const chatId = args[0];
  const actorId = args[1];
  if (chatId === undefined || actorId === undefined || !isTargetId(chatId)) {
    return say(input, "command.invalid");
  }
  const kind = reactionKind(actorId);
  if (kind === undefined) {
    return say(input, "command.invalid");
  }
  const refused = refuseChat(input, chatId);
  if (refused) {
    return refused;
  }
  const clear = input.moderator?.clearReactions;
  if (!clear) {
    rejectReactions(input);
    return say(input, "command.invalid");
  }
  try {
    await clear({
      tenantId: input.event.tenantId,
      chatId,
      actorId,
      kind,
    });
  } catch {
    rejectReactions(input);
    return say(input, "command.invalid");
  }
  return say(input, "command.clearreact.done", { chatId, actorId });
}

function reactionKind(actorId: string): "user" | "chat" | undefined {
  if (!isTargetId(actorId)) {
    return undefined;
  }
  return actorId.startsWith("-") ? "chat" : "user";
}

function rejectReactions(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "clearreact",
  });
}

async function revokeChatInvite(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length !== 2) {
    return say(input, "command.revoke.usage");
  }
  const chatId = args[0];
  const rawLink = args[1];
  const inviteLink =
    chatId !== undefined && rawLink !== undefined
      ? canonicalInvite(rawLink)
      : undefined;
  if (chatId === undefined || !isTargetId(chatId) || inviteLink === undefined) {
    return say(input, "command.invalid");
  }
  const refused = refuseChat(input, chatId);
  if (refused) {
    return refused;
  }
  const revoke = input.moderator?.revokeInvite;
  if (!revoke) {
    rejectInvite(input);
    return say(input, "command.invalid");
  }
  try {
    await revoke({
      tenantId: input.event.tenantId,
      chatId,
      inviteLink,
    });
  } catch {
    rejectInvite(input);
    return say(input, "command.invalid");
  }
  return say(input, "command.revoke.done", { chatId });
}

function canonicalInvite(raw: string): string | undefined {
  const match =
    /^(?:https?:\/\/)?(?:www\.)?(joinchat\.)?(t\.me|telegram\.me|telegram\.dog)\/(?:\+([A-Za-z0-9_-]{16,128})|joinchat\/([A-Za-z0-9_-]{16,128})|([A-Za-z0-9_-]{16,128}))$/i.exec(
      raw,
    );
  if (!match) {
    return undefined;
  }
  const prefixed = match[1] !== undefined;
  const host = match[2]?.toLowerCase();
  const plus = match[3];
  const joined = match[4];
  const bare = match[5];
  if (host === undefined) {
    return undefined;
  }
  if (plus !== undefined) {
    if (prefixed || /^\d+$/.test(plus)) {
      return undefined;
    }
    return `https://${host}/+${plus}`;
  }
  const code = joined ?? bare;
  if (
    code === undefined ||
    /^\d+$/.test(code) ||
    (bare !== undefined && !prefixed) ||
    (joined !== undefined && prefixed)
  ) {
    return undefined;
  }
  return `https://${host}/joinchat/${code}`;
}

function rejectInvite(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "revoke",
  });
}

async function unpinAll(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length !== 1) {
    return say(input, "command.unpin.usage");
  }
  const chatId = args[0];
  if (chatId === undefined || !isTargetId(chatId)) {
    return say(input, "command.invalid");
  }
  const refused = refuseChat(input, chatId);
  if (refused) {
    return refused;
  }
  const unpin = input.moderator?.unpinChat;
  if (!unpin) {
    rejectUnpin(input);
    return say(input, "command.invalid");
  }
  try {
    await unpin({
      tenantId: input.event.tenantId,
      chatId,
    });
  } catch {
    rejectUnpin(input);
    return say(input, "command.invalid");
  }
  return say(input, "command.unpin.done", { chatId });
}

function rejectUnpin(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "unpin",
  });
}

async function clearTopicPins(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length !== 1 && args.length !== 2) {
    return say(input, "command.untopic.usage");
  }
  const chatId = args[0];
  const threadId = args[1];
  if (
    chatId === undefined ||
    !isTargetId(chatId) ||
    (threadId !== undefined && !isMessageId(threadId))
  ) {
    return say(input, "command.invalid");
  }
  const refused = refuseChat(input, chatId);
  if (refused) {
    return refused;
  }
  const unpin = input.moderator?.unpinTopic;
  if (!unpin) {
    rejectTopic(input);
    return say(input, "command.invalid");
  }
  try {
    await unpin({
      tenantId: input.event.tenantId,
      chatId,
      ...(threadId === undefined ? {} : { threadId }),
    });
  } catch {
    rejectTopic(input);
    return say(input, "command.invalid");
  }
  return say(
    input,
    threadId === undefined
      ? "command.untopic.done"
      : "command.untopic.done.thread",
    { chatId, threadId: threadId ?? "" },
  );
}

function rejectTopic(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "untopic",
  });
}

async function closeForum(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length !== 1 && args.length !== 2) {
    return say(input, "command.closetopic.usage");
  }
  const chatId = args[0];
  const threadId = args[1];
  if (
    chatId === undefined ||
    !isTargetId(chatId) ||
    (threadId !== undefined && !isMessageId(threadId))
  ) {
    return say(input, "command.invalid");
  }
  const refused = refuseChat(input, chatId);
  if (refused) {
    return refused;
  }
  const close = input.moderator?.closeTopic;
  if (!close) {
    rejectClose(input);
    return say(input, "command.invalid");
  }
  try {
    await close({
      tenantId: input.event.tenantId,
      chatId,
      ...(threadId === undefined ? {} : { threadId }),
    });
  } catch {
    rejectClose(input);
    return say(input, "command.invalid");
  }
  return say(
    input,
    threadId === undefined
      ? "command.closetopic.done"
      : "command.closetopic.done.thread",
    { chatId, threadId: threadId ?? "" },
  );
}

function rejectClose(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "closetopic",
  });
}

async function openForum(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length !== 1 && args.length !== 2) {
    return say(input, "command.opentopic.usage");
  }
  const chatId = args[0];
  const threadId = args[1];
  if (
    chatId === undefined ||
    !isTargetId(chatId) ||
    (threadId !== undefined && !isMessageId(threadId))
  ) {
    return say(input, "command.invalid");
  }
  const refused = refuseChat(input, chatId);
  if (refused) {
    return refused;
  }
  const open = input.moderator?.openTopic;
  if (!open) {
    rejectOpen(input);
    return say(input, "command.invalid");
  }
  try {
    await open({
      tenantId: input.event.tenantId,
      chatId,
      ...(threadId === undefined ? {} : { threadId }),
    });
  } catch {
    rejectOpen(input);
    return say(input, "command.invalid");
  }
  return say(
    input,
    threadId === undefined
      ? "command.opentopic.done"
      : "command.opentopic.done.thread",
    { chatId, threadId: threadId ?? "" },
  );
}

function rejectOpen(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "opentopic",
  });
}

async function hideGeneralTopic(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length !== 1) {
    return say(input, "command.hidegeneral.usage");
  }
  const chatId = args[0];
  if (chatId === undefined || !isTargetId(chatId)) {
    return say(input, "command.invalid");
  }
  const refused = refuseChat(input, chatId);
  if (refused) {
    return refused;
  }
  const hide = input.moderator?.hideGeneral;
  if (!hide) {
    rejectHide(input);
    return say(input, "command.invalid");
  }
  try {
    await hide({
      tenantId: input.event.tenantId,
      chatId,
    });
  } catch {
    rejectHide(input);
    return say(input, "command.invalid");
  }
  return say(input, "command.hidegeneral.done", { chatId });
}

function rejectHide(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "hidegeneral",
  });
}

async function showGeneralTopic(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length !== 1) {
    return say(input, "command.showgeneral.usage");
  }
  const chatId = args[0];
  if (chatId === undefined || !isTargetId(chatId)) {
    return say(input, "command.invalid");
  }
  const refused = refuseChat(input, chatId);
  if (refused) {
    return refused;
  }
  const show = input.moderator?.showGeneral;
  if (!show) {
    rejectShow(input);
    return say(input, "command.invalid");
  }
  try {
    await show({
      tenantId: input.event.tenantId,
      chatId,
    });
  } catch {
    rejectShow(input);
    return say(input, "command.invalid");
  }
  return say(input, "command.showgeneral.done", { chatId });
}

function rejectShow(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "showgeneral",
  });
}

async function deleteOneTopic(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length !== 2) {
    return say(input, "command.deltopic.usage");
  }
  const chatId = args[0];
  const threadId = args[1];
  if (
    chatId === undefined ||
    threadId === undefined ||
    !isTargetId(chatId) ||
    !isMessageId(threadId)
  ) {
    return say(input, "command.invalid");
  }
  const refused = refuseChat(input, chatId);
  if (refused) {
    return refused;
  }
  const remove = input.moderator?.deleteTopic;
  if (!remove) {
    rejectDeleteTopic(input);
    return say(input, "command.invalid");
  }
  try {
    await remove({
      tenantId: input.event.tenantId,
      chatId,
      threadId,
    });
  } catch {
    rejectDeleteTopic(input);
    return say(input, "command.invalid");
  }
  return say(input, "command.deltopic.done", { chatId, threadId });
}

function rejectDeleteTopic(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "deltopic",
  });
}

async function showMemberCount(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length !== 1) {
    return say(input, "command.count.usage");
  }
  const chatId = args[0];
  if (chatId === undefined || !isTargetId(chatId)) {
    return say(input, "command.invalid");
  }
  const refused = refuseChat(input, chatId);
  if (refused) {
    return refused;
  }
  const read = input.moderator?.readMemberCount;
  if (!read) {
    rejectCount(input);
    return say(input, "command.invalid");
  }
  try {
    const count = await read({
      tenantId: input.event.tenantId,
      chatId,
    });
    return say(input, "command.count.done", { chatId, count: String(count) });
  } catch {
    rejectCount(input);
    return say(input, "command.invalid");
  }
}

function rejectCount(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "count",
  });
}

async function pinOneMessage(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length !== 2) {
    return say(input, "command.pin.usage");
  }
  const chatId = args[0];
  const messageId = args[1];
  if (
    chatId === undefined ||
    messageId === undefined ||
    !isTargetId(chatId) ||
    !isMessageId(messageId)
  ) {
    return say(input, "command.invalid");
  }
  const refused = refuseChat(input, chatId);
  if (refused) {
    return refused;
  }
  const pin = input.moderator?.pinMessage;
  if (!pin) {
    rejectPin(input);
    return say(input, "command.invalid");
  }
  try {
    await pin({
      tenantId: input.event.tenantId,
      chatId,
      messageId,
    });
  } catch {
    rejectPin(input);
    return say(input, "command.invalid");
  }
  return say(input, "command.pin.done", { chatId, messageId });
}

function rejectPin(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "pin",
  });
}

async function unpinOneMessage(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length !== 2) {
    return say(input, "command.unpinmsg.usage");
  }
  const chatId = args[0];
  const messageId = args[1];
  if (
    chatId === undefined ||
    messageId === undefined ||
    !isTargetId(chatId) ||
    !isMessageId(messageId)
  ) {
    return say(input, "command.invalid");
  }
  const refused = refuseChat(input, chatId);
  if (refused) {
    return refused;
  }
  const unpin = input.moderator?.unpinMessage;
  if (!unpin) {
    rejectUnpinMessage(input);
    return say(input, "command.invalid");
  }
  try {
    await unpin({
      tenantId: input.event.tenantId,
      chatId,
      messageId,
    });
  } catch {
    rejectUnpinMessage(input);
    return say(input, "command.invalid");
  }
  return say(input, "command.unpinmsg.done", { chatId, messageId });
}

function rejectUnpinMessage(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "unpinmsg",
  });
}

async function removeOneReaction(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length !== 3) {
    return say(input, "command.unreact.usage");
  }
  const chatId = args[0];
  const messageId = args[1];
  const actorId = args[2];
  if (
    chatId === undefined ||
    messageId === undefined ||
    actorId === undefined ||
    !isTargetId(chatId) ||
    !isMessageId(messageId)
  ) {
    return say(input, "command.invalid");
  }
  const kind = reactionKind(actorId);
  if (kind === undefined) {
    return say(input, "command.invalid");
  }
  const refused = refuseChat(input, chatId);
  if (refused) {
    return refused;
  }
  const remove = input.moderator?.removeReaction;
  if (!remove) {
    rejectUnreact(input);
    return say(input, "command.invalid");
  }
  try {
    await remove({
      tenantId: input.event.tenantId,
      chatId,
      messageId,
      actorId,
      kind,
    });
  } catch {
    rejectUnreact(input);
    return say(input, "command.invalid");
  }
  return say(input, "command.unreact.done", { chatId, messageId, actorId });
}

function rejectUnreact(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "unreact",
  });
}

async function deleteChatPhoto(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length !== 1) {
    return say(input, "command.delphoto.usage");
  }
  const chatId = args[0];
  if (chatId === undefined || !isTargetId(chatId)) {
    return say(input, "command.invalid");
  }
  const refused = refuseChat(input, chatId);
  if (refused) {
    return refused;
  }
  const remove = input.moderator?.deletePhoto;
  if (!remove) {
    rejectPhoto(input);
    return say(input, "command.invalid");
  }
  try {
    await remove({
      tenantId: input.event.tenantId,
      chatId,
    });
  } catch {
    rejectPhoto(input);
    return say(input, "command.invalid");
  }
  return say(input, "command.delphoto.done", { chatId });
}

function rejectPhoto(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "delphoto",
  });
}

async function leaveOneChat(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length !== 1) {
    return say(input, "command.leave.usage");
  }
  const chatId = args[0];
  if (chatId === undefined || !isTargetId(chatId)) {
    return say(input, "command.invalid");
  }
  const refused = refuseChat(input, chatId);
  if (refused) {
    return refused;
  }
  const leave = input.moderator?.leaveChat;
  if (!leave) {
    rejectLeave(input);
    return say(input, "command.invalid");
  }
  try {
    await leave({
      tenantId: input.event.tenantId,
      chatId,
    });
  } catch {
    rejectLeave(input);
    return say(input, "command.invalid");
  }
  return say(input, "command.leave.done", { chatId });
}

function rejectLeave(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "leave",
  });
}

async function setOneMemberTag(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length < 2) {
    return say(input, "command.tag.usage");
  }
  const chatId = args[0];
  const actorId = args[1];
  const tag = args.slice(2).join(" ");
  if (
    chatId === undefined ||
    actorId === undefined ||
    !isTargetId(chatId) ||
    !isTargetId(actorId) ||
    tag.length > MEMBER_TAG_LIMIT
  ) {
    return say(input, "command.invalid");
  }
  const refused = refuseChat(input, chatId);
  if (refused) {
    return refused;
  }
  const set = input.moderator?.setMemberTag;
  if (!set) {
    rejectTag(input);
    return say(input, "command.invalid");
  }
  try {
    await set({
      tenantId: input.event.tenantId,
      chatId,
      actorId,
      tag,
    });
  } catch {
    rejectTag(input);
    return say(input, "command.invalid");
  }
  return say(
    input,
    tag.length === 0 ? "command.tag.cleared" : "command.tag.done",
    { chatId, actorId },
  );
}

function rejectTag(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "tag",
  });
}

async function deleteGroupStickerSet(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length !== 1) {
    return say(input, "command.delstickers.usage");
  }
  const chatId = args[0];
  if (chatId === undefined || !isTargetId(chatId)) {
    return say(input, "command.invalid");
  }
  const refused = refuseChat(input, chatId);
  if (refused) {
    return refused;
  }
  const remove = input.moderator?.deleteStickerSet;
  if (!remove) {
    rejectStickers(input);
    return say(input, "command.invalid");
  }
  try {
    await remove({
      tenantId: input.event.tenantId,
      chatId,
    });
  } catch {
    rejectStickers(input);
    return say(input, "command.invalid");
  }
  return say(input, "command.delstickers.done", { chatId });
}

function rejectStickers(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "delstickers",
  });
}

async function muteMember(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length !== 2 && args.length !== 3) {
    return say(input, "command.mute.usage");
  }
  const chatId = args[0];
  const actorId = args[1];
  const seconds = muteSeconds(args[2]);
  if (
    chatId === undefined ||
    actorId === undefined ||
    seconds === undefined ||
    !isTargetId(chatId) ||
    !isTargetId(actorId)
  ) {
    return say(input, "command.invalid");
  }
  const refused = refuseChat(input, chatId);
  if (refused) {
    return refused;
  }
  const mute = input.moderator?.muteActor;
  if (!mute) {
    rejectMute(input);
    return say(input, "command.invalid");
  }
  try {
    await mute({
      tenantId: input.event.tenantId,
      chatId,
      actorId,
      durationSeconds: seconds,
    });
  } catch {
    rejectMute(input);
    return say(input, "command.invalid");
  }
  return say(input, "command.mute.done", { chatId, actorId, seconds });
}

function muteSeconds(value: string | undefined): number | undefined {
  if (value === undefined) {
    return DEFAULT_MUTE_SECONDS;
  }
  if (!/^[1-9]\d{0,7}$/.test(value)) {
    return undefined;
  }
  const seconds = Number(value);
  if (seconds < MIN_MUTE_SECONDS || seconds > MAX_MUTE_SECONDS) {
    return undefined;
  }
  return seconds;
}

function rejectMute(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "mute",
  });
}

async function banSender(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length !== 2) {
    return say(input, "command.bansender.usage");
  }
  const chatId = args[0];
  const senderChatId = args[1];
  if (
    chatId === undefined ||
    senderChatId === undefined ||
    !isTargetId(chatId) ||
    !isTargetId(senderChatId)
  ) {
    return say(input, "command.invalid");
  }
  const refused = refuseChat(input, chatId);
  if (refused) {
    return refused;
  }
  const ban = input.moderator?.banSenderChat;
  if (!ban) {
    rejectSender(input);
    return say(input, "command.invalid");
  }
  try {
    await ban({
      tenantId: input.event.tenantId,
      chatId,
      senderChatId,
    });
  } catch {
    rejectSender(input);
    return say(input, "command.invalid");
  }
  return say(input, "command.bansender.done", { chatId, senderChatId });
}

function rejectSender(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "bansender",
  });
}

async function closeChat(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length !== 1) {
    return say(input, "command.lock.usage");
  }
  const chatId = args[0];
  if (chatId === undefined || !isTargetId(chatId)) {
    return say(input, "command.invalid");
  }
  const refused = refuseChat(input, chatId);
  if (refused) {
    return refused;
  }
  const lock = input.moderator?.lockChat;
  if (!lock) {
    rejectLock(input);
    return say(input, "command.invalid");
  }
  try {
    await lock({
      tenantId: input.event.tenantId,
      chatId,
    });
  } catch {
    rejectLock(input);
    return say(input, "command.invalid");
  }
  return say(input, "command.lock.done", { chatId });
}

function rejectLock(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "lock",
  });
}

async function openChat(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length !== 1) {
    return say(input, "command.unlock.usage");
  }
  const chatId = args[0];
  if (chatId === undefined || !isTargetId(chatId)) {
    return say(input, "command.invalid");
  }
  const refused = refuseChat(input, chatId);
  if (refused) {
    return refused;
  }
  const unlock = input.moderator?.unlockChat;
  if (!unlock) {
    rejectUnlock(input);
    return say(input, "command.invalid");
  }
  try {
    await unlock({
      tenantId: input.event.tenantId,
      chatId,
    });
  } catch {
    rejectUnlock(input);
    return say(input, "command.invalid");
  }
  return say(input, "command.unlock.done", { chatId });
}

function rejectUnlock(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "unlock",
  });
}

async function unbanSender(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length !== 2) {
    return say(input, "command.unbansender.usage");
  }
  const chatId = args[0];
  const senderChatId = args[1];
  if (
    chatId === undefined ||
    senderChatId === undefined ||
    !isTargetId(chatId) ||
    !isTargetId(senderChatId)
  ) {
    return say(input, "command.invalid");
  }
  const refused = refuseChat(input, chatId);
  if (refused) {
    return refused;
  }
  const lift = input.moderator?.unbanSenderChat;
  if (!lift) {
    rejectSenderLift(input);
    return say(input, "command.invalid");
  }
  try {
    await lift({
      tenantId: input.event.tenantId,
      chatId,
      senderChatId,
    });
  } catch {
    rejectSenderLift(input);
    return say(input, "command.invalid");
  }
  return say(input, "command.unbansender.done", { chatId, senderChatId });
}

function rejectSenderLift(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "unbansender",
  });
}

async function banMember(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length !== 2) {
    return say(input, "command.ban.usage");
  }
  const chatId = args[0];
  const actorId = args[1];
  if (
    chatId === undefined ||
    actorId === undefined ||
    !isTargetId(chatId) ||
    !isTargetId(actorId)
  ) {
    return say(input, "command.invalid");
  }
  const refused = refuseChat(input, chatId);
  if (refused) {
    return refused;
  }
  const ban = input.moderator?.banActor;
  if (!ban) {
    rejectBan(input);
    return say(input, "command.invalid");
  }
  try {
    await ban({
      tenantId: input.event.tenantId,
      chatId,
      actorId,
    });
  } catch {
    rejectBan(input);
    return say(input, "command.invalid");
  }
  return say(input, "command.ban.done", { chatId, actorId });
}

function rejectBan(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "ban",
  });
}

async function unbanMember(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length !== 2) {
    return say(input, "command.unban.usage");
  }
  const chatId = args[0];
  const actorId = args[1];
  if (
    chatId === undefined ||
    actorId === undefined ||
    !isTargetId(chatId) ||
    !isTargetId(actorId)
  ) {
    return say(input, "command.invalid");
  }
  const refused = refuseChat(input, chatId);
  if (refused) {
    return refused;
  }
  const unban = input.moderator?.unbanActor;
  if (!unban) {
    rejectUnban(input);
    return say(input, "command.invalid");
  }
  try {
    await unban({
      tenantId: input.event.tenantId,
      chatId,
      actorId,
    });
  } catch {
    rejectUnban(input);
    return say(input, "command.invalid");
  }
  return say(input, "command.unban.done", { chatId, actorId });
}

async function unmuteMember(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length !== 2) {
    return say(input, "command.unmute.usage");
  }
  const chatId = args[0];
  const actorId = args[1];
  if (
    chatId === undefined ||
    actorId === undefined ||
    !isTargetId(chatId) ||
    !isTargetId(actorId)
  ) {
    return say(input, "command.invalid");
  }
  const refused = refuseChat(input, chatId);
  if (refused) {
    return refused;
  }
  const unmute = input.moderator?.unmuteActor;
  if (!unmute) {
    rejectUnmute(input);
    return say(input, "command.invalid");
  }
  try {
    const result = await unmute({
      tenantId: input.event.tenantId,
      chatId,
      actorId,
    });
    if (result === "absent") {
      return say(input, "command.unmute.absent", { chatId, actorId });
    }
    return say(input, "command.unmute.done", { chatId, actorId });
  } catch {
    rejectUnmute(input);
    return say(input, "command.invalid");
  }
}

function rejectUnmute(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "unmute",
  });
}

function rejectUnban(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "unban",
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
    const removed = await input.storage.deleteAudits(scope);
    const left = await input.storage.countAudits(scope);
    if (left > 0) {
      return say(input, "command.forget.remaining", { count: removed, left });
    }
    return say(input, "command.forget.deleted", { count: removed });
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
  const full = policyBody(input, chatId, policy, policy.allowActorIds);
  if (policy.allowActorIds.length === 0 || full.length <= EXPORT_REPLY_LIMIT) {
    return full;
  }
  let best = policyBody(input, chatId, policy, [], policy.allowActorIds.length);
  let low = 0;
  let high = policy.allowActorIds.length - 1;
  while (low <= high) {
    const count = Math.floor((low + high) / 2);
    const text = policyBody(
      input,
      chatId,
      policy,
      policy.allowActorIds.slice(0, count),
      policy.allowActorIds.length - count,
    );
    if (text.length <= EXPORT_REPLY_LIMIT) {
      best = text;
      low = count + 1;
    } else {
      high = count - 1;
    }
  }
  return best;
}

function policyBody(
  input: OperatorCommandInput,
  chatId: string,
  policy: PrefilterPolicy,
  ids: readonly string[],
  omitted?: number,
): string {
  const listed = ids.length === 0 ? "" : ids.join(",");
  const more =
    omitted === undefined || omitted <= 0
      ? ""
      : say(input, "command.whitelist.more", { count: omitted });
  let allow = say(input, "command.allow.empty");
  if (listed.length > 0 && more.length > 0) {
    allow = `${listed}\n${more}`;
  } else if (listed.length > 0) {
    allow = listed;
  } else if (more.length > 0) {
    allow = more;
  }
  return say(input, "command.whitelist.body", {
    chatId,
    exemptAdmins: String(policy.exemptAdmins),
    allow,
  });
}

interface LogLineFit {
  readonly record: AuditRecord;
  rules: string[];
  reasons: string[];
  readonly ruleTotal: number;
  readonly reasonTotal: number;
  frozen: boolean;
}

function fitLogPage(
  input: OperatorCommandInput,
  records: readonly AuditRecord[],
  footer: string,
): string {
  const lines: LogLineFit[] = records.map((record) => ({
    record,
    rules: record.ruleIds.map((ruleId) => safeToken(input, ruleId)),
    reasons: record.reasons.map((reason) => safeToken(input, reason)),
    ruleTotal: record.ruleIds.length,
    reasonTotal: record.reasons.length,
    frozen: false,
  }));
  let text = renderLogPage(input, lines, footer);
  if (text.length <= EXPORT_REPLY_LIMIT) {
    return text;
  }
  while (text.length > EXPORT_REPLY_LIMIT) {
    let index = -1;
    let longest = -1;
    for (let cursor = 0; cursor < lines.length; cursor += 1) {
      const line = lines[cursor];
      if (!line || line.frozen) {
        continue;
      }
      if (line.rules.length === 0 && line.reasons.length === 0) {
        continue;
      }
      const size = variableLength(line);
      if (size >= longest) {
        longest = size;
        index = cursor;
      }
    }
    const line = index >= 0 ? lines[index] : undefined;
    if (!line) {
      return text;
    }
    const savedRules = [...line.rules];
    const savedReasons = [...line.reasons];
    let improved = false;
    while (line.rules.length > 0 || line.reasons.length > 0) {
      popLogToken(line);
      const next = renderLogPage(input, lines, footer);
      if (next.length < text.length) {
        text = next;
        improved = true;
        break;
      }
    }
    if (!improved) {
      line.rules = savedRules;
      line.reasons = savedReasons;
      line.frozen = true;
    }
  }
  return text;
}

function variableLength(line: LogLineFit): number {
  return line.rules.join(",").length + line.reasons.join(",").length;
}

function popLogToken(line: LogLineFit): void {
  if (line.reasons.length > 0) {
    line.reasons.pop();
    return;
  }
  line.rules.pop();
}

function renderLogPage(
  input: OperatorCommandInput,
  lines: readonly LogLineFit[],
  footer: string,
): string {
  const body = lines.map((line) => renderLogLine(input, line)).join("\n");
  return footer.length > 0 ? `${body}\n${footer}` : body;
}

function renderLogLine(input: OperatorCommandInput, line: LogLineFit): string {
  return say(input, "command.logs.line", {
    createdAt: line.record.createdAt,
    eventId: safeToken(input, line.record.eventId),
    action: line.record.action,
    score: line.record.score,
    rules: joinCounted(
      input,
      line.rules,
      line.ruleTotal - line.rules.length,
      "command.logs.rules_more",
    ),
    reasons: joinCounted(
      input,
      line.reasons,
      line.reasonTotal - line.reasons.length,
      "command.logs.reasons_more",
    ),
  });
}

function joinCounted(
  input: OperatorCommandInput,
  tokens: readonly string[],
  omitted: number,
  key: string,
): string {
  if (omitted <= 0) {
    return tokens.join(",");
  }
  const more = say(input, key, { count: omitted });
  if (tokens.length === 0) {
    return more;
  }
  return `${tokens.join(",")} ${more}`;
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
    const status = await blocklistStatus(input, store, chatId);
    return status ?? say(input, "command.invalid");
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
    const status = await blocklistStatus(input, store, chatId);
    return status ?? say(input, "command.invalid");
  }
  if ((op !== "add" && op !== "remove") || args.length !== 4) {
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
  if (op === "remove") {
    const removed = await removeBlocklist(input, () =>
      store.remove(input.event.tenantId, parsed.data),
    );
    if (removed === null) {
      return say(input, "command.invalid");
    }
    const status = await blocklistStatus(input, store, chatId);
    if (status === null) {
      return say(input, "command.invalid");
    }
    return say(
      input,
      removed ? "command.blocklist.removed" : "command.blocklist.absent",
      { status },
    );
  }
  const wrote = await writeBlocklist(input, () =>
    store.add(input.event.tenantId, parsed.data),
  );
  if (!wrote) {
    return say(input, "command.invalid");
  }
  const status = await blocklistStatus(input, store, chatId);
  if (status === null) {
    return say(input, "command.invalid");
  }
  return say(input, "command.blocklist.added", { status });
}

async function blocklistStatus(
  input: OperatorCommandInput,
  store: BlocklistStore,
  chatId: string,
): Promise<string | null> {
  try {
    const enabled = await store.isEnabled(input.event.tenantId, chatId);
    const count = await store.size(input.event.tenantId);
    return formatBlocklist(input, chatId, enabled, count);
  } catch {
    rejectBlocklist(input);
    return null;
  }
}

async function removeBlocklist(
  input: OperatorCommandInput,
  run: () => Promise<boolean>,
): Promise<boolean | null> {
  try {
    return await run();
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
  count: number,
): string {
  return say(input, "command.blocklist.status", {
    chatId,
    state: say(input, enabled ? "command.switch.on" : "command.switch.off"),
    count,
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
    const lines: string[] = [];
    for (const id of ids) {
      lines.push(await chatQuotaLine(input, id));
    }
    return fitChatLines(input, lines);
  } catch {
    input.logger.warn("operator_rejected", {
      eventId: input.event.id,
      chatId: input.event.chatId,
      command: "chats",
    });
    return say(input, "command.invalid");
  }
}

function fitChatLines(
  input: OperatorCommandInput,
  lines: readonly string[],
): string {
  const full = say(input, "command.chats.body", { chats: lines.join("\n") });
  if (full.length <= EXPORT_REPLY_LIMIT) {
    return full;
  }
  for (let kept = lines.length - 1; kept >= 0; kept -= 1) {
    const omitted = lines.length - kept;
    const more = say(input, "command.chats.more", { count: omitted });
    const body =
      kept === 0 ? more : `${lines.slice(0, kept).join("\n")}\n${more}`;
    const text = say(input, "command.chats.body", { chats: body });
    if (text.length <= EXPORT_REPLY_LIMIT) {
      return text;
    }
  }
  return say(input, "command.chats.body", {
    chats: say(input, "command.chats.more", { count: lines.length }),
  });
}

async function chatQuotaLine(
  input: OperatorCommandInput,
  chatId: string,
): Promise<string> {
  const reader = input.quota;
  if (!reader) {
    return chatId;
  }
  try {
    const parsed = quotaSnapshotSchema.safeParse(
      await reader.read(input.event.tenantId, chatId, input.event.occurredAt),
    );
    if (!parsed.success) {
      warnQuota(input, chatId);
      return chatId;
    }
    if (!parsed.data.enabled) {
      return chatId;
    }
    return say(input, "command.chats.line", {
      id: chatId,
      used: parsed.data.used,
      limit: parsed.data.limit,
    });
  } catch {
    warnQuota(input, chatId);
    return chatId;
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

async function quotaRuleMark(
  input: OperatorCommandInput,
  chatId: string,
  rules: RuleSet,
): Promise<{
  readonly paused: ReadonlySet<string>;
  readonly resetsAt?: string;
}> {
  const reader = input.quota;
  if (!reader) {
    return { paused: new Set() };
  }
  try {
    const parsed = quotaSnapshotSchema.safeParse(
      await reader.read(input.event.tenantId, chatId, input.event.occurredAt),
    );
    if (!parsed.success) {
      warnQuota(input, chatId);
      return { paused: new Set() };
    }
    const basic = parsed.data.basicDetectorIds;
    if (!parsed.data.enabled || !parsed.data.degraded || !basic) {
      return { paused: new Set() };
    }
    const paused = new Set(
      rules.rules
        .filter((rule) => !ruleSurvivesQuota(rule.detectorIds, basic))
        .map((rule) => rule.id),
    );
    if (parsed.data.resetsAt === undefined) {
      return { paused };
    }
    return { paused, resetsAt: parsed.data.resetsAt };
  } catch {
    warnQuota(input, chatId);
    return { paused: new Set() };
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
