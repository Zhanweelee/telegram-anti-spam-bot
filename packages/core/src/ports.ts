import { z } from "zod";
import { decisionActionSchema } from "./decision.js";
import { evidenceSchema } from "./evidence.js";
import { assertNoRawContent } from "./privacy.js";
import type { RuleSet } from "./rule.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const isoSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/);

export const auditRecordSchema = z.strictObject({
  tenantId: z.string().min(1),
  chatId: z.string().min(1),
  eventId: z.string().min(1),
  messageId: z.string().min(1).optional(),
  textSha256: sha256Schema.optional(),
  action: decisionActionSchema,
  score: z.number().min(0),
  reasons: z.array(z.string()),
  evidence: z.array(evidenceSchema),
  ruleIds: z.array(z.string()),
  createdAt: isoSchema,
});

export type AuditRecord = z.output<typeof auditRecordSchema>;

export const auditQuerySchema = z.strictObject({
  tenantId: z.string().min(1),
  chatId: z.string().min(1).optional(),
  limit: z.number().int().positive().max(100),
});

export type AuditQuery = z.output<typeof auditQuerySchema>;

export const auditScopeSchema = z.strictObject({
  tenantId: z.string().min(1),
  chatId: z.string().min(1).optional(),
});

export type AuditScope = z.output<typeof auditScopeSchema>;

export interface Storage {
  appendAudit(record: AuditRecord): Promise<void>;
  /** Inserts the row. Returns false when that event already has an audit. */
  claimAudit(record: AuditRecord): Promise<boolean>;
  putAuditsIfAbsent(records: readonly AuditRecord[]): Promise<void>;
  /** Newest `limit` rows, oldest of that page first. */
  listAudits(query: AuditQuery): Promise<readonly AuditRecord[]>;
  getAudit(
    tenantId: string,
    chatId: string,
    eventId: string,
  ): Promise<AuditRecord | null>;
  exportAudits(scope: AuditScope): Promise<readonly AuditRecord[]>;
  countAudits(scope: AuditScope): Promise<number>;
  deleteAudits(scope: AuditScope): Promise<number>;
  getRuleSet(tenantId: string, chatId: string): Promise<RuleSet | null>;
  putRuleSet(tenantId: string, chatId: string, rules: RuleSet): Promise<void>;
}

export interface DeleteMessagesTarget {
  readonly tenantId: string;
  readonly chatId: string;
  readonly messageIds: readonly string[];
}

export interface DeleteTarget {
  readonly tenantId: string;
  readonly chatId: string;
  readonly messageId: string;
  /** Set when only this user can see the message. */
  readonly audienceId?: string;
}

export interface MuteTarget {
  readonly tenantId: string;
  readonly chatId: string;
  readonly actorId: string;
  readonly durationSeconds: number;
}

export interface BanTarget {
  readonly tenantId: string;
  readonly chatId: string;
  readonly actorId: string;
}

export interface ChatTarget {
  readonly tenantId: string;
  readonly chatId: string;
}

export interface ChatStickerSetTarget {
  readonly tenantId: string;
  readonly chatId: string;
  readonly name: string;
}

export interface ChatTitleTarget {
  readonly tenantId: string;
  readonly chatId: string;
  readonly title: string;
}

export interface ChatDescriptionTarget {
  readonly tenantId: string;
  readonly chatId: string;
  readonly description: string;
}

export const administratorRights = [
  "manageChat",
  "deleteMessages",
  "manageVideoChats",
  "restrictMembers",
  "promoteMembers",
  "changeInfo",
  "inviteUsers",
  "postStories",
  "editStories",
  "deleteStories",
  "postMessages",
  "editMessages",
  "pinMessages",
  "manageTopics",
  "manageDirectMessages",
  "manageTags",
  "sendWelcomeMessages",
] as const;

export type AdministratorRight = (typeof administratorRights)[number];

export interface ChatAdministrator {
  readonly actorId: string;
  readonly bot: boolean;
  readonly role: "creator" | "administrator";
  readonly anonymous: boolean;
  readonly rights: readonly AdministratorRight[];
}

export type PermissionState = "on" | "off" | "unknown";

export interface DefaultChatPermissions {
  readonly sendMessages: PermissionState;
  readonly sendAudios: PermissionState;
  readonly sendDocuments: PermissionState;
  readonly sendPhotos: PermissionState;
  readonly sendVideos: PermissionState;
  readonly sendVideoNotes: PermissionState;
  readonly sendVoiceNotes: PermissionState;
  readonly sendPolls: PermissionState;
  readonly sendOtherMessages: PermissionState;
  readonly addWebPagePreviews: PermissionState;
  readonly reactToMessages: PermissionState;
  readonly editTag: PermissionState;
  readonly changeInfo: PermissionState;
  readonly inviteUsers: PermissionState;
  readonly pinMessages: PermissionState;
  readonly manageTopics: PermissionState;
}

export interface SenderChatTarget {
  readonly tenantId: string;
  readonly chatId: string;
  readonly senderChatId: string;
}

export interface ReactionActorTarget {
  readonly tenantId: string;
  readonly chatId: string;
  readonly actorId: string;
  readonly kind: "user" | "chat";
}

export interface AdminTitleTarget {
  readonly tenantId: string;
  readonly chatId: string;
  readonly actorId: string;
  readonly title: string;
}

export interface SuggestedPostTarget {
  readonly tenantId: string;
  readonly chatId: string;
  readonly messageId: string;
  readonly comment?: string;
}

export interface MemberTagTarget {
  readonly tenantId: string;
  readonly chatId: string;
  readonly actorId: string;
  readonly tag: string;
}

export interface ReactionChoice {
  readonly tenantId: string;
  readonly chatId: string;
  readonly messageId: string;
  readonly emoji: string;
}

export interface MessageReactionTarget {
  readonly tenantId: string;
  readonly chatId: string;
  readonly messageId: string;
  readonly actorId: string;
  readonly kind: "user" | "chat";
}

export interface InviteLinkTarget {
  readonly tenantId: string;
  readonly chatId: string;
  readonly inviteLink: string;
}

export interface ForumTopicTarget {
  readonly tenantId: string;
  readonly chatId: string;
  readonly threadId?: string;
}

export interface GeneralNameTarget {
  readonly tenantId: string;
  readonly chatId: string;
  readonly name: string;
}

export interface NamedForumTopicTarget {
  readonly tenantId: string;
  readonly chatId: string;
  readonly threadId: string;
}

export interface NewTopicTarget {
  readonly tenantId: string;
  readonly chatId: string;
  readonly name: string;
}

export interface RenamedTopicTarget {
  readonly tenantId: string;
  readonly chatId: string;
  readonly threadId: string;
  readonly name: string;
}

export interface PinnedMessageTarget {
  readonly tenantId: string;
  readonly chatId: string;
  readonly messageId: string;
}

export type TopicPinTarget = ForumTopicTarget;

export type UnmuteResult = "lifted" | "absent";

export type MemberStanding =
  | { readonly status: "creator" | "administrator" | "member" | "left" }
  | { readonly status: "kicked"; readonly untilDate: number | null }
  | {
      readonly status: "restricted";
      readonly inChat: boolean;
      readonly untilDate: number | null;
    };

export interface JoinTarget extends BanTarget {
  readonly queryId?: string;
}

export interface ModerationPort {
  deleteMessage(target: DeleteTarget): Promise<void>;
  deleteMessages(target: DeleteMessagesTarget): Promise<void>;
  muteActor(target: MuteTarget): Promise<void>;
  banActor(target: BanTarget): Promise<void>;
  banSenderChat(target: SenderChatTarget): Promise<void>;
  clearReactions(target: ReactionActorTarget): Promise<void>;
  revokeInvite(target: InviteLinkTarget): Promise<void>;
  unbanSenderChat(target: SenderChatTarget): Promise<void>;
  unbanActor(target: BanTarget): Promise<void>;
  unmuteActor(target: BanTarget): Promise<UnmuteResult>;
  readMember(target: BanTarget): Promise<MemberStanding>;
  readPermissions(target: ChatTarget): Promise<DefaultChatPermissions>;
  readAdministrators(target: ChatTarget): Promise<readonly ChatAdministrator[]>;
  declineJoin(target: JoinTarget): Promise<void>;
  declinePost(target: SuggestedPostTarget): Promise<void>;
  approveJoin(target: JoinTarget): Promise<void>;
  deferJoin(target: JoinTarget & { readonly queryId: string }): Promise<void>;
  restrictActor(target: MuteTarget): Promise<void>;
  releaseActor(target: BanTarget): Promise<void>;
  lockChat(target: ChatTarget): Promise<void>;
  unlockChat(target: ChatTarget): Promise<void>;
  unpinChat(target: ChatTarget): Promise<void>;
  unpinTopic(target: TopicPinTarget): Promise<void>;
  closeTopic(target: ForumTopicTarget): Promise<void>;
  openTopic(target: ForumTopicTarget): Promise<void>;
  hideGeneral(target: ChatTarget): Promise<void>;
  showGeneral(target: ChatTarget): Promise<void>;
  deleteTopic(target: NamedForumTopicTarget): Promise<void>;
  readMemberCount(target: ChatTarget): Promise<number>;
  readBoostCount(target: BanTarget): Promise<number>;
  pinMessage(target: PinnedMessageTarget): Promise<void>;
  unpinMessage(target: PinnedMessageTarget): Promise<void>;
  removeReaction(target: MessageReactionTarget): Promise<void>;
  deletePhoto(target: ChatTarget): Promise<void>;
  leaveChat(target: ChatTarget): Promise<void>;
  setMemberTag(target: MemberTagTarget): Promise<void>;
  setAdminTitle(target: AdminTitleTarget): Promise<void>;
  deleteStickerSet(target: ChatTarget): Promise<void>;
  setReaction(target: ReactionChoice): Promise<void>;
  setStickerSet(target: ChatStickerSetTarget): Promise<void>;
  setTitle(target: ChatTitleTarget): Promise<void>;
  setDescription(target: ChatDescriptionTarget): Promise<void>;
  createTopic(target: NewTopicTarget): Promise<string>;
  renameTopic(target: RenamedTopicTarget): Promise<void>;
  renameGeneral(target: GeneralNameTarget): Promise<void>;
}

export function parseAuditRecord(input: unknown): AuditRecord {
  return auditRecordSchema.parse(input);
}

export function parseAuditQuery(input: unknown): AuditQuery {
  return auditQuerySchema.parse(input);
}

export function parseAuditScope(input: unknown): AuditScope {
  return auditScopeSchema.parse(input);
}

/** JSON export of one tenant, optionally one chat. Schema rejects message text. */
export function auditExportDocument(
  scope: AuditScope,
  audits: readonly AuditRecord[],
  omitted?: number,
): string {
  const parsedScope = parseAuditScope(scope);
  const document = {
    tenantId: parsedScope.tenantId,
    ...(parsedScope.chatId === undefined ? {} : { chatId: parsedScope.chatId }),
    ...(omitted === undefined || omitted <= 0 ? {} : { omitted }),
    audits: audits.map((record) => parseAuditRecord(record)),
  };
  assertNoRawContent(document);
  return JSON.stringify(document);
}

/** Newest audits whose JSON fits in `limit`. `null` when one audit is already longer. */
export function fitAuditExportDocument(
  scope: AuditScope,
  audits: readonly AuditRecord[],
  total: number,
  limit: number,
): string | null {
  if (audits.length === 0) {
    return null;
  }
  const safeTotal = Math.max(total, audits.length);
  let best: string | null = null;
  let low = 1;
  let high = audits.length;
  while (low <= high) {
    const count = Math.floor((low + high) / 2);
    const json = auditExportDocument(
      scope,
      audits.slice(audits.length - count),
      safeTotal - count,
    );
    if (json.length <= limit) {
      best = json;
      low = count + 1;
    } else {
      high = count - 1;
    }
  }
  return best;
}

/** Shortest JSON length of `count` audits in this scope. */
export function minimumAuditExportLength(
  scope: AuditScope,
  count: number,
): number {
  const parsed = parseAuditScope(scope);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("audit_count_invalid");
  }
  const emptyLength = auditExportDocument(parsed, []).length;
  if (count === 0) {
    return emptyLength;
  }
  const oneLength = auditExportDocument(parsed, [shortestAudit(parsed)]).length;
  const recordLength = oneLength - emptyLength;
  if (
    recordLength > 0 &&
    count > Math.floor((Number.MAX_SAFE_INTEGER - emptyLength) / recordLength)
  ) {
    return Number.MAX_SAFE_INTEGER;
  }
  return emptyLength + count * recordLength + (count - 1);
}

function shortestAudit(scope: AuditScope): AuditRecord {
  return parseAuditRecord({
    tenantId: scope.tenantId,
    chatId: scope.chatId ?? "c",
    eventId: "e",
    action: "log",
    score: 0,
    reasons: [],
    evidence: [],
    ruleIds: [],
    createdAt: "2026-11-01T00:00:00Z",
  });
}
