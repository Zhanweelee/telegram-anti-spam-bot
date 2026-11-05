import {
  type BlocklistEntry,
  type BlocklistStore,
  blocklistEntrySchema,
} from "./blocklist.js";
import type { Cache } from "./cache.js";
import { beginChallenge, type CaptchaStore } from "./captcha.js";
import type { ChatDirectory } from "./chats.js";
import type { Clock } from "./clock.js";
import { punitiveActions } from "./decision.js";
import type { Event } from "./event.js";
import { fitFeedbackEvalDocument } from "./feedback-eval.js";
import type { Logger } from "./logger.js";
import type { Locale, MessageKey } from "./messages.js";
import { commandDescriptions, translate } from "./messages.js";
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
  type BotIdentity,
  type ChatAdministrator,
  type ChatCommunity,
  type ChatGuard,
  type ChatKind,
  type DefaultAdministratorRights,
  type DefaultChatPermissions,
  type DefaultRightsSnapshot,
  fitAuditExportDocument,
  type JoinBot,
  type MemberAdmin,
  type MemberAllows,
  type MemberStanding,
  type MenuButtonState,
  type MenuCommand,
  type MenuCommandSnapshot,
  type ModerationPort,
  minimumAuditExportLength,
  type OwnAdmin,
  type ParentChat,
  type PermissionState,
  type PersonalChat,
  type PrivatePrivacy,
  type ReactionAllowlist,
  type StickerSetRight,
  type Storage,
  type WebhookSnapshot,
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
import {
  CAPTCHA_TTL_SECONDS,
  FLOOD_THRESHOLD,
  FLOOD_WINDOW_SECONDS,
  type FloodPolicy,
  MAX_CAPTCHA_TTL_SECONDS,
  MAX_MUTE_DURATION_SECONDS,
  MIN_CAPTCHA_TTL_SECONDS,
  MIN_MUTE_DURATION_SECONDS,
  MUTE_DURATION_SECONDS,
  REPEAT_THRESHOLD,
  REPEAT_WINDOW_SECONDS,
  type RepeatPolicy,
  type RuleActionOverride,
  type RuleSwitch,
  type RuntimeStore,
} from "./runtime.js";
import { normalizeAllowHost, normalizeChatKeyword } from "./text.js";
import {
  normalizeWarnLimit,
  WARN_LIMIT,
  type WarnCount,
  type WarnStore,
} from "./warn.js";

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
  "boosts",
  "react",
  "title",
  "desc",
  "newtopic",
  "rentopic",
  "rengeneral",
  "stickers",
  "admintitle",
  "declinepost",
  "delephemeral",
  "myrights",
  "botrights",
  "setcommands",
  "commands",
  "delcommands",
  "menubutton",
  "button",
  "botname",
  "myname",
  "botdesc",
  "mydesc",
  "botshort",
  "myshort",
  "who",
  "hook",
  "guard",
  "joinbot",
  "reactions",
  "community",
  "canstickers",
  "parent",
  "personal",
  "privacy",
  "banfor",
  "allows",
  "canadmin",
  "kick",
  "cani",
  "captcha",
  "uncaptcha",
  "warn",
  "unwarn",
  "warns",
  "warnlimit",
  "report",
  "flood",
  "keyword",
  "repeat",
  "rulemute",
  "verifyfor",
  "verifyfail",
  "allowhost",
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
const TITLE_LIMIT = 128;
const BOT_NAME_LIMIT = 64;
const BOT_DESCRIPTION_LIMIT = 512;
const BOT_SHORT_DESCRIPTION_LIMIT = 120;
const DESCRIPTION_LIMIT = 255;
const TOPIC_NAME_LIMIT = 128;
const STICKER_SET_NAME_LIMIT = 64;
const ADMIN_TITLE_LIMIT = 16;
const SUGGESTED_POST_COMMENT_LIMIT = 128;

const REACTION_EMOJI = new Set<string>([
  "\u2764",
  "\ud83d\udc4d",
  "\ud83d\udc4e",
  "\ud83d\udd25",
  "\ud83e\udd70",
  "\ud83d\udc4f",
  "\ud83d\ude01",
  "\ud83e\udd14",
  "\ud83e\udd2f",
  "\ud83d\ude31",
  "\ud83e\udd2c",
  "\ud83d\ude22",
  "\ud83c\udf89",
  "\ud83e\udd29",
  "\ud83e\udd2e",
  "\ud83d\udca9",
  "\ud83d\ude4f",
  "\ud83d\udc4c",
  "\ud83d\udd4a",
  "\ud83e\udd21",
  "\ud83e\udd71",
  "\ud83e\udd74",
  "\ud83d\ude0d",
  "\ud83d\udc33",
  "\u2764\u200d\ud83d\udd25",
  "\ud83c\udf1a",
  "\ud83c\udf2d",
  "\ud83d\udcaf",
  "\ud83e\udd23",
  "\u26a1",
  "\ud83c\udf4c",
  "\ud83c\udfc6",
  "\ud83d\udc94",
  "\ud83e\udd28",
  "\ud83d\ude10",
  "\ud83c\udf53",
  "\ud83c\udf7e",
  "\ud83d\udc8b",
  "\ud83d\udd95",
  "\ud83d\ude08",
  "\ud83d\ude34",
  "\ud83d\ude2d",
  "\ud83e\udd13",
  "\ud83d\udc7b",
  "\ud83d\udc68\u200d\ud83d\udcbb",
  "\ud83d\udc40",
  "\ud83c\udf83",
  "\ud83d\ude48",
  "\ud83d\ude07",
  "\ud83d\ude28",
  "\ud83e\udd1d",
  "\u270d",
  "\ud83e\udd17",
  "\ud83e\udee1",
  "\ud83c\udf85",
  "\ud83c\udf84",
  "\u2603",
  "\ud83d\udc85",
  "\ud83e\udd2a",
  "\ud83d\uddff",
  "\ud83c\udd92",
  "\ud83d\udc98",
  "\ud83d\ude49",
  "\ud83e\udd84",
  "\ud83d\ude18",
  "\ud83d\udc8a",
  "\ud83d\ude4a",
  "\ud83d\ude0e",
  "\ud83d\udc7e",
  "\ud83e\udd37\u200d\u2642",
  "\ud83e\udd37",
  "\ud83e\udd37\u200d\u2640",
  "\ud83d\ude21",
]);

export interface OperatorCommandInput {
  readonly event: Event;
  readonly adminActorIds: readonly string[];
  readonly cache: Cache;
  readonly policyStore: PolicyStore;
  readonly runtime: RuntimeStore;
  readonly source: RuleSource;
  readonly storage: Storage;
  readonly logger: Logger;
  readonly captcha?: CaptchaStore;
  readonly warns?: WarnStore;
  readonly clock?: Clock;
  readonly createNonce?: () => string;
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
      | "banActorFor"
      | "banSenderChat"
      | "clearReactions"
      | "createTopic"
      | "closeTopic"
      | "declineJoin"
      | "declinePost"
      | "deleteCommandMenu"
      | "deleteMessage"
      | "deleteMessages"
      | "deletePhoto"
      | "deleteStickerSet"
      | "deleteTopic"
      | "hideGeneral"
      | "kickActor"
      | "leaveChat"
      | "lockChat"
      | "muteActor"
      | "releaseActor"
      | "restrictActor"
      | "openTopic"
      | "pinMessage"
      | "readAdministrators"
      | "readBotDescription"
      | "readBotIdentity"
      | "readBotName"
      | "readBotShortDescription"
      | "readBoostCount"
      | "readChatGuard"
      | "readCommandMenu"
      | "readCommunity"
      | "readDefaultRights"
      | "readJoinBot"
      | "readMember"
      | "readMemberAdmin"
      | "readMemberAllows"
      | "readOwnAdmin"
      | "readMemberCount"
      | "readMenuButton"
      | "readParentChat"
      | "readPermissions"
      | "readPersonalChat"
      | "readPrivatePrivacy"
      | "readReactions"
      | "readStickerSetRight"
      | "readWebhook"
      | "removeReaction"
      | "renameGeneral"
      | "renameTopic"
      | "revokeInvite"
      | "setAdminTitle"
      | "setBotDescription"
      | "setBotName"
      | "setBotShortDescription"
      | "setCommandMenu"
      | "setDefaultRights"
      | "setDescription"
      | "setMemberTag"
      | "setMenuButton"
      | "setReaction"
      | "setStickerSet"
      | "setTitle"
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
      readonly issuedChallenge?: {
        readonly chatId: string;
        readonly actorId: string;
      };
      readonly failureText?: string;
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
  if (typeof textReply === "string") {
    return { status: "reply", command: parsed.name, text: textReply };
  }
  return {
    status: "reply",
    command: parsed.name,
    text: textReply.text,
    issuedChallenge: textReply.issuedChallenge,
    failureText: textReply.failureText,
  };
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

type CommandReply =
  | string
  | {
      readonly text: string;
      readonly failureText: string;
      readonly issuedChallenge: {
        readonly chatId: string;
        readonly actorId: string;
      };
    };

async function dispatch(
  input: OperatorCommandInput,
  name: CommandName,
  args: readonly string[],
): Promise<CommandReply> {
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
    case "banfor":
      return banMemberFor(input, args);
    case "allows":
      return showMemberAllows(input, args);
    case "canadmin":
      return showMemberAdmin(input, args);
    case "kick":
      return kickMember(input, args);
    case "cani":
      return showOwnAdmin(input, args);
    case "captcha":
      return challengeMember(input, args);
    case "uncaptcha":
      return releaseCaptcha(input, args);
    case "warn":
      return warnMember(input, args);
    case "unwarn":
      return clearWarning(input, args);
    case "warns":
      return readWarnings(input, args);
    case "warnlimit":
      return setWarnLimit(input, args);
    case "report":
      return editReport(input, args);
    case "flood":
      return editFlood(input, args);
    case "keyword":
      return editKeyword(input, args);
    case "repeat":
      return editRepeat(input, args);
    case "rulemute":
      return editRuleMute(input, args);
    case "verifyfor":
      return editVerifyFor(input, args);
    case "verifyfail":
      return editVerifyFail(input, args);
    case "allowhost":
      return editAllowHost(input, args);
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
    case "boosts":
      return showBoostCount(input, args);
    case "react":
      return setOneReaction(input, args);
    case "title":
      return setOneTitle(input, args);
    case "desc":
      return setOneDescription(input, args);
    case "newtopic":
      return createOneTopic(input, args);
    case "rentopic":
      return renameOneTopic(input, args);
    case "rengeneral":
      return renameGeneralTopic(input, args);
    case "stickers":
      return setGroupStickerSet(input, args);
    case "admintitle":
      return setOneAdminTitle(input, args);
    case "declinepost":
      return declineOnePost(input, args);
    case "delephemeral":
      return deleteEphemeral(input, args);
    case "myrights":
      return setMyRights(input, args);
    case "botrights":
      return showBotRights(input, args);
    case "setcommands":
      return publishCommandMenu(input, args);
    case "commands":
      return showCommandMenu(input, args);
    case "delcommands":
      return clearCommandMenu(input, args);
    case "menubutton":
      return setMenuButton(input, args);
    case "button":
      return showMenuButton(input, args);
    case "botname":
      return setBotName(input, args);
    case "myname":
      return showBotName(input, args);
    case "botdesc":
      return setBotDescription(input, args);
    case "mydesc":
      return showBotDescription(input, args);
    case "botshort":
      return setBotShortDescription(input, args);
    case "myshort":
      return showBotShortDescription(input, args);
    case "who":
      return showBotIdentity(input, args);
    case "hook":
      return showWebhook(input, args);
    case "guard":
      return showChatGuard(input, args);
    case "joinbot":
      return showJoinBot(input, args);
    case "reactions":
      return showReactions(input, args);
    case "community":
      return showCommunity(input, args);
    case "canstickers":
      return showCanStickers(input, args);
    case "parent":
      return showParentChat(input, args);
    case "personal":
      return showPersonalChat(input, args);
    case "privacy":
      return showPrivatePrivacy(input, args);
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
  const parsed = parseRulesArgs(args);
  if (parsed === "usage") {
    return say(input, "command.rules.usage");
  }
  if (parsed === "invalid") {
    return say(input, "command.invalid");
  }
  const scope = scopeOf(input);
  const chatId =
    parsed.chatId ?? (scope.all ? input.event.chatId : defaultChat(scope));
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
  const actions = await readRuleActions(input, chatId);
  if (!actions) {
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
    actions,
    ...(pack ? { pack } : {}),
  });
  const mark = await quotaRuleMark(input, chatId, rules);
  const header = pack
    ? say(input, "command.rules.pack", { chatId, pack: pack.id })
    : say(input, "command.rules.header", { chatId });
  const titled =
    parsed.view === undefined ? header : `${header} ${parsed.view}`;
  const lines = [
    mark.resetsAt === undefined
      ? titled
      : say(input, "command.rules.until", {
          status: titled,
          resetsAt: mark.resetsAt,
        }),
  ];
  const selected = rules.rules.filter((rule) =>
    parsed.view === undefined
      ? true
      : parsed.view === "on"
        ? rule.enabled
        : !rule.enabled,
  );
  if (selected.length === 0) {
    if (parsed.skip > 0) {
      return say(input, "command.invalid");
    }
    lines.push(say(input, "command.rules.empty"));
    return lines.join("\n");
  }
  if (parsed.skip >= selected.length) {
    return say(input, "command.invalid");
  }
  for (const rule of selected) {
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
  return fitRuleLines(input, lines, parsed.skip);
}

function parseRulesArgs(args: readonly string[]):
  | "usage"
  | "invalid"
  | {
      readonly chatId?: string;
      readonly skip: number;
      readonly view?: "on" | "off";
    } {
  let index = 0;
  let chatId: string | undefined;
  const first = args[0];
  if (first !== undefined && isTargetId(first)) {
    chatId = first;
    index = 1;
  }
  let view: "on" | "off" | undefined;
  const viewToken = args[index];
  if (viewToken === "on" || viewToken === "off") {
    view = viewToken;
    index += 1;
  }
  let skip = 0;
  if (index < args.length) {
    if (args[index] !== "skip") {
      return "usage";
    }
    const countToken = args[index + 1];
    if (countToken === undefined) {
      return "invalid";
    }
    const count = rulesSkipCount(countToken);
    if (count === undefined || args.length !== index + 2) {
      return count === undefined && args.length === index + 2
        ? "invalid"
        : "usage";
    }
    skip = count;
  }
  return {
    ...(chatId === undefined ? {} : { chatId }),
    skip,
    ...(view === undefined ? {} : { view }),
  };
}

function rulesSkipCount(value: string): number | undefined {
  if (!/^(?:0|[1-9]\d{0,4})$/.test(value)) {
    return undefined;
  }
  return Number(value);
}

function fitRuleLines(
  input: OperatorCommandInput,
  lines: readonly string[],
  skip: number,
): string {
  const header = lines[0] ?? "";
  const rules = lines.slice(1).slice(skip);
  const full = [header, ...rules].join("\n");
  if (full.length <= EXPORT_REPLY_LIMIT) {
    return full;
  }
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
  if (args.length > 3) {
    return say(input, "command.whitelist.usage");
  }
  let skip = 0;
  if (op === "skip") {
    if (args.length !== 3) {
      return say(input, "command.invalid");
    }
    const count = rulesSkipCount(actorId ?? "");
    if (count === undefined) {
      return say(input, "command.invalid");
    }
    skip = count;
  } else if (op !== undefined && op !== "add" && op !== "remove") {
    return say(input, "command.whitelist.usage");
  } else if (
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
  if (op === undefined || op === "skip") {
    return formatPolicy(input, chatId, current, skip);
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

async function showMemberAllows(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length !== 2) {
    return say(input, "command.allows.usage");
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
  const read = input.moderator?.readMemberAllows;
  if (!read) {
    rejectMemberAllows(input);
    return say(input, "command.invalid");
  }
  try {
    const allows = await read({
      tenantId: input.event.tenantId,
      chatId,
      actorId,
    });
    if (!isMemberAllows(allows)) {
      rejectMemberAllows(input);
      return say(input, "command.invalid");
    }
    return describeMemberAllows(input, chatId, actorId, allows);
  } catch {
    rejectMemberAllows(input);
    return say(input, "command.invalid");
  }
}

function isMemberAllows(allows: MemberAllows): boolean {
  if (allows.kind === "none") {
    return true;
  }
  if (allows.kind !== "restricted" || typeof allows.inChat !== "boolean") {
    return false;
  }
  if (allows.untilDate !== null && !isUntil(allows.untilDate)) {
    return false;
  }
  return permissionLines.every(([, field]) =>
    isOnOff(allows.permissions[field]),
  );
}

function isUntil(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function isOnOff(state: PermissionState): boolean {
  return state === "on" || state === "off";
}

function describeMemberAllows(
  input: OperatorCommandInput,
  chatId: string,
  actorId: string,
  allows: MemberAllows,
): string {
  const lines = [say(input, "command.allows.header", { chatId, actorId })];
  if (allows.kind === "none") {
    lines.push(say(input, "command.allows.none"));
    return lines.join("\n");
  }
  lines.push(
    say(
      input,
      allows.inChat ? "command.allows.present" : "command.allows.away",
    ),
  );
  if (allows.untilDate !== null) {
    lines.push(say(input, "command.allows.until", { until: allows.untilDate }));
  }
  for (const [label, field] of permissionLines) {
    lines.push(
      `${say(input, label)} ${say(input, permissionStateKey(allows.permissions[field]))}`,
    );
  }
  return lines.join("\n");
}

function rejectMemberAllows(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "allows",
  });
}

async function showMemberAdmin(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length !== 2) {
    return say(input, "command.canadmin.usage");
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
  const read = input.moderator?.readMemberAdmin;
  if (!read) {
    rejectMemberAdmin(input);
    return say(input, "command.invalid");
  }
  try {
    const admin = await read({
      tenantId: input.event.tenantId,
      chatId,
      actorId,
    });
    if (!isMemberAdmin(admin, actorId)) {
      rejectMemberAdmin(input);
      return say(input, "command.invalid");
    }
    return describeMemberAdmin(input, chatId, actorId, admin);
  } catch {
    rejectMemberAdmin(input);
    return say(input, "command.invalid");
  }
}

function isMemberAdmin(value: MemberAdmin, actorId: string): boolean {
  if (value.kind === "none") {
    return true;
  }
  if (value.kind !== "admin") {
    return false;
  }
  const admin = value.admin;
  if (
    admin.actorId !== actorId ||
    typeof admin.bot !== "boolean" ||
    typeof admin.anonymous !== "boolean" ||
    (admin.role !== "creator" && admin.role !== "administrator") ||
    !knownRights(admin.rights)
  ) {
    return false;
  }
  if (admin.role === "creator") {
    return admin.rights.length === 0 && value.editable === null;
  }
  return value.editable === "on" || value.editable === "off";
}

function knownRights(rights: readonly AdministratorRight[]): boolean {
  return rights.every((right) => administratorRights.includes(right));
}

function describeMemberAdmin(
  input: OperatorCommandInput,
  chatId: string,
  actorId: string,
  value: MemberAdmin,
  header:
    | "command.canadmin.header"
    | "command.cani.header" = "command.canadmin.header",
): string {
  const lines = [say(input, header, { chatId, actorId })];
  if (value.kind === "none") {
    lines.push(say(input, "command.canadmin.none"));
    return lines.join("\n");
  }
  const line = administratorLine(input, value.admin);
  if (value.editable === null) {
    lines.push(line);
    return lines.join("\n");
  }
  lines.push(
    `${line} ${say(input, "command.canadmin.editable")} ${say(input, permissionStateKey(value.editable))}`,
  );
  return lines.join("\n");
}

function rejectMemberAdmin(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "canadmin",
  });
}

async function showOwnAdmin(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length !== 1) {
    return say(input, "command.cani.usage");
  }
  const chatId = args[0];
  if (chatId === undefined || !isTargetId(chatId)) {
    return say(input, "command.invalid");
  }
  const refused = refuseChat(input, chatId);
  if (refused) {
    return refused;
  }
  const read = input.moderator?.readOwnAdmin;
  if (!read) {
    rejectOwnAdmin(input);
    return say(input, "command.invalid");
  }
  try {
    const admin = await read({
      tenantId: input.event.tenantId,
      chatId,
    });
    if (!isOwnAdmin(admin)) {
      rejectOwnAdmin(input);
      return say(input, "command.invalid");
    }
    const standing: MemberAdmin =
      admin.kind === "none"
        ? { kind: "none" }
        : {
            kind: "admin",
            editable: admin.editable,
            admin: admin.admin,
          };
    return describeMemberAdmin(
      input,
      chatId,
      admin.botId,
      standing,
      "command.cani.header",
    );
  } catch {
    rejectOwnAdmin(input);
    return say(input, "command.invalid");
  }
}

function isOwnAdmin(value: OwnAdmin): boolean {
  if (!isTargetId(value.botId)) {
    return false;
  }
  if (value.kind === "none") {
    return true;
  }
  if (value.kind !== "admin") {
    return false;
  }
  return (
    value.admin.actorId === value.botId &&
    isMemberAdmin(
      {
        kind: "admin",
        editable: value.editable,
        admin: value.admin,
      },
      value.botId,
    )
  );
}

function rejectOwnAdmin(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "cani",
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
  if (args.length === 0) {
    return say(input, "command.admins.usage");
  }
  const chatId = args[0];
  if (chatId === undefined || !isTargetId(chatId)) {
    return args.length === 1
      ? say(input, "command.invalid")
      : say(input, "command.admins.usage");
  }
  const refused = refuseChat(input, chatId);
  if (refused) {
    return refused;
  }
  const skip = parseAdminsSkip(args);
  if (skip === "usage") {
    return say(input, "command.admins.usage");
  }
  if (skip === "invalid") {
    return say(input, "command.invalid");
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
    return describeAdministrators(input, chatId, admins, skip);
  } catch {
    rejectAdministrators(input);
    return say(input, "command.invalid");
  }
}

function parseAdminsSkip(
  args: readonly string[],
): "usage" | "invalid" | number {
  if (args.length === 1) {
    return 0;
  }
  if (args[1] !== "skip") {
    return "usage";
  }
  const countToken = args[2];
  if (countToken === undefined) {
    return "invalid";
  }
  const count = rulesSkipCount(countToken);
  if (count === undefined || args.length !== 3) {
    return count === undefined && args.length === 3 ? "invalid" : "usage";
  }
  return count;
}

function describeAdministrators(
  input: OperatorCommandInput,
  chatId: string,
  admins: readonly ChatAdministrator[],
  skip = 0,
): string {
  const header = say(input, "command.admins.header", { chatId });
  if (admins.length === 0) {
    if (skip > 0) {
      return say(input, "command.invalid");
    }
    return `${header}\n${say(input, "command.admins.empty")}`;
  }
  if (skip >= admins.length) {
    return say(input, "command.invalid");
  }
  return fitAdministratorLines(
    header,
    admins.slice(skip).map((admin) => administratorLine(input, admin)),
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

async function showBoostCount(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length !== 2) {
    return say(input, "command.boosts.usage");
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
  const read = input.moderator?.readBoostCount;
  if (!read) {
    rejectBoosts(input);
    return say(input, "command.invalid");
  }
  try {
    const count = await read({
      tenantId: input.event.tenantId,
      chatId,
      actorId,
    });
    return say(input, "command.boosts.done", {
      chatId,
      actorId,
      count: String(count),
    });
  } catch {
    rejectBoosts(input);
    return say(input, "command.invalid");
  }
}

function rejectBoosts(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "boosts",
  });
}

async function setOneReaction(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length !== 3) {
    return say(input, "command.react.usage");
  }
  const chatId = args[0];
  const messageId = args[1];
  const emoji = args[2];
  if (
    chatId === undefined ||
    messageId === undefined ||
    emoji === undefined ||
    !isTargetId(chatId) ||
    !isMessageId(messageId) ||
    !REACTION_EMOJI.has(emoji)
  ) {
    return say(input, "command.invalid");
  }
  const refused = refuseChat(input, chatId);
  if (refused) {
    return refused;
  }
  const set = input.moderator?.setReaction;
  if (!set) {
    rejectReact(input);
    return say(input, "command.invalid");
  }
  try {
    await set({
      tenantId: input.event.tenantId,
      chatId,
      messageId,
      emoji,
    });
  } catch {
    rejectReact(input);
    return say(input, "command.invalid");
  }
  return say(input, "command.react.done", { chatId, messageId, emoji });
}

function rejectReact(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "react",
  });
}

async function setOneTitle(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length < 2) {
    return say(input, "command.title.usage");
  }
  const chatId = args[0];
  const title = args.slice(1).join(" ");
  if (
    chatId === undefined ||
    !isTargetId(chatId) ||
    title.length > TITLE_LIMIT
  ) {
    return say(input, "command.invalid");
  }
  const refused = refuseChat(input, chatId);
  if (refused) {
    return refused;
  }
  const set = input.moderator?.setTitle;
  if (!set) {
    rejectTitle(input);
    return say(input, "command.invalid");
  }
  try {
    await set({
      tenantId: input.event.tenantId,
      chatId,
      title,
    });
  } catch {
    rejectTitle(input);
    return say(input, "command.invalid");
  }
  return say(input, "command.title.done", { chatId });
}

function rejectTitle(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "title",
  });
}

async function setOneDescription(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length < 1) {
    return say(input, "command.desc.usage");
  }
  const chatId = args[0];
  const description = args.slice(1).join(" ");
  if (
    chatId === undefined ||
    !isTargetId(chatId) ||
    description.length > DESCRIPTION_LIMIT
  ) {
    return say(input, "command.invalid");
  }
  const refused = refuseChat(input, chatId);
  if (refused) {
    return refused;
  }
  const set = input.moderator?.setDescription;
  if (!set) {
    rejectDescription(input);
    return say(input, "command.invalid");
  }
  try {
    await set({
      tenantId: input.event.tenantId,
      chatId,
      description,
    });
  } catch {
    rejectDescription(input);
    return say(input, "command.invalid");
  }
  return say(
    input,
    description.length === 0 ? "command.desc.cleared" : "command.desc.done",
    { chatId },
  );
}

function rejectDescription(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "desc",
  });
}

async function createOneTopic(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length < 2) {
    return say(input, "command.newtopic.usage");
  }
  const chatId = args[0];
  const name = args.slice(1).join(" ");
  if (
    chatId === undefined ||
    !isTargetId(chatId) ||
    name.length > TOPIC_NAME_LIMIT
  ) {
    return say(input, "command.invalid");
  }
  const refused = refuseChat(input, chatId);
  if (refused) {
    return refused;
  }
  const create = input.moderator?.createTopic;
  if (!create) {
    rejectNewTopic(input);
    return say(input, "command.invalid");
  }
  try {
    const threadId = await create({
      tenantId: input.event.tenantId,
      chatId,
      name,
    });
    if (!isMessageId(threadId)) {
      rejectNewTopic(input);
      return say(input, "command.invalid");
    }
    return say(input, "command.newtopic.done", { chatId, threadId });
  } catch {
    rejectNewTopic(input);
    return say(input, "command.invalid");
  }
}

function rejectNewTopic(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "newtopic",
  });
}

async function renameOneTopic(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length < 3) {
    return say(input, "command.rentopic.usage");
  }
  const chatId = args[0];
  const threadId = args[1];
  const name = args.slice(2).join(" ");
  if (
    chatId === undefined ||
    threadId === undefined ||
    !isTargetId(chatId) ||
    !isMessageId(threadId) ||
    name.length > TOPIC_NAME_LIMIT
  ) {
    return say(input, "command.invalid");
  }
  const refused = refuseChat(input, chatId);
  if (refused) {
    return refused;
  }
  const rename = input.moderator?.renameTopic;
  if (!rename) {
    rejectRenameTopic(input);
    return say(input, "command.invalid");
  }
  try {
    await rename({
      tenantId: input.event.tenantId,
      chatId,
      threadId,
      name,
    });
  } catch {
    rejectRenameTopic(input);
    return say(input, "command.invalid");
  }
  return say(input, "command.rentopic.done", { chatId, threadId });
}

function rejectRenameTopic(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "rentopic",
  });
}

async function renameGeneralTopic(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length < 2) {
    return say(input, "command.rengeneral.usage");
  }
  const chatId = args[0];
  const name = args.slice(1).join(" ");
  if (
    chatId === undefined ||
    !isTargetId(chatId) ||
    name.length > TOPIC_NAME_LIMIT
  ) {
    return say(input, "command.invalid");
  }
  const refused = refuseChat(input, chatId);
  if (refused) {
    return refused;
  }
  const rename = input.moderator?.renameGeneral;
  if (!rename) {
    rejectRenameGeneral(input);
    return say(input, "command.invalid");
  }
  try {
    await rename({
      tenantId: input.event.tenantId,
      chatId,
      name,
    });
  } catch {
    rejectRenameGeneral(input);
    return say(input, "command.invalid");
  }
  return say(input, "command.rengeneral.done", { chatId });
}

function rejectRenameGeneral(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "rengeneral",
  });
}

function isStickerSetName(name: string): boolean {
  if (name.length < 1 || name.length > STICKER_SET_NAME_LIMIT) {
    return false;
  }
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name) || name.includes("__")) {
    return false;
  }
  const marker = name.toLowerCase().lastIndexOf("_by_");
  if (marker < 1) {
    return false;
  }
  const username = name.slice(marker + 4);
  return (
    username.length >= 5 &&
    username.length <= 32 &&
    /^[A-Za-z]/.test(username) &&
    /bot$/i.test(username)
  );
}

async function setGroupStickerSet(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length !== 2) {
    return say(input, "command.stickers.usage");
  }
  const chatId = args[0];
  const name = args[1];
  if (
    chatId === undefined ||
    name === undefined ||
    !isTargetId(chatId) ||
    !isStickerSetName(name)
  ) {
    return say(input, "command.invalid");
  }
  const refused = refuseChat(input, chatId);
  if (refused) {
    return refused;
  }
  const set = input.moderator?.setStickerSet;
  if (!set) {
    rejectStickerSet(input);
    return say(input, "command.invalid");
  }
  try {
    await set({
      tenantId: input.event.tenantId,
      chatId,
      name,
    });
  } catch {
    rejectStickerSet(input);
    return say(input, "command.invalid");
  }
  return say(input, "command.stickers.done", { chatId });
}

function rejectStickerSet(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "stickers",
  });
}

async function setOneAdminTitle(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length < 2) {
    return say(input, "command.admintitle.usage");
  }
  const chatId = args[0];
  const actorId = args[1];
  const title = args.slice(2).join(" ");
  if (
    chatId === undefined ||
    actorId === undefined ||
    !isTargetId(chatId) ||
    !isTargetId(actorId) ||
    title.length > ADMIN_TITLE_LIMIT
  ) {
    return say(input, "command.invalid");
  }
  const refused = refuseChat(input, chatId);
  if (refused) {
    return refused;
  }
  const set = input.moderator?.setAdminTitle;
  if (!set) {
    rejectAdminTitle(input);
    return say(input, "command.invalid");
  }
  try {
    await set({
      tenantId: input.event.tenantId,
      chatId,
      actorId,
      title,
    });
  } catch {
    rejectAdminTitle(input);
    return say(input, "command.invalid");
  }
  return say(
    input,
    title.length === 0
      ? "command.admintitle.cleared"
      : "command.admintitle.done",
    { chatId, actorId },
  );
}

function rejectAdminTitle(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "admintitle",
  });
}

async function declineOnePost(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length < 2) {
    return say(input, "command.declinepost.usage");
  }
  const chatId = args[0];
  const messageId = args[1];
  const comment = args.slice(2).join(" ");
  if (
    chatId === undefined ||
    messageId === undefined ||
    !isTargetId(chatId) ||
    !isMessageId(messageId) ||
    comment.length > SUGGESTED_POST_COMMENT_LIMIT
  ) {
    return say(input, "command.invalid");
  }
  const refused = refuseChat(input, chatId);
  if (refused) {
    return refused;
  }
  const decline = input.moderator?.declinePost;
  if (!decline) {
    rejectDeclinePost(input);
    return say(input, "command.invalid");
  }
  try {
    await decline({
      tenantId: input.event.tenantId,
      chatId,
      messageId,
      ...(comment.length > 0 ? { comment } : {}),
    });
  } catch {
    rejectDeclinePost(input);
    return say(input, "command.invalid");
  }
  return say(input, "command.declinepost.done", { chatId, messageId });
}

function rejectDeclinePost(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "declinepost",
  });
}

async function deleteEphemeral(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length !== 3) {
    return say(input, "command.delephemeral.usage");
  }
  const chatId = args[0];
  const actorId = args[1];
  const messageId = args[2];
  if (
    chatId === undefined ||
    actorId === undefined ||
    messageId === undefined ||
    !isTargetId(chatId) ||
    !isTargetId(actorId) ||
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
    rejectDeleteEphemeral(input);
    return say(input, "command.invalid");
  }
  try {
    await remove({
      tenantId: input.event.tenantId,
      chatId,
      messageId,
      audienceId: actorId,
    });
  } catch {
    rejectDeleteEphemeral(input);
    return say(input, "command.invalid");
  }
  return say(input, "command.delephemeral.done", {
    chatId,
    messageId,
    actorId,
  });
}

function rejectDeleteEphemeral(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "delephemeral",
  });
}

const defaultRightTokens = {
  anonymous: "anonymous",
  manage_chat: "manageChat",
  delete_messages: "deleteMessages",
  manage_video_chats: "manageVideoChats",
  restrict_members: "restrictMembers",
  promote_members: "promoteMembers",
  change_info: "changeInfo",
  invite_users: "inviteUsers",
  post_stories: "postStories",
  edit_stories: "editStories",
  delete_stories: "deleteStories",
  post_messages: "postMessages",
  edit_messages: "editMessages",
  pin_messages: "pinMessages",
  manage_topics: "manageTopics",
  manage_direct_messages: "manageDirectMessages",
  manage_tags: "manageTags",
  send_welcome_messages: "sendWelcomeMessages",
} as const satisfies Record<string, keyof DefaultAdministratorRights>;

function chosenDefaultRights(
  tokens: readonly string[],
): DefaultAdministratorRights | undefined {
  const rights: { -readonly [K in keyof DefaultAdministratorRights]: boolean } =
    {
      anonymous: false,
      manageChat: false,
      deleteMessages: false,
      manageVideoChats: false,
      restrictMembers: false,
      promoteMembers: false,
      changeInfo: false,
      inviteUsers: false,
      postStories: false,
      editStories: false,
      deleteStories: false,
      postMessages: false,
      editMessages: false,
      pinMessages: false,
      manageTopics: false,
      manageDirectMessages: false,
      manageTags: false,
      sendWelcomeMessages: false,
    };
  const seen = new Set<string>();
  for (const token of tokens) {
    const field = defaultRightTokens[token as keyof typeof defaultRightTokens];
    if (field === undefined || token === "clear" || seen.has(token)) {
      return undefined;
    }
    seen.add(token);
    rights[field] = true;
  }
  return rights;
}

async function setMyRights(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length === 0) {
    return say(input, "command.myrights.usage");
  }
  const forChannels = args[0] === "channels";
  const rest = forChannels ? args.slice(1) : args;
  if (rest.length === 0) {
    return say(input, "command.myrights.usage");
  }
  const clearing = rest.length === 1 && rest[0] === "clear";
  const rights = clearing ? undefined : chosenDefaultRights(rest);
  if (!clearing && rights === undefined) {
    return say(input, "command.invalid");
  }
  if (!scopeOf(input).all) {
    return say(input, "command.denied");
  }
  const set = input.moderator?.setDefaultRights;
  if (!set) {
    rejectDefaultRights(input);
    return say(input, "command.invalid");
  }
  try {
    await set({
      tenantId: input.event.tenantId,
      forChannels,
      ...(rights === undefined ? {} : { rights }),
    });
  } catch {
    rejectDefaultRights(input);
    return say(input, "command.invalid");
  }
  if (rights === undefined) {
    return say(
      input,
      forChannels
        ? "command.myrights.channels_cleared"
        : "command.myrights.cleared",
    );
  }
  return say(
    input,
    forChannels ? "command.myrights.channels" : "command.myrights.done",
  );
}

function rejectDefaultRights(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "myrights",
  });
}

const defaultRightLines = [
  ["command.admins.anonymous", "anonymous"],
  ["command.admins.manage_chat", "manageChat"],
  ["command.admins.delete_messages", "deleteMessages"],
  ["command.admins.manage_video_chats", "manageVideoChats"],
  ["command.admins.restrict_members", "restrictMembers"],
  ["command.admins.promote_members", "promoteMembers"],
  ["command.admins.change_info", "changeInfo"],
  ["command.admins.invite_users", "inviteUsers"],
  ["command.admins.post_stories", "postStories"],
  ["command.admins.edit_stories", "editStories"],
  ["command.admins.delete_stories", "deleteStories"],
  ["command.admins.post_messages", "postMessages"],
  ["command.admins.edit_messages", "editMessages"],
  ["command.admins.pin_messages", "pinMessages"],
  ["command.admins.manage_topics", "manageTopics"],
  ["command.admins.manage_direct_messages", "manageDirectMessages"],
  ["command.admins.manage_tags", "manageTags"],
  ["command.admins.send_welcome_messages", "sendWelcomeMessages"],
] as const satisfies ReadonlyArray<
  readonly [MessageKey, keyof DefaultRightsSnapshot]
>;

async function showBotRights(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length > 1) {
    return say(input, "command.botrights.usage");
  }
  const forChannels = args.length === 1;
  if (forChannels && args[0] !== "channels") {
    return say(input, "command.invalid");
  }
  if (!scopeOf(input).all) {
    return say(input, "command.denied");
  }
  const read = input.moderator?.readDefaultRights;
  if (!read) {
    rejectBotRights(input);
    return say(input, "command.invalid");
  }
  try {
    const rights = await read({
      tenantId: input.event.tenantId,
      forChannels,
    });
    return describeBotRights(input, forChannels, rights);
  } catch {
    rejectBotRights(input);
    return say(input, "command.invalid");
  }
}

function describeBotRights(
  input: OperatorCommandInput,
  forChannels: boolean,
  rights: DefaultRightsSnapshot,
): string {
  const lines = [
    say(
      input,
      forChannels ? "command.botrights.channels" : "command.botrights.groups",
    ),
  ];
  for (const [label, field] of defaultRightLines) {
    lines.push(
      `${say(input, label)} ${say(input, permissionStateKey(rights[field]))}`,
    );
  }
  return lines.join("\n");
}

function rejectBotRights(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "botrights",
  });
}

const MENU_LIMIT = 100;

function privateMenu(): readonly MenuCommand[] | undefined {
  const descriptions = commandDescriptions();
  if (descriptions.size !== COMMAND_NAMES.length) {
    return undefined;
  }
  const commands: MenuCommand[] = [];
  for (const name of COMMAND_NAMES) {
    const description = descriptions.get(name);
    if (
      description === undefined ||
      description.length < 1 ||
      description.length > 256 ||
      !/^[a-z0-9_]{1,32}$/.test(name)
    ) {
      return undefined;
    }
    commands.push({ command: name, description });
  }
  if (commands.length === 0 || commands.length > MENU_LIMIT) {
    return undefined;
  }
  return commands;
}

async function publishCommandMenu(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length > 1) {
    return say(input, "command.setcommands.usage");
  }
  if (args.length === 1 && args[0] !== "private") {
    return say(input, "command.invalid");
  }
  if (!scopeOf(input).all) {
    return say(input, "command.denied");
  }
  const commands = privateMenu();
  const set = input.moderator?.setCommandMenu;
  if (!commands || !set) {
    rejectCommandMenu(input);
    return say(input, "command.invalid");
  }
  try {
    await set({
      tenantId: input.event.tenantId,
      commands,
    });
  } catch {
    rejectCommandMenu(input);
    return say(input, "command.invalid");
  }
  return say(input, "command.setcommands.done");
}

function rejectCommandMenu(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "setcommands",
  });
}

async function showCommandMenu(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  const parsed = parseCommandsArgs(args);
  if (parsed === "usage") {
    return say(input, "command.commands.usage");
  }
  if (parsed === "invalid") {
    return say(input, "command.invalid");
  }
  if (!scopeOf(input).all) {
    return say(input, "command.denied");
  }
  const read = input.moderator?.readCommandMenu;
  if (!read) {
    rejectReadCommandMenu(input);
    return say(input, "command.invalid");
  }
  try {
    const commands = await read({ tenantId: input.event.tenantId });
    return describeCommandMenu(input, commands, parsed.skip);
  } catch {
    rejectReadCommandMenu(input);
    return say(input, "command.invalid");
  }
}

function parseCommandsArgs(
  args: readonly string[],
): "usage" | "invalid" | { readonly skip: number } {
  let index = 0;
  if (args[0] === "private") {
    index = 1;
  } else if (args.length === 1) {
    return "invalid";
  }
  if (index === args.length) {
    return { skip: 0 };
  }
  if (args[index] !== "skip") {
    return "usage";
  }
  const countToken = args[index + 1];
  if (countToken === undefined) {
    return "invalid";
  }
  const count = rulesSkipCount(countToken);
  if (count === undefined || args.length !== index + 2) {
    return count === undefined && args.length === index + 2
      ? "invalid"
      : "usage";
  }
  return { skip: count };
}

function describeCommandMenu(
  input: OperatorCommandInput,
  commands: readonly MenuCommandSnapshot[],
  skip: number,
): string {
  const header = say(input, "command.commands.header", {
    count: commands.length,
  });
  if (commands.length === 0) {
    if (skip > 0) {
      return say(input, "command.invalid");
    }
    return header;
  }
  if (skip >= commands.length) {
    return say(input, "command.invalid");
  }
  return fitAdministratorLines(
    header,
    commands
      .slice(skip)
      .map(
        (item) =>
          `${item.command} ${item.description} ${say(input, permissionStateKey(item.ephemeral))}`,
      ),
    (count) => say(input, "command.commands.more", { count }),
  );
}

function rejectReadCommandMenu(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "commands",
  });
}

async function clearCommandMenu(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length > 1) {
    return say(input, "command.delcommands.usage");
  }
  if (args.length === 1 && args[0] !== "private") {
    return say(input, "command.invalid");
  }
  if (!scopeOf(input).all) {
    return say(input, "command.denied");
  }
  const clear = input.moderator?.deleteCommandMenu;
  if (!clear) {
    rejectClearCommandMenu(input);
    return say(input, "command.invalid");
  }
  try {
    await clear({ tenantId: input.event.tenantId });
  } catch {
    rejectClearCommandMenu(input);
    return say(input, "command.invalid");
  }
  return say(input, "command.delcommands.done");
}

function rejectClearCommandMenu(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "delcommands",
  });
}

function menuButtonKind(token: string): "commands" | "default" | undefined {
  if (token === "commands" || token === "default") {
    return token;
  }
  return undefined;
}

async function setMenuButton(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length !== 1) {
    return say(input, "command.menubutton.usage");
  }
  const kind = menuButtonKind(args[0] ?? "");
  if (kind === undefined) {
    return say(input, "command.invalid");
  }
  if (!scopeOf(input).all) {
    return say(input, "command.denied");
  }
  const set = input.moderator?.setMenuButton;
  if (!set) {
    rejectMenuButton(input);
    return say(input, "command.invalid");
  }
  try {
    await set({ tenantId: input.event.tenantId, kind });
  } catch {
    rejectMenuButton(input);
    return say(input, "command.invalid");
  }
  return say(
    input,
    kind === "commands"
      ? "command.menubutton.commands"
      : "command.menubutton.default",
  );
}

function rejectMenuButton(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "menubutton",
  });
}

async function showMenuButton(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length > 1) {
    return say(input, "command.button.usage");
  }
  if (args.length === 1) {
    return say(input, "command.invalid");
  }
  if (!scopeOf(input).all) {
    return say(input, "command.denied");
  }
  const read = input.moderator?.readMenuButton;
  if (!read) {
    rejectReadMenuButton(input);
    return say(input, "command.invalid");
  }
  try {
    const state = await read({ tenantId: input.event.tenantId });
    return say(input, menuButtonStateKey(state));
  } catch {
    rejectReadMenuButton(input);
    return say(input, "command.invalid");
  }
}

function menuButtonStateKey(
  state: MenuButtonState,
):
  | "command.button.commands"
  | "command.button.default"
  | "command.button.web_app" {
  switch (state) {
    case "commands":
      return "command.button.commands";
    case "default":
      return "command.button.default";
    case "web_app":
      return "command.button.web_app";
  }
}

function rejectReadMenuButton(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "button",
  });
}

async function setBotName(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  const name = args.join(" ");
  if (name.length > BOT_NAME_LIMIT) {
    return say(input, "command.invalid");
  }
  if (!scopeOf(input).all) {
    return say(input, "command.denied");
  }
  const set = input.moderator?.setBotName;
  if (!set) {
    rejectBotName(input);
    return say(input, "command.invalid");
  }
  try {
    await set({ tenantId: input.event.tenantId, name });
  } catch {
    rejectBotName(input);
    return say(input, "command.invalid");
  }
  return say(
    input,
    name.length === 0 ? "command.botname.cleared" : "command.botname.done",
  );
}

function rejectBotName(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "botname",
  });
}

async function showBotName(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length > 1) {
    return say(input, "command.myname.usage");
  }
  if (args.length === 1) {
    return say(input, "command.invalid");
  }
  if (!scopeOf(input).all) {
    return say(input, "command.denied");
  }
  const read = input.moderator?.readBotName;
  if (!read) {
    rejectReadBotName(input);
    return say(input, "command.invalid");
  }
  try {
    const name = await read({ tenantId: input.event.tenantId });
    if (!isBotName(name)) {
      rejectReadBotName(input);
      return say(input, "command.invalid");
    }
    return name.length === 0
      ? say(input, "command.myname.empty")
      : say(input, "command.myname.body", { name });
  } catch {
    rejectReadBotName(input);
    return say(input, "command.invalid");
  }
}

function isBotName(name: string): boolean {
  return name.length <= BOT_NAME_LIMIT && !/[\r\n]/.test(name);
}

function rejectReadBotName(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "myname",
  });
}

async function setBotDescription(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  const description = args.join(" ");
  if (description.length > BOT_DESCRIPTION_LIMIT) {
    return say(input, "command.invalid");
  }
  if (!scopeOf(input).all) {
    return say(input, "command.denied");
  }
  const set = input.moderator?.setBotDescription;
  if (!set) {
    rejectBotDescription(input);
    return say(input, "command.invalid");
  }
  try {
    await set({ tenantId: input.event.tenantId, description });
  } catch {
    rejectBotDescription(input);
    return say(input, "command.invalid");
  }
  return say(
    input,
    description.length === 0
      ? "command.botdesc.cleared"
      : "command.botdesc.done",
  );
}

function rejectBotDescription(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "botdesc",
  });
}

async function showBotDescription(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length > 1) {
    return say(input, "command.mydesc.usage");
  }
  if (args.length === 1) {
    return say(input, "command.invalid");
  }
  if (!scopeOf(input).all) {
    return say(input, "command.denied");
  }
  const read = input.moderator?.readBotDescription;
  if (!read) {
    rejectReadBotDescription(input);
    return say(input, "command.invalid");
  }
  try {
    const description = await read({ tenantId: input.event.tenantId });
    if (!isBotDescription(description)) {
      rejectReadBotDescription(input);
      return say(input, "command.invalid");
    }
    return description.length === 0
      ? say(input, "command.mydesc.empty")
      : say(input, "command.mydesc.body", { description });
  } catch {
    rejectReadBotDescription(input);
    return say(input, "command.invalid");
  }
}

function isBotDescription(description: string): boolean {
  return (
    description.length <= BOT_DESCRIPTION_LIMIT && !/[\r\n]/.test(description)
  );
}

function rejectReadBotDescription(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "mydesc",
  });
}

async function setBotShortDescription(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  const shortDescription = args.join(" ");
  if (shortDescription.length > BOT_SHORT_DESCRIPTION_LIMIT) {
    return say(input, "command.invalid");
  }
  if (!scopeOf(input).all) {
    return say(input, "command.denied");
  }
  const set = input.moderator?.setBotShortDescription;
  if (!set) {
    rejectBotShortDescription(input);
    return say(input, "command.invalid");
  }
  try {
    await set({ tenantId: input.event.tenantId, shortDescription });
  } catch {
    rejectBotShortDescription(input);
    return say(input, "command.invalid");
  }
  return say(
    input,
    shortDescription.length === 0
      ? "command.botshort.cleared"
      : "command.botshort.done",
  );
}

function rejectBotShortDescription(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "botshort",
  });
}

async function showBotShortDescription(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length > 1) {
    return say(input, "command.myshort.usage");
  }
  if (args.length === 1) {
    return say(input, "command.invalid");
  }
  if (!scopeOf(input).all) {
    return say(input, "command.denied");
  }
  const read = input.moderator?.readBotShortDescription;
  if (!read) {
    rejectReadBotShortDescription(input);
    return say(input, "command.invalid");
  }
  try {
    const shortDescription = await read({ tenantId: input.event.tenantId });
    if (!isBotShortDescription(shortDescription)) {
      rejectReadBotShortDescription(input);
      return say(input, "command.invalid");
    }
    return shortDescription.length === 0
      ? say(input, "command.myshort.empty")
      : say(input, "command.myshort.body", { shortDescription });
  } catch {
    rejectReadBotShortDescription(input);
    return say(input, "command.invalid");
  }
}

function isBotShortDescription(shortDescription: string): boolean {
  return (
    shortDescription.length <= BOT_SHORT_DESCRIPTION_LIMIT &&
    !/[\r\n]/.test(shortDescription)
  );
}

function rejectReadBotShortDescription(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "myshort",
  });
}

async function showBotIdentity(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length > 1) {
    return say(input, "command.who.usage");
  }
  if (args.length === 1) {
    return say(input, "command.invalid");
  }
  if (!scopeOf(input).all) {
    return say(input, "command.denied");
  }
  const read = input.moderator?.readBotIdentity;
  if (!read) {
    rejectBotIdentity(input);
    return say(input, "command.invalid");
  }
  try {
    const identity = await read({ tenantId: input.event.tenantId });
    if (!isBotIdentity(identity)) {
      rejectBotIdentity(input);
      return say(input, "command.invalid");
    }
    return describeBotIdentity(input, identity);
  } catch {
    rejectBotIdentity(input);
    return say(input, "command.invalid");
  }
}

function isBotIdentity(identity: BotIdentity): boolean {
  return (
    isBotUserId(identity.id) &&
    isBotUsername(identity.username) &&
    isPermissionState(identity.joinGroups) &&
    isPermissionState(identity.readAllGroupMessages) &&
    isPermissionState(identity.guestQueries) &&
    isPermissionState(identity.joinRequestQueries)
  );
}

function isBotUserId(id: string): boolean {
  return /^[1-9]\d{0,15}$/.test(id) && Number.isSafeInteger(Number(id));
}

function isBotUsername(username: string): boolean {
  return username.length === 0 || /^[A-Za-z0-9_]{1,32}$/.test(username);
}

function isPermissionState(state: string): state is PermissionState {
  return state === "on" || state === "off" || state === "unknown";
}

function describeBotIdentity(
  input: OperatorCommandInput,
  identity: BotIdentity,
): string {
  const username =
    identity.username.length === 0
      ? say(input, "command.who.username_empty")
      : say(input, "command.who.username", { username: identity.username });
  return [
    say(input, "command.who.id", { id: identity.id }),
    username,
    `${say(input, "command.who.groups")} ${say(input, permissionStateKey(identity.joinGroups))}`,
    `${say(input, "command.who.messages")} ${say(input, permissionStateKey(identity.readAllGroupMessages))}`,
    `${say(input, "command.who.guests")} ${say(input, permissionStateKey(identity.guestQueries))}`,
    `${say(input, "command.who.join_queries")} ${say(input, permissionStateKey(identity.joinRequestQueries))}`,
  ].join("\n");
}

function rejectBotIdentity(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "who",
  });
}

async function showWebhook(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length > 1) {
    return say(input, "command.hook.usage");
  }
  if (args.length === 1) {
    return say(input, "command.invalid");
  }
  if (!scopeOf(input).all) {
    return say(input, "command.denied");
  }
  const read = input.moderator?.readWebhook;
  if (!read) {
    rejectWebhook(input);
    return say(input, "command.invalid");
  }
  try {
    const snapshot = await read({ tenantId: input.event.tenantId });
    if (!isWebhookSnapshot(snapshot)) {
      rejectWebhook(input);
      return say(input, "command.invalid");
    }
    return describeWebhook(input, snapshot);
  } catch {
    rejectWebhook(input);
    return say(input, "command.invalid");
  }
}

function isWebhookSnapshot(snapshot: WebhookSnapshot): boolean {
  return (
    isPendingCount(snapshot.pendingUpdateCount) &&
    isPermissionState(snapshot.customCertificate) &&
    isMaxConnections(snapshot.maxConnections) &&
    isErrorDate(snapshot.lastErrorDate)
  );
}

function isPendingCount(count: number): boolean {
  return Number.isSafeInteger(count) && count >= 0;
}

function isMaxConnections(count: number | null): boolean {
  return (
    count === null ||
    (Number.isSafeInteger(count) && count >= 1 && count <= 100)
  );
}

function isErrorDate(time: number | null): boolean {
  return time === null || (Number.isSafeInteger(time) && time >= 0);
}

function describeWebhook(
  input: OperatorCommandInput,
  snapshot: WebhookSnapshot,
): string {
  const connections =
    snapshot.maxConnections === null
      ? say(input, "command.hook.connections_unknown")
      : say(input, "command.hook.connections", {
          count: snapshot.maxConnections,
        });
  const error =
    snapshot.lastErrorDate === null
      ? say(input, "command.hook.error_unknown")
      : say(input, "command.hook.error", { time: snapshot.lastErrorDate });
  return [
    say(input, "command.hook.pending", { count: snapshot.pendingUpdateCount }),
    `${say(input, "command.hook.certificate")} ${say(input, permissionStateKey(snapshot.customCertificate))}`,
    connections,
    error,
  ].join("\n");
}

function rejectWebhook(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "hook",
  });
}

async function showChatGuard(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length !== 1) {
    return say(input, "command.guard.usage");
  }
  const chatId = args[0];
  if (chatId === undefined || !isTargetId(chatId)) {
    return say(input, "command.invalid");
  }
  const refused = refuseChat(input, chatId);
  if (refused) {
    return refused;
  }
  const read = input.moderator?.readChatGuard;
  if (!read) {
    rejectChatGuard(input);
    return say(input, "command.invalid");
  }
  try {
    const guard = await read({ tenantId: input.event.tenantId, chatId });
    if (!isChatGuard(guard)) {
      rejectChatGuard(input);
      return say(input, "command.invalid");
    }
    return describeChatGuard(input, chatId, guard);
  } catch {
    rejectChatGuard(input);
    return say(input, "command.invalid");
  }
}

function isChatGuard(
  guard: ChatGuard,
): guard is ChatGuard & { readonly type: ChatKind } {
  return (
    isChatKind(guard.type) &&
    isPermissionState(guard.forum) &&
    isPermissionState(guard.directMessages) &&
    isPermissionState(guard.joinByRequest) &&
    isPermissionState(guard.joinToSend) &&
    isPermissionState(guard.nativeAntiSpam) &&
    isOptionalCount(guard.slowModeSeconds) &&
    isOptionalCount(guard.autoDeleteSeconds) &&
    isOptionalCount(guard.boostExemption) &&
    isOptionalCount(guard.paidStars) &&
    isPermissionState(guard.paidMedia) &&
    isPermissionState(guard.protectedContent) &&
    isPermissionState(guard.hiddenMembers) &&
    isPermissionState(guard.visibleHistory) &&
    isReactionCount(guard.maxReactions) &&
    isLinkedChat(guard.linkedChatId)
  );
}

function isChatKind(value: string): value is ChatKind {
  return (
    value === "private" ||
    value === "group" ||
    value === "supergroup" ||
    value === "channel"
  );
}

function isOptionalCount(value: number | null): boolean {
  return value === null || (Number.isSafeInteger(value) && value >= 0);
}

function isReactionCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isLinkedChat(value: string | null): boolean {
  return value === null || isTargetId(value);
}

function describeChatGuard(
  input: OperatorCommandInput,
  chatId: string,
  guard: ChatGuard & { readonly type: ChatKind },
): string {
  return [
    say(input, "command.guard.header", { chatId }),
    say(input, "command.guard.type", {
      type: say(input, chatKindKey(guard.type)),
    }),
    guardFlag(input, "command.guard.forum", guard.forum),
    guardFlag(input, "command.guard.direct", guard.directMessages),
    guardFlag(input, "command.guard.join_request", guard.joinByRequest),
    guardFlag(input, "command.guard.join_send", guard.joinToSend),
    guardFlag(input, "command.guard.native", guard.nativeAntiSpam),
    guardCount(
      input,
      guard.slowModeSeconds,
      "command.guard.slow",
      "command.guard.slow_unknown",
      "seconds",
    ),
    guardCount(
      input,
      guard.autoDeleteSeconds,
      "command.guard.autodelete",
      "command.guard.autodelete_unknown",
      "seconds",
    ),
    guardCount(
      input,
      guard.boostExemption,
      "command.guard.boost",
      "command.guard.boost_unknown",
      "count",
    ),
    guardCount(
      input,
      guard.paidStars,
      "command.guard.paid",
      "command.guard.paid_unknown",
      "stars",
    ),
    guardFlag(input, "command.guard.paid_media", guard.paidMedia),
    guardFlag(input, "command.guard.protected", guard.protectedContent),
    guardFlag(input, "command.guard.hidden", guard.hiddenMembers),
    guardFlag(input, "command.guard.history", guard.visibleHistory),
    say(input, "command.guard.reactions", { count: guard.maxReactions }),
    guard.linkedChatId === null
      ? say(input, "command.guard.linked_unknown")
      : say(input, "command.guard.linked", { id: guard.linkedChatId }),
  ].join("\n");
}

function chatKindKey(kind: ChatKind): MessageKey {
  if (kind === "private") {
    return "command.guard.type.private";
  }
  if (kind === "group") {
    return "command.guard.type.group";
  }
  if (kind === "supergroup") {
    return "command.guard.type.supergroup";
  }
  return "command.guard.type.channel";
}

function guardFlag(
  input: OperatorCommandInput,
  label: MessageKey,
  state: PermissionState,
): string {
  return `${say(input, label)} ${say(input, permissionStateKey(state))}`;
}

function guardCount(
  input: OperatorCommandInput,
  value: number | null,
  known: MessageKey,
  unknown: MessageKey,
  key: string,
): string {
  return value === null
    ? say(input, unknown)
    : say(input, known, { [key]: value });
}

function rejectChatGuard(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "guard",
  });
}

async function showJoinBot(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length !== 1) {
    return say(input, "command.joinbot.usage");
  }
  const chatId = args[0];
  if (chatId === undefined || !isTargetId(chatId)) {
    return say(input, "command.invalid");
  }
  const refused = refuseChat(input, chatId);
  if (refused) {
    return refused;
  }
  const read = input.moderator?.readJoinBot;
  if (!read) {
    rejectJoinBot(input);
    return say(input, "command.invalid");
  }
  try {
    const bot = await read({ tenantId: input.event.tenantId, chatId });
    if (!isJoinBot(bot)) {
      rejectJoinBot(input);
      return say(input, "command.invalid");
    }
    return describeJoinBot(input, chatId, bot);
  } catch {
    rejectJoinBot(input);
    return say(input, "command.invalid");
  }
}

function isJoinBot(bot: JoinBot): boolean {
  if (bot.id === null && bot.username === null) {
    return true;
  }
  return (
    bot.id !== null &&
    bot.username !== null &&
    isBotUserId(bot.id) &&
    isBotUsername(bot.username)
  );
}

function describeJoinBot(
  input: OperatorCommandInput,
  chatId: string,
  bot: JoinBot,
): string {
  const id =
    bot.id === null
      ? say(input, "command.joinbot.id_unknown")
      : say(input, "command.joinbot.id", { id: bot.id });
  const username =
    bot.username === null
      ? say(input, "command.joinbot.username_unknown")
      : bot.username.length === 0
        ? say(input, "command.joinbot.username_empty")
        : say(input, "command.joinbot.username", { username: bot.username });
  return [say(input, "command.joinbot.header", { chatId }), id, username].join(
    "\n",
  );
}

function rejectJoinBot(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "joinbot",
  });
}

async function showReactions(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length !== 1) {
    return say(input, "command.reactions.usage");
  }
  const chatId = args[0];
  if (chatId === undefined || !isTargetId(chatId)) {
    return say(input, "command.invalid");
  }
  const refused = refuseChat(input, chatId);
  if (refused) {
    return refused;
  }
  const read = input.moderator?.readReactions;
  if (!read) {
    rejectReactionAllowlist(input);
    return say(input, "command.invalid");
  }
  try {
    const allowlist = await read({ tenantId: input.event.tenantId, chatId });
    if (!isReactionAllowlist(allowlist)) {
      rejectReactionAllowlist(input);
      return say(input, "command.invalid");
    }
    return describeReactions(input, chatId, allowlist);
  } catch {
    rejectReactionAllowlist(input);
    return say(input, "command.invalid");
  }
}

function isReactionAllowlist(allowlist: ReactionAllowlist): boolean {
  return (
    allowlist.count === null ||
    (Number.isSafeInteger(allowlist.count) && allowlist.count >= 0)
  );
}

function describeReactions(
  input: OperatorCommandInput,
  chatId: string,
  allowlist: ReactionAllowlist,
): string {
  const count =
    allowlist.count === null
      ? say(input, "command.reactions.all")
      : say(input, "command.reactions.count", { count: allowlist.count });
  return [say(input, "command.reactions.header", { chatId }), count].join("\n");
}

function rejectReactionAllowlist(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "reactions",
  });
}

async function showCommunity(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length !== 1) {
    return say(input, "command.community.usage");
  }
  const chatId = args[0];
  if (chatId === undefined || !isTargetId(chatId)) {
    return say(input, "command.invalid");
  }
  const refused = refuseChat(input, chatId);
  if (refused) {
    return refused;
  }
  const read = input.moderator?.readCommunity;
  if (!read) {
    rejectCommunity(input);
    return say(input, "command.invalid");
  }
  try {
    const community = await read({ tenantId: input.event.tenantId, chatId });
    if (!isChatCommunity(community)) {
      rejectCommunity(input);
      return say(input, "command.invalid");
    }
    return describeCommunity(input, chatId, community);
  } catch {
    rejectCommunity(input);
    return say(input, "command.invalid");
  }
}

function isChatCommunity(community: ChatCommunity): boolean {
  return community.id === null || isBotUserId(community.id);
}

function describeCommunity(
  input: OperatorCommandInput,
  chatId: string,
  community: ChatCommunity,
): string {
  const id =
    community.id === null
      ? say(input, "command.community.none")
      : say(input, "command.community.id", { id: community.id });
  return [say(input, "command.community.header", { chatId }), id].join("\n");
}

function rejectCommunity(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "community",
  });
}

async function showCanStickers(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length !== 1) {
    return say(input, "command.canstickers.usage");
  }
  const chatId = args[0];
  if (chatId === undefined || !isTargetId(chatId)) {
    return say(input, "command.invalid");
  }
  const refused = refuseChat(input, chatId);
  if (refused) {
    return refused;
  }
  const read = input.moderator?.readStickerSetRight;
  if (!read) {
    rejectCanStickers(input);
    return say(input, "command.invalid");
  }
  try {
    const right = await read({ tenantId: input.event.tenantId, chatId });
    if (!isStickerSetRight(right)) {
      rejectCanStickers(input);
      return say(input, "command.invalid");
    }
    return describeCanStickers(input, chatId, right);
  } catch {
    rejectCanStickers(input);
    return say(input, "command.invalid");
  }
}

function isStickerSetRight(right: StickerSetRight): boolean {
  return isPermissionState(right.canSet);
}

function describeCanStickers(
  input: OperatorCommandInput,
  chatId: string,
  right: StickerSetRight,
): string {
  return [
    say(input, "command.canstickers.header", { chatId }),
    `${say(input, "command.canstickers.flag")} ${say(input, permissionStateKey(right.canSet))}`,
  ].join("\n");
}

function rejectCanStickers(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "canstickers",
  });
}

async function showParentChat(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length !== 1) {
    return say(input, "command.parent.usage");
  }
  const chatId = args[0];
  if (chatId === undefined || !isTargetId(chatId)) {
    return say(input, "command.invalid");
  }
  const refused = refuseChat(input, chatId);
  if (refused) {
    return refused;
  }
  const read = input.moderator?.readParentChat;
  if (!read) {
    rejectParentChat(input);
    return say(input, "command.invalid");
  }
  try {
    const parent = await read({ tenantId: input.event.tenantId, chatId });
    if (!isParentChat(parent)) {
      rejectParentChat(input);
      return say(input, "command.invalid");
    }
    return describeParentChat(input, chatId, parent);
  } catch {
    rejectParentChat(input);
    return say(input, "command.invalid");
  }
}

function isParentChat(parent: ParentChat): boolean {
  return parent.id === null || isTargetId(parent.id);
}

function describeParentChat(
  input: OperatorCommandInput,
  chatId: string,
  parent: ParentChat,
): string {
  const id =
    parent.id === null
      ? say(input, "command.parent.none")
      : say(input, "command.parent.id", { id: parent.id });
  return [say(input, "command.parent.header", { chatId }), id].join("\n");
}

function rejectParentChat(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "parent",
  });
}

async function showPersonalChat(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length !== 1) {
    return say(input, "command.personal.usage");
  }
  const chatId = args[0];
  if (chatId === undefined || !isTargetId(chatId)) {
    return say(input, "command.invalid");
  }
  const refused = refuseChat(input, chatId);
  if (refused) {
    return refused;
  }
  const read = input.moderator?.readPersonalChat;
  if (!read) {
    rejectPersonalChat(input);
    return say(input, "command.invalid");
  }
  try {
    const personal = await read({ tenantId: input.event.tenantId, chatId });
    if (!isPersonalChat(personal)) {
      rejectPersonalChat(input);
      return say(input, "command.invalid");
    }
    return describePersonalChat(input, chatId, personal);
  } catch {
    rejectPersonalChat(input);
    return say(input, "command.invalid");
  }
}

function isPersonalChat(personal: PersonalChat): boolean {
  return personal.id === null || isTargetId(personal.id);
}

function describePersonalChat(
  input: OperatorCommandInput,
  chatId: string,
  personal: PersonalChat,
): string {
  const id =
    personal.id === null
      ? say(input, "command.personal.none")
      : say(input, "command.personal.id", { id: personal.id });
  return [say(input, "command.personal.header", { chatId }), id].join("\n");
}

function rejectPersonalChat(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "personal",
  });
}

async function showPrivatePrivacy(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length !== 1) {
    return say(input, "command.privacy.usage");
  }
  const chatId = args[0];
  if (chatId === undefined || !isTargetId(chatId)) {
    return say(input, "command.invalid");
  }
  const refused = refuseChat(input, chatId);
  if (refused) {
    return refused;
  }
  const read = input.moderator?.readPrivatePrivacy;
  if (!read) {
    rejectPrivatePrivacy(input);
    return say(input, "command.invalid");
  }
  try {
    const privacy = await read({ tenantId: input.event.tenantId, chatId });
    if (!isPrivatePrivacy(privacy)) {
      rejectPrivatePrivacy(input);
      return say(input, "command.invalid");
    }
    return describePrivatePrivacy(input, chatId, privacy);
  } catch {
    rejectPrivatePrivacy(input);
    return say(input, "command.invalid");
  }
}

function isPrivatePrivacy(privacy: PrivatePrivacy): boolean {
  return (
    isPermissionState(privacy.privateForwards) &&
    isPermissionState(privacy.restrictedVoice)
  );
}

function describePrivatePrivacy(
  input: OperatorCommandInput,
  chatId: string,
  privacy: PrivatePrivacy,
): string {
  return [
    say(input, "command.privacy.header", { chatId }),
    `${say(input, "command.privacy.forwards")} ${say(input, permissionStateKey(privacy.privateForwards))}`,
    `${say(input, "command.privacy.voice")} ${say(input, permissionStateKey(privacy.restrictedVoice))}`,
  ].join("\n");
}

function rejectPrivatePrivacy(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "privacy",
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

async function banMemberFor(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length < 3) {
    return say(input, "command.banfor.usage");
  }
  if (args.length !== 3) {
    return say(input, "command.invalid");
  }
  const chatId = args[0];
  const actorId = args[1];
  const seconds = banSeconds(args[2]);
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
  const ban = input.moderator?.banActorFor;
  if (!ban) {
    rejectTimedBan(input);
    return say(input, "command.invalid");
  }
  try {
    await ban({
      tenantId: input.event.tenantId,
      chatId,
      actorId,
      durationSeconds: seconds,
    });
  } catch {
    rejectTimedBan(input);
    return say(input, "command.invalid");
  }
  return say(input, "command.banfor.done", { chatId, actorId, seconds });
}

function banSeconds(value: string | undefined): number | undefined {
  if (value === undefined || !/^[1-9]\d{0,7}$/.test(value)) {
    return undefined;
  }
  const seconds = Number(value);
  if (seconds < MIN_MUTE_SECONDS || seconds > MAX_MUTE_SECONDS) {
    return undefined;
  }
  return seconds;
}

function rejectTimedBan(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "banfor",
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

async function kickMember(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length !== 2) {
    return say(input, "command.kick.usage");
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
  const kick = input.moderator?.kickActor;
  if (!kick) {
    rejectKick(input);
    return say(input, "command.invalid");
  }
  try {
    const result = await kick({
      tenantId: input.event.tenantId,
      chatId,
      actorId,
    });
    if (result === "absent") {
      return say(input, "command.kick.absent", { chatId, actorId });
    }
    if (result === "admin") {
      return say(input, "command.kick.admin", { chatId, actorId });
    }
    if (result !== "removed") {
      rejectKick(input);
      return say(input, "command.invalid");
    }
  } catch {
    rejectKick(input);
    return say(input, "command.invalid");
  }
  return say(input, "command.kick.done", { chatId, actorId });
}

async function challengeMember(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<CommandReply> {
  if (args.length !== 2) {
    return say(input, "command.captcha.usage");
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
  const restrict = input.moderator?.restrictActor;
  const store = input.captcha;
  const clock = input.clock;
  const createNonce = input.createNonce;
  if (!restrict || !store || !clock || !createNonce) {
    rejectCaptcha(input);
    return say(input, "command.invalid");
  }
  const nonce = createNonce();
  if (!/^[a-f0-9]{16}$/.test(nonce)) {
    rejectCaptcha(input);
    return say(input, "command.invalid");
  }
  const savedTtl = await readChallengeTtl(input, chatId);
  if (savedTtl === undefined) {
    return say(input, "command.invalid");
  }
  const remove = input.moderator?.deleteMessage;
  try {
    await beginChallenge({
      event: input.event,
      chatId,
      actorId,
      ttlSeconds: savedTtl ?? CAPTCHA_TTL_SECONDS,
      nonce,
      ports: {
        store,
        storage: input.storage,
        restrict: (target) => restrict(target),
        release: () => Promise.reject(new Error("captcha_release")),
        clock,
        logger: input.logger,
        ...(remove
          ? {
              removePrompt: (target: {
                readonly tenantId: string;
                readonly chatId: string;
                readonly messageId: string;
              }) =>
                remove({
                  tenantId: target.tenantId,
                  chatId: target.chatId,
                  messageId: target.messageId,
                }),
            }
          : {}),
      },
    });
  } catch {
    rejectCaptcha(input);
    return say(input, "command.invalid");
  }
  return {
    text: say(input, "command.captcha.done", { chatId, actorId }),
    failureText: say(input, "command.invalid"),
    issuedChallenge: { chatId, actorId },
  };
}

async function releaseCaptcha(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length !== 2) {
    return say(input, "command.uncaptcha.usage");
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
  const store = input.captcha;
  const release = input.moderator?.releaseActor;
  if (!store || !release) {
    rejectUncaptcha(input);
    return say(input, "command.invalid");
  }
  let current: Awaited<ReturnType<CaptchaStore["get"]>>;
  try {
    current = await store.get(input.event.tenantId, chatId, actorId);
  } catch {
    rejectUncaptcha(input);
    return say(input, "command.invalid");
  }
  if (!current) {
    return say(input, "command.uncaptcha.absent", { chatId, actorId });
  }
  let taken: Awaited<ReturnType<CaptchaStore["take"]>>;
  try {
    taken = await store.take(
      current.tenantId,
      current.chatId,
      current.actorId,
      current.nonce,
    );
  } catch {
    rejectUncaptcha(input);
    return say(input, "command.invalid");
  }
  if (!taken) {
    return say(input, "command.uncaptcha.absent", { chatId, actorId });
  }
  try {
    await release({
      tenantId: taken.tenantId,
      chatId: taken.chatId,
      actorId: taken.actorId,
    });
  } catch {
    try {
      await store.put(taken);
    } catch {
      rejectUncaptcha(input);
    }
    rejectUncaptcha(input);
    return say(input, "command.invalid");
  }
  const messageId = taken.messageId;
  const remove = input.moderator?.deleteMessage;
  if (messageId !== undefined && remove) {
    try {
      await remove({
        tenantId: taken.tenantId,
        chatId: taken.chatId,
        messageId,
      });
    } catch {
      input.logger.warn("captcha_prompt_delete_failed", {
        eventId: input.event.id,
        chatId: taken.chatId,
      });
    }
  }
  return say(input, "command.uncaptcha.done", { chatId, actorId });
}

async function warnMember(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  const parsed = warnArgs(input, args, "command.warn.usage");
  if (typeof parsed === "string") {
    return parsed;
  }
  const store = input.warns;
  if (!store) {
    rejectWarn(input, "warn");
    return say(input, "command.invalid");
  }
  const target = {
    tenantId: input.event.tenantId,
    chatId: parsed.chatId,
    actorId: parsed.actorId,
  };
  const limit = await readChatWarnLimit(input, store, parsed.chatId, "warn");
  if (typeof limit === "string") {
    return limit;
  }
  let current = 0;
  try {
    current = await store.read(target);
  } catch {
    rejectWarn(input, "warn");
    return say(input, "command.invalid");
  }
  if (current >= limit) {
    return say(input, "command.warn.already", {
      chatId: parsed.chatId,
      actorId: parsed.actorId,
      limit,
    });
  }
  let next = 0;
  try {
    next = await store.increment(target);
  } catch {
    rejectWarn(input, "warn");
    return say(input, "command.invalid");
  }
  if (next < limit) {
    return say(input, "command.warn.counted", {
      chatId: parsed.chatId,
      actorId: parsed.actorId,
      count: next,
      limit,
    });
  }
  const ban = input.moderator?.banActor;
  if (!ban) {
    await restoreWarning(store, target, next - 1);
    rejectWarn(input, "warn");
    return say(input, "command.invalid");
  }
  try {
    await ban({
      tenantId: input.event.tenantId,
      chatId: parsed.chatId,
      actorId: parsed.actorId,
    });
  } catch {
    await restoreWarning(store, target, next - 1);
    rejectWarn(input, "warn");
    return say(input, "command.invalid");
  }
  return say(input, "command.warn.banned", {
    chatId: parsed.chatId,
    actorId: parsed.actorId,
  });
}

async function clearWarning(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  const parsed = warnArgs(input, args, "command.unwarn.usage");
  if (typeof parsed === "string") {
    return parsed;
  }
  const store = input.warns;
  if (!store) {
    rejectWarn(input, "unwarn");
    return say(input, "command.invalid");
  }
  let cleared = false;
  try {
    cleared = await store.clear({
      tenantId: input.event.tenantId,
      chatId: parsed.chatId,
      actorId: parsed.actorId,
    });
  } catch {
    rejectWarn(input, "unwarn");
    return say(input, "command.invalid");
  }
  if (!cleared) {
    return say(input, "command.unwarn.absent", {
      chatId: parsed.chatId,
      actorId: parsed.actorId,
    });
  }
  return say(input, "command.unwarn.done", {
    chatId: parsed.chatId,
    actorId: parsed.actorId,
  });
}

async function readWarnings(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length === 1) {
    return listWarnings(input, args[0] ?? "");
  }
  const parsed = warnArgs(input, args, "command.warns.usage");
  if (typeof parsed === "string") {
    return parsed;
  }
  const store = input.warns;
  if (!store) {
    rejectWarn(input, "warns");
    return say(input, "command.invalid");
  }
  let count = 0;
  try {
    count = await store.read({
      tenantId: input.event.tenantId,
      chatId: parsed.chatId,
      actorId: parsed.actorId,
    });
  } catch {
    rejectWarn(input, "warns");
    return say(input, "command.invalid");
  }
  if (count === 0) {
    return say(input, "command.warns.absent", {
      chatId: parsed.chatId,
      actorId: parsed.actorId,
    });
  }
  const limit = await readChatWarnLimit(input, store, parsed.chatId, "warns");
  if (typeof limit === "string") {
    return limit;
  }
  return say(input, "command.warns.count", {
    chatId: parsed.chatId,
    actorId: parsed.actorId,
    count,
    limit,
  });
}

async function listWarnings(
  input: OperatorCommandInput,
  chatId: string,
): Promise<string> {
  if (!isTargetId(chatId)) {
    return say(input, "command.invalid");
  }
  const refused = refuseChat(input, chatId);
  if (refused) {
    return refused;
  }
  const store = input.warns;
  if (!store) {
    rejectWarn(input, "warns");
    return say(input, "command.invalid");
  }
  let rows: readonly WarnCount[] = [];
  try {
    rows = await store.list(input.event.tenantId, chatId);
  } catch {
    rejectWarn(input, "warns");
    return say(input, "command.invalid");
  }
  if (rows.length === 0) {
    return say(input, "command.warns.empty", { chatId });
  }
  const limit = await readChatWarnLimit(input, store, chatId, "warns");
  if (typeof limit === "string") {
    return limit;
  }
  const lines = [chatId];
  for (const row of rows) {
    lines.push(`${row.actorId} ${row.count}/${limit}`);
  }
  return lines.join("\n");
}

async function setWarnLimit(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length < 1 || args.length > 2) {
    return say(input, "command.warnlimit.usage");
  }
  const chatId = args[0] ?? "";
  if (!isTargetId(chatId)) {
    return say(input, "command.invalid");
  }
  const refused = refuseChat(input, chatId);
  if (refused) {
    return refused;
  }
  const store = input.warns;
  if (!store) {
    rejectWarn(input, "warnlimit");
    return say(input, "command.invalid");
  }
  const requested = args[1];
  if (requested === undefined) {
    const limit = await readChatWarnLimit(input, store, chatId, "warnlimit");
    if (typeof limit === "string") {
      return limit;
    }
    return say(input, "command.warnlimit.show", { chatId, limit });
  }
  const limit = parseWarnLimit(requested);
  if (limit === undefined) {
    return say(input, "command.invalid");
  }
  try {
    await store.writeLimit(input.event.tenantId, chatId, limit);
  } catch {
    rejectWarn(input, "warnlimit");
    return say(input, "command.invalid");
  }
  return say(input, "command.warnlimit.done", { chatId, limit });
}

async function editReport(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length < 1 || args.length > 2) {
    return say(input, "command.report.usage");
  }
  const chatId = args[0] ?? "";
  if (!isTargetId(chatId)) {
    return say(input, "command.invalid");
  }
  const refused = refuseChat(input, chatId);
  if (refused) {
    return refused;
  }
  const requested = args[1];
  if (requested === undefined) {
    return formatReport(input, chatId);
  }
  if (requested === "reset") {
    const cleared = await removeReportChat(input, chatId);
    if (!cleared) {
      return say(input, "command.invalid");
    }
    return say(input, "command.report.default", { chatId });
  }
  if (!isTargetId(requested) || requested === chatId) {
    return say(input, "command.invalid");
  }
  const saved = await writeReportChat(input, chatId, requested);
  if (saved === "invalid") {
    return say(input, "command.invalid");
  }
  if (saved === "full") {
    input.logger.warn("report_chat_full", {
      eventId: input.event.id,
      chatId,
      command: "report",
    });
    return say(input, "command.invalid");
  }
  return say(input, "command.report.done", { chatId, targetId: requested });
}

async function formatReport(
  input: OperatorCommandInput,
  chatId: string,
): Promise<string> {
  const target = await readReportChat(input, chatId);
  if (target === undefined) {
    return say(input, "command.invalid");
  }
  if (target === null) {
    return say(input, "command.report.default", { chatId });
  }
  return say(input, "command.report.show", { chatId, targetId: target });
}

async function readReportChat(
  input: OperatorCommandInput,
  chatId: string,
): Promise<string | null | undefined> {
  try {
    return await input.runtime.getReportChat(input.event.tenantId, chatId);
  } catch {
    rejectReport(input);
    return undefined;
  }
}

async function writeReportChat(
  input: OperatorCommandInput,
  chatId: string,
  targetId: string,
): Promise<"ok" | "full" | "invalid"> {
  try {
    const saved = await input.runtime.setReportChat(
      input.event.tenantId,
      chatId,
      targetId,
    );
    return saved ? "ok" : "full";
  } catch {
    rejectReport(input);
    return "invalid";
  }
}

async function removeReportChat(
  input: OperatorCommandInput,
  chatId: string,
): Promise<boolean> {
  try {
    await input.runtime.clearReportChat(input.event.tenantId, chatId);
    return true;
  } catch {
    rejectReport(input);
    return false;
  }
}

function rejectReport(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "report",
  });
}

async function editFlood(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length < 1 || args.length > 3) {
    return say(input, "command.flood.usage");
  }
  const chatId = args[0] ?? "";
  if (!isTargetId(chatId)) {
    return say(input, "command.invalid");
  }
  const refused = refuseChat(input, chatId);
  if (refused) {
    return refused;
  }
  const requested = args[1];
  if (requested === undefined) {
    return formatFlood(input, chatId);
  }
  if (requested === "reset") {
    if (args.length !== 2) {
      return say(input, "command.flood.usage");
    }
    const cleared = await removeFloodPolicy(input, chatId);
    if (!cleared) {
      return say(input, "command.invalid");
    }
    return say(input, "command.flood.done", {
      chatId,
      threshold: FLOOD_THRESHOLD,
      windowSeconds: FLOOD_WINDOW_SECONDS,
    });
  }
  const threshold = parseFloodCount(requested);
  if (threshold === undefined) {
    return say(input, "command.invalid");
  }
  let windowSeconds = FLOOD_WINDOW_SECONDS;
  const seconds = args[2];
  if (seconds === undefined) {
    const current = await readFloodPolicy(input, chatId);
    if (current === undefined) {
      return say(input, "command.invalid");
    }
    windowSeconds = current?.windowSeconds ?? FLOOD_WINDOW_SECONDS;
  } else {
    const parsed = parseFloodWindow(seconds);
    if (parsed === undefined) {
      return say(input, "command.invalid");
    }
    windowSeconds = parsed;
  }
  const saved = await writeFloodPolicy(input, chatId, {
    threshold,
    windowSeconds,
  });
  if (saved === "invalid") {
    return say(input, "command.invalid");
  }
  if (saved === "full") {
    input.logger.warn("flood_policy_full", {
      eventId: input.event.id,
      chatId,
      command: "flood",
    });
    return say(input, "command.invalid");
  }
  return say(input, "command.flood.done", {
    chatId,
    threshold,
    windowSeconds,
  });
}

async function formatFlood(
  input: OperatorCommandInput,
  chatId: string,
): Promise<string> {
  const policy = await readFloodPolicy(input, chatId);
  if (policy === undefined) {
    return say(input, "command.invalid");
  }
  return say(input, "command.flood.show", {
    chatId,
    threshold: policy?.threshold ?? FLOOD_THRESHOLD,
    windowSeconds: policy?.windowSeconds ?? FLOOD_WINDOW_SECONDS,
  });
}

async function readFloodPolicy(
  input: OperatorCommandInput,
  chatId: string,
): Promise<FloodPolicy | null | undefined> {
  try {
    return await input.runtime.getFloodPolicy(input.event.tenantId, chatId);
  } catch {
    rejectFlood(input);
    return undefined;
  }
}

async function writeFloodPolicy(
  input: OperatorCommandInput,
  chatId: string,
  policy: FloodPolicy,
): Promise<"ok" | "full" | "invalid"> {
  try {
    const saved = await input.runtime.setFloodPolicy(
      input.event.tenantId,
      chatId,
      policy,
    );
    return saved ? "ok" : "full";
  } catch {
    rejectFlood(input);
    return "invalid";
  }
}

async function removeFloodPolicy(
  input: OperatorCommandInput,
  chatId: string,
): Promise<boolean> {
  try {
    await input.runtime.clearFloodPolicy(input.event.tenantId, chatId);
    return true;
  } catch {
    rejectFlood(input);
    return false;
  }
}

function rejectFlood(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "flood",
  });
}

function parseFloodCount(value: string): number | undefined {
  if (!/^(?:[2-9]|[12]\d|3[0-2])$/.test(value)) {
    return undefined;
  }
  return Number(value);
}

function parseFloodWindow(value: string): number | undefined {
  if (!/^(?:[1-9]\d?|[1-2]\d{2}|300)$/.test(value)) {
    return undefined;
  }
  return Number(value);
}

async function editRepeat(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length < 1 || args.length > 3) {
    return say(input, "command.repeat.usage");
  }
  const chatId = args[0] ?? "";
  if (!isTargetId(chatId)) {
    return say(input, "command.invalid");
  }
  const refused = refuseChat(input, chatId);
  if (refused) {
    return refused;
  }
  const requested = args[1];
  if (requested === undefined) {
    return formatRepeat(input, chatId);
  }
  if (requested === "reset") {
    if (args.length !== 2) {
      return say(input, "command.repeat.usage");
    }
    const cleared = await removeRepeatPolicy(input, chatId);
    if (!cleared) {
      return say(input, "command.invalid");
    }
    return say(input, "command.repeat.done", {
      chatId,
      threshold: REPEAT_THRESHOLD,
      windowSeconds: REPEAT_WINDOW_SECONDS,
    });
  }
  const threshold = parseFloodCount(requested);
  if (threshold === undefined) {
    return say(input, "command.invalid");
  }
  let windowSeconds = REPEAT_WINDOW_SECONDS;
  const seconds = args[2];
  if (seconds === undefined) {
    const current = await readRepeatPolicy(input, chatId);
    if (current === undefined) {
      return say(input, "command.invalid");
    }
    windowSeconds = current?.windowSeconds ?? REPEAT_WINDOW_SECONDS;
  } else {
    const parsed = parseFloodWindow(seconds);
    if (parsed === undefined) {
      return say(input, "command.invalid");
    }
    windowSeconds = parsed;
  }
  const saved = await writeRepeatPolicy(input, chatId, {
    threshold,
    windowSeconds,
  });
  if (saved === "invalid") {
    return say(input, "command.invalid");
  }
  if (saved === "full") {
    input.logger.warn("repeat_policy_full", {
      eventId: input.event.id,
      chatId,
      command: "repeat",
    });
    return say(input, "command.invalid");
  }
  return say(input, "command.repeat.done", {
    chatId,
    threshold,
    windowSeconds,
  });
}

async function formatRepeat(
  input: OperatorCommandInput,
  chatId: string,
): Promise<string> {
  const policy = await readRepeatPolicy(input, chatId);
  if (policy === undefined) {
    return say(input, "command.invalid");
  }
  return say(input, "command.repeat.show", {
    chatId,
    threshold: policy?.threshold ?? REPEAT_THRESHOLD,
    windowSeconds: policy?.windowSeconds ?? REPEAT_WINDOW_SECONDS,
  });
}

async function readRepeatPolicy(
  input: OperatorCommandInput,
  chatId: string,
): Promise<RepeatPolicy | null | undefined> {
  try {
    return await input.runtime.getRepeatPolicy(input.event.tenantId, chatId);
  } catch {
    rejectRepeat(input);
    return undefined;
  }
}

async function writeRepeatPolicy(
  input: OperatorCommandInput,
  chatId: string,
  policy: RepeatPolicy,
): Promise<"ok" | "full" | "invalid"> {
  try {
    const saved = await input.runtime.setRepeatPolicy(
      input.event.tenantId,
      chatId,
      policy,
    );
    return saved ? "ok" : "full";
  } catch {
    rejectRepeat(input);
    return "invalid";
  }
}

async function removeRepeatPolicy(
  input: OperatorCommandInput,
  chatId: string,
): Promise<boolean> {
  try {
    await input.runtime.clearRepeatPolicy(input.event.tenantId, chatId);
    return true;
  } catch {
    rejectRepeat(input);
    return false;
  }
}

function rejectRepeat(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "repeat",
  });
}

async function editRuleMute(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length < 1 || args.length > 2) {
    return say(input, "command.rulemute.usage");
  }
  const chatId = args[0] ?? "";
  if (!isTargetId(chatId)) {
    return say(input, "command.invalid");
  }
  const refused = refuseChat(input, chatId);
  if (refused) {
    return refused;
  }
  const requested = args[1];
  if (requested === undefined) {
    return formatRuleMute(input, chatId);
  }
  if (requested === "reset") {
    const cleared = await removeMuteDuration(input, chatId);
    if (!cleared) {
      return say(input, "command.invalid");
    }
    return say(input, "command.rulemute.done", {
      chatId,
      seconds: MUTE_DURATION_SECONDS,
    });
  }
  const seconds = parseRuleMuteSeconds(requested);
  if (seconds === undefined) {
    return say(input, "command.invalid");
  }
  const saved = await writeMuteDuration(input, chatId, seconds);
  if (saved === "invalid") {
    return say(input, "command.invalid");
  }
  if (saved === "full") {
    input.logger.warn("mute_duration_full", {
      eventId: input.event.id,
      chatId,
      command: "rulemute",
    });
    return say(input, "command.invalid");
  }
  return say(input, "command.rulemute.done", { chatId, seconds });
}

async function formatRuleMute(
  input: OperatorCommandInput,
  chatId: string,
): Promise<string> {
  const seconds = await readMuteDuration(input, chatId);
  if (seconds === undefined) {
    return say(input, "command.invalid");
  }
  return say(input, "command.rulemute.show", {
    chatId,
    seconds: seconds ?? MUTE_DURATION_SECONDS,
  });
}

async function readMuteDuration(
  input: OperatorCommandInput,
  chatId: string,
): Promise<number | null | undefined> {
  try {
    return await input.runtime.getMuteDuration(input.event.tenantId, chatId);
  } catch {
    rejectRuleMute(input);
    return undefined;
  }
}

async function writeMuteDuration(
  input: OperatorCommandInput,
  chatId: string,
  seconds: number,
): Promise<"ok" | "full" | "invalid"> {
  try {
    const saved = await input.runtime.setMuteDuration(
      input.event.tenantId,
      chatId,
      seconds,
    );
    return saved ? "ok" : "full";
  } catch {
    rejectRuleMute(input);
    return "invalid";
  }
}

async function removeMuteDuration(
  input: OperatorCommandInput,
  chatId: string,
): Promise<boolean> {
  try {
    await input.runtime.clearMuteDuration(input.event.tenantId, chatId);
    return true;
  } catch {
    rejectRuleMute(input);
    return false;
  }
}

function rejectRuleMute(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "rulemute",
  });
}

function parseRuleMuteSeconds(value: string): number | undefined {
  if (!/^[1-9]\d{0,7}$/.test(value)) {
    return undefined;
  }
  const seconds = Number(value);
  if (
    seconds < MIN_MUTE_DURATION_SECONDS ||
    seconds > MAX_MUTE_DURATION_SECONDS
  ) {
    return undefined;
  }
  return seconds;
}

async function readChallengeTtl(
  input: OperatorCommandInput,
  chatId: string,
): Promise<number | null | undefined> {
  try {
    return await input.runtime.getCaptchaTtl(input.event.tenantId, chatId);
  } catch {
    rejectCaptcha(input);
    return undefined;
  }
}

async function editVerifyFor(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length < 1 || args.length > 2) {
    return say(input, "command.verifyfor.usage");
  }
  const chatId = args[0] ?? "";
  if (!isTargetId(chatId)) {
    return say(input, "command.invalid");
  }
  const refused = refuseChat(input, chatId);
  if (refused) {
    return refused;
  }
  const requested = args[1];
  if (requested === undefined) {
    return formatVerifyFor(input, chatId);
  }
  if (requested === "reset") {
    const cleared = await removeCaptchaTtl(input, chatId);
    if (!cleared) {
      return say(input, "command.invalid");
    }
    return say(input, "command.verifyfor.done", {
      chatId,
      seconds: CAPTCHA_TTL_SECONDS,
    });
  }
  const seconds = parseVerifySeconds(requested);
  if (seconds === undefined) {
    return say(input, "command.invalid");
  }
  const saved = await writeCaptchaTtl(input, chatId, seconds);
  if (saved === "invalid") {
    return say(input, "command.invalid");
  }
  if (saved === "full") {
    input.logger.warn("captcha_ttl_full", {
      eventId: input.event.id,
      chatId,
      command: "verifyfor",
    });
    return say(input, "command.invalid");
  }
  return say(input, "command.verifyfor.done", { chatId, seconds });
}

async function formatVerifyFor(
  input: OperatorCommandInput,
  chatId: string,
): Promise<string> {
  const seconds = await readCaptchaTtl(input, chatId);
  if (seconds === undefined) {
    return say(input, "command.invalid");
  }
  return say(input, "command.verifyfor.show", {
    chatId,
    seconds: seconds ?? CAPTCHA_TTL_SECONDS,
  });
}

async function readCaptchaTtl(
  input: OperatorCommandInput,
  chatId: string,
): Promise<number | null | undefined> {
  try {
    return await input.runtime.getCaptchaTtl(input.event.tenantId, chatId);
  } catch {
    rejectVerifyFor(input);
    return undefined;
  }
}

async function writeCaptchaTtl(
  input: OperatorCommandInput,
  chatId: string,
  seconds: number,
): Promise<"ok" | "full" | "invalid"> {
  try {
    const saved = await input.runtime.setCaptchaTtl(
      input.event.tenantId,
      chatId,
      seconds,
    );
    return saved ? "ok" : "full";
  } catch {
    rejectVerifyFor(input);
    return "invalid";
  }
}

async function removeCaptchaTtl(
  input: OperatorCommandInput,
  chatId: string,
): Promise<boolean> {
  try {
    await input.runtime.clearCaptchaTtl(input.event.tenantId, chatId);
    return true;
  } catch {
    rejectVerifyFor(input);
    return false;
  }
}

function rejectVerifyFor(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "verifyfor",
  });
}

function parseVerifySeconds(value: string): number | undefined {
  if (!/^[1-9]\d{0,4}$/.test(value)) {
    return undefined;
  }
  const seconds = Number(value);
  if (seconds < MIN_CAPTCHA_TTL_SECONDS || seconds > MAX_CAPTCHA_TTL_SECONDS) {
    return undefined;
  }
  return seconds;
}

async function editVerifyFail(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length < 1 || args.length > 2) {
    return say(input, "command.verifyfail.usage");
  }
  const chatId = args[0] ?? "";
  if (!isTargetId(chatId)) {
    return say(input, "command.invalid");
  }
  const refused = refuseChat(input, chatId);
  if (refused) {
    return refused;
  }
  const requested = args[1];
  if (requested === undefined) {
    return formatVerifyFail(input, chatId);
  }
  if (requested === "reset") {
    const cleared = await removeCaptchaFail(input, chatId);
    if (!cleared) {
      return say(input, "command.invalid");
    }
    return say(input, "command.verifyfail.done", {
      chatId,
      action: failWord(input, "stay"),
    });
  }
  const action = parseFailAction(requested);
  if (action === undefined) {
    return say(input, "command.invalid");
  }
  const saved = await writeCaptchaFail(input, chatId, action);
  if (saved === "invalid") {
    return say(input, "command.invalid");
  }
  if (saved === "full") {
    input.logger.warn("captcha_fail_full", {
      eventId: input.event.id,
      chatId,
      command: "verifyfail",
    });
    return say(input, "command.invalid");
  }
  return say(input, "command.verifyfail.done", {
    chatId,
    action: failWord(input, action),
  });
}

async function formatVerifyFail(
  input: OperatorCommandInput,
  chatId: string,
): Promise<string> {
  const action = await readCaptchaFail(input, chatId);
  if (action === undefined) {
    return say(input, "command.invalid");
  }
  return say(input, "command.verifyfail.show", {
    chatId,
    action: failWord(input, action ?? "stay"),
  });
}

async function readCaptchaFail(
  input: OperatorCommandInput,
  chatId: string,
): Promise<"kick" | "ban" | null | undefined> {
  try {
    return await input.runtime.getCaptchaFail(input.event.tenantId, chatId);
  } catch {
    rejectVerifyFail(input);
    return undefined;
  }
}

async function writeCaptchaFail(
  input: OperatorCommandInput,
  chatId: string,
  action: "stay" | "kick" | "ban",
): Promise<"ok" | "full" | "invalid"> {
  try {
    const saved = await input.runtime.setCaptchaFail(
      input.event.tenantId,
      chatId,
      action,
    );
    return saved ? "ok" : "full";
  } catch {
    rejectVerifyFail(input);
    return "invalid";
  }
}

async function removeCaptchaFail(
  input: OperatorCommandInput,
  chatId: string,
): Promise<boolean> {
  try {
    await input.runtime.clearCaptchaFail(input.event.tenantId, chatId);
    return true;
  } catch {
    rejectVerifyFail(input);
    return false;
  }
}

function rejectVerifyFail(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "verifyfail",
  });
}

function parseFailAction(value: string): "stay" | "kick" | "ban" | undefined {
  if (value === "stay" || value === "kick" || value === "ban") {
    return value;
  }
  return undefined;
}

function failWord(
  input: OperatorCommandInput,
  action: "stay" | "kick" | "ban",
): string {
  return say(input, `command.verifyfail.${action}`);
}

async function editAllowHost(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length < 1 || args.length > 3) {
    return say(input, "command.allowhost.usage");
  }
  const chatId = args[0] ?? "";
  if (!isTargetId(chatId)) {
    return say(input, "command.invalid");
  }
  const refused = refuseChat(input, chatId);
  if (refused) {
    return refused;
  }
  const op = args[1];
  if (op === undefined) {
    return formatAllowHosts(input, chatId);
  }
  if (op === "reset") {
    if (args.length !== 2) {
      return say(input, "command.allowhost.usage");
    }
    const cleared = await clearAllowHostList(input, chatId);
    if (!cleared) {
      return say(input, "command.invalid");
    }
    return say(input, "command.allowhost.show", { chatId, count: 0 });
  }
  if (op === "skip") {
    if (args.length !== 3) {
      return say(input, "command.invalid");
    }
    const count = rulesSkipCount(args[2] ?? "");
    if (count === undefined) {
      return say(input, "command.invalid");
    }
    return formatAllowHosts(input, chatId, count);
  }
  if ((op !== "add" && op !== "remove") || args.length !== 3) {
    return say(input, "command.allowhost.usage");
  }
  const host = normalizeAllowHost(args[2] ?? "");
  if (host === null) {
    return say(input, "command.invalid");
  }
  if (op === "remove") {
    const removed = await dropAllowHost(input, chatId, host);
    if (removed === undefined) {
      return say(input, "command.invalid");
    }
    if (!removed) {
      return say(input, "command.allowhost.absent");
    }
    const list = await readAllowHosts(input, chatId);
    if (list === undefined) {
      return say(input, "command.invalid");
    }
    return say(input, "command.allowhost.removed", {
      chatId,
      count: list.length,
    });
  }
  const saved = await writeAllowHost(input, chatId, host);
  if (saved === "invalid") {
    return say(input, "command.invalid");
  }
  if (saved === "full") {
    input.logger.warn("allow_host_full", {
      eventId: input.event.id,
      chatId,
      command: "allowhost",
    });
    return say(input, "command.invalid");
  }
  const list = await readAllowHosts(input, chatId);
  if (list === undefined) {
    return say(input, "command.invalid");
  }
  return say(input, "command.allowhost.added", { chatId, count: list.length });
}

async function formatAllowHosts(
  input: OperatorCommandInput,
  chatId: string,
  skip = 0,
): Promise<string> {
  const list = await readAllowHosts(input, chatId);
  if (list === undefined) {
    return say(input, "command.invalid");
  }
  const header = say(input, "command.allowhost.show", {
    chatId,
    count: list.length,
  });
  if (list.length === 0) {
    if (skip > 0) {
      return say(input, "command.invalid");
    }
    return header;
  }
  if (skip >= list.length) {
    return say(input, "command.invalid");
  }
  return fitAdministratorLines(header, list.slice(skip), (count) =>
    say(input, "command.allowhost.more", { count }),
  );
}

async function readAllowHosts(
  input: OperatorCommandInput,
  chatId: string,
): Promise<readonly string[] | undefined> {
  try {
    return await input.runtime.listAllowHosts(input.event.tenantId, chatId);
  } catch {
    rejectAllowHost(input);
    return undefined;
  }
}

async function writeAllowHost(
  input: OperatorCommandInput,
  chatId: string,
  host: string,
): Promise<"ok" | "full" | "invalid"> {
  try {
    const saved = await input.runtime.addAllowHost(
      input.event.tenantId,
      chatId,
      host,
    );
    return saved ? "ok" : "full";
  } catch {
    rejectAllowHost(input);
    return "invalid";
  }
}

async function dropAllowHost(
  input: OperatorCommandInput,
  chatId: string,
  host: string,
): Promise<boolean | undefined> {
  try {
    return await input.runtime.removeAllowHost(
      input.event.tenantId,
      chatId,
      host,
    );
  } catch {
    rejectAllowHost(input);
    return undefined;
  }
}

async function clearAllowHostList(
  input: OperatorCommandInput,
  chatId: string,
): Promise<boolean> {
  try {
    await input.runtime.clearAllowHosts(input.event.tenantId, chatId);
    return true;
  } catch {
    rejectAllowHost(input);
    return false;
  }
}

function rejectAllowHost(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "allowhost",
  });
}

async function editKeyword(
  input: OperatorCommandInput,
  args: readonly string[],
): Promise<string> {
  if (args.length < 1 || args.length > 3) {
    return say(input, "command.keyword.usage");
  }
  const chatId = args[0] ?? "";
  if (!isTargetId(chatId)) {
    return say(input, "command.invalid");
  }
  const refused = refuseChat(input, chatId);
  if (refused) {
    return refused;
  }
  const op = args[1];
  if (op === undefined) {
    return formatKeywords(input, chatId);
  }
  if (op === "reset") {
    if (args.length !== 2) {
      return say(input, "command.keyword.usage");
    }
    const cleared = await clearKeywordList(input, chatId);
    if (!cleared) {
      return say(input, "command.invalid");
    }
    return say(input, "command.keyword.show", { chatId, count: 0 });
  }
  if ((op !== "add" && op !== "remove") || args.length !== 3) {
    return say(input, "command.keyword.usage");
  }
  const keyword = normalizeChatKeyword(args[2] ?? "");
  if (keyword === null) {
    return say(input, "command.invalid");
  }
  if (op === "remove") {
    const removed = await dropKeyword(input, chatId, keyword);
    if (removed === undefined) {
      return say(input, "command.invalid");
    }
    if (!removed) {
      return say(input, "command.keyword.absent");
    }
    const list = await readKeywords(input, chatId);
    if (list === undefined) {
      return say(input, "command.invalid");
    }
    return say(input, "command.keyword.removed", {
      chatId,
      count: list.length,
    });
  }
  const saved = await writeKeyword(input, chatId, keyword);
  if (saved === "invalid") {
    return say(input, "command.invalid");
  }
  if (saved === "full") {
    input.logger.warn("keyword_full", {
      eventId: input.event.id,
      chatId,
      command: "keyword",
    });
    return say(input, "command.invalid");
  }
  const list = await readKeywords(input, chatId);
  if (list === undefined) {
    return say(input, "command.invalid");
  }
  return say(input, "command.keyword.added", { chatId, count: list.length });
}

async function formatKeywords(
  input: OperatorCommandInput,
  chatId: string,
): Promise<string> {
  const list = await readKeywords(input, chatId);
  if (list === undefined) {
    return say(input, "command.invalid");
  }
  const header = say(input, "command.keyword.show", {
    chatId,
    count: list.length,
  });
  if (list.length === 0) {
    return header;
  }
  return [header, ...list].join("\n");
}

async function readKeywords(
  input: OperatorCommandInput,
  chatId: string,
): Promise<readonly string[] | undefined> {
  try {
    return await input.runtime.listKeywords(input.event.tenantId, chatId);
  } catch {
    rejectKeyword(input);
    return undefined;
  }
}

async function writeKeyword(
  input: OperatorCommandInput,
  chatId: string,
  keyword: string,
): Promise<"ok" | "full" | "invalid"> {
  try {
    const saved = await input.runtime.addKeyword(
      input.event.tenantId,
      chatId,
      keyword,
    );
    return saved ? "ok" : "full";
  } catch {
    rejectKeyword(input);
    return "invalid";
  }
}

async function dropKeyword(
  input: OperatorCommandInput,
  chatId: string,
  keyword: string,
): Promise<boolean | undefined> {
  try {
    return await input.runtime.removeKeyword(
      input.event.tenantId,
      chatId,
      keyword,
    );
  } catch {
    rejectKeyword(input);
    return undefined;
  }
}

async function clearKeywordList(
  input: OperatorCommandInput,
  chatId: string,
): Promise<boolean> {
  try {
    await input.runtime.clearKeywords(input.event.tenantId, chatId);
    return true;
  } catch {
    rejectKeyword(input);
    return false;
  }
}

function rejectKeyword(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "keyword",
  });
}

function parseWarnLimit(value: string): number | undefined {
  if (value === "reset") {
    return WARN_LIMIT;
  }
  if (!/^(?:[1-9]|10)$/.test(value)) {
    return undefined;
  }
  return Number(value);
}

async function readChatWarnLimit(
  input: OperatorCommandInput,
  store: WarnStore,
  chatId: string,
  command: "warn" | "warns" | "warnlimit",
): Promise<number | string> {
  try {
    return normalizeWarnLimit(
      await store.readLimit(input.event.tenantId, chatId),
    );
  } catch {
    rejectWarn(input, command);
    return say(input, "command.invalid");
  }
}

function warnArgs(
  input: OperatorCommandInput,
  args: readonly string[],
  usage: MessageKey,
): { readonly chatId: string; readonly actorId: string } | string {
  if (args.length !== 2) {
    return say(input, usage);
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
  return { chatId, actorId };
}

async function restoreWarning(
  store: WarnStore,
  target: {
    readonly tenantId: string;
    readonly chatId: string;
    readonly actorId: string;
  },
  count: number,
): Promise<void> {
  try {
    await store.write(target, count);
  } catch {
    return;
  }
}

function rejectWarn(
  input: OperatorCommandInput,
  command: "warn" | "unwarn" | "warns" | "warnlimit",
): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command,
  });
}

function rejectUncaptcha(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "uncaptcha",
  });
}

function rejectCaptcha(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "captcha",
  });
}

function rejectKick(input: OperatorCommandInput): void {
  input.logger.warn("operator_rejected", {
    eventId: input.event.id,
    chatId: input.event.chatId,
    command: "kick",
  });
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
  if (mode !== undefined && !isRuleMode(mode)) {
    return say(input, "command.rule.usage");
  }
  const tenantId = input.event.tenantId;
  const switches = await readRuleSwitches(input, parsed.chatId);
  if (!switches) {
    return say(input, "command.invalid");
  }
  const actions = await readRuleActions(input, parsed.chatId);
  if (!actions) {
    return say(input, "command.invalid");
  }
  const rules = await loadRuleSet({
    tenantId,
    chatId: parsed.chatId,
    cache: input.cache,
    source: input.source,
    logger: input.logger,
    switches,
    actions,
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
  } else if (mode === "file") {
    const cleared = await removeRuleAction(input, parsed.chatId, parsed.ruleId);
    if (!cleared) {
      return say(input, "command.invalid");
    }
  } else if (mode !== undefined && isPunitiveRuleAction(mode)) {
    const saved = await writeRuleAction(
      input,
      parsed.chatId,
      parsed.ruleId,
      mode,
    );
    if (saved === "invalid") {
      return say(input, "command.invalid");
    }
    if (saved === "full") {
      input.logger.warn("rule_action_full", {
        eventId: input.event.id,
        chatId: parsed.chatId,
        command: "rule",
      });
      return say(input, "command.invalid");
    }
  }
  return formatRule(input, parsed.chatId, parsed.ruleId);
}

function isRuleMode(mode: string): boolean {
  return (
    mode === "on" ||
    mode === "off" ||
    mode === "reset" ||
    mode === "file" ||
    isPunitiveRuleAction(mode)
  );
}

function isPunitiveRuleAction(
  mode: string,
): mode is RuleActionOverride["action"] {
  return (punitiveActions as readonly string[]).includes(mode);
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

async function readRuleActions(
  input: OperatorCommandInput,
  chatId: string,
): Promise<readonly RuleActionOverride[] | null> {
  try {
    return await input.runtime.listRuleActions(input.event.tenantId, chatId);
  } catch {
    rejectRule(input);
    return null;
  }
}

async function writeRuleAction(
  input: OperatorCommandInput,
  chatId: string,
  ruleId: string,
  action: RuleActionOverride["action"],
): Promise<"ok" | "full" | "invalid"> {
  try {
    const saved = await input.runtime.setRuleAction(
      input.event.tenantId,
      chatId,
      ruleId,
      action,
    );
    return saved ? "ok" : "full";
  } catch {
    rejectRule(input);
    return "invalid";
  }
}

async function removeRuleAction(
  input: OperatorCommandInput,
  chatId: string,
  ruleId: string,
): Promise<boolean> {
  try {
    await input.runtime.clearRuleAction(input.event.tenantId, chatId, ruleId);
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
  const actions = await readRuleActions(input, chatId);
  if (!actions) {
    return say(input, "command.invalid");
  }
  const rules = await loadRuleSet({
    tenantId: input.event.tenantId,
    chatId,
    cache: input.cache,
    source: input.source,
    logger: input.logger,
    switches,
    actions,
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
    actions: rule.actions.join(","),
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
  skip = 0,
): string {
  const ids = policy.allowActorIds;
  if (skip > 0 && (ids.length === 0 || skip >= ids.length)) {
    return say(input, "command.invalid");
  }
  const window = ids.slice(skip);
  const full = policyBody(input, chatId, policy, window);
  if (window.length === 0 || full.length <= EXPORT_REPLY_LIMIT) {
    return full;
  }
  let best = policyBody(input, chatId, policy, [], window.length);
  let low = 0;
  let high = window.length - 1;
  while (low <= high) {
    const count = Math.floor((low + high) / 2);
    const text = policyBody(
      input,
      chatId,
      policy,
      window.slice(0, count),
      window.length - count,
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
  const parsed = parseChatsArgs(args);
  if (parsed === "usage") {
    return say(input, "command.chats.usage");
  }
  if (parsed === "invalid") {
    return say(input, "command.invalid");
  }
  const directory = input.chats;
  if (!directory) {
    return say(input, "command.chats.disabled");
  }
  if (parsed.kind === "operators") {
    const refused = refuseChat(input, parsed.chatId);
    if (refused) {
      return refused;
    }
    try {
      const actors = await directory.operators(
        input.event.tenantId,
        parsed.chatId,
      );
      const listed =
        actors.length === 0
          ? say(input, "command.chats.empty")
          : actors.join("\n");
      return say(input, "command.chats.operators", {
        chatId: parsed.chatId,
        actors: listed,
      });
    } catch {
      input.logger.warn("operator_rejected", {
        eventId: input.event.id,
        chatId: input.event.chatId,
        command: "chats",
      });
      return say(input, "command.invalid");
    }
  }
  const scope = scopeOf(input);
  try {
    const ids = scope.all
      ? await directory.list(input.event.tenantId)
      : scope.ids;
    if (ids.length === 0) {
      if (parsed.skip > 0) {
        return say(input, "command.invalid");
      }
      return say(input, "command.chats.empty");
    }
    if (parsed.skip >= ids.length) {
      return say(input, "command.invalid");
    }
    const lines: string[] = [];
    for (const id of ids.slice(parsed.skip)) {
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

function parseChatsArgs(
  args: readonly string[],
):
  | "usage"
  | "invalid"
  | { readonly kind: "list"; readonly skip: number }
  | { readonly kind: "operators"; readonly chatId: string } {
  if (args.length === 0) {
    return { kind: "list", skip: 0 };
  }
  const first = args[0];
  if (first !== undefined && isTargetId(first)) {
    return args.length === 1 ? { kind: "operators", chatId: first } : "usage";
  }
  if (first !== "skip") {
    return "usage";
  }
  const countToken = args[1];
  if (countToken === undefined) {
    return "invalid";
  }
  const count = rulesSkipCount(countToken);
  if (count === undefined || args.length !== 2) {
    return count === undefined && args.length === 2 ? "invalid" : "usage";
  }
  return { kind: "list", skip: count };
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
