import {
  type AdminTitleTarget,
  type AuditQuery,
  type AuditRecord,
  type BanTarget,
  type Cache,
  type CaptchaChallenge,
  type CaptchaStore,
  type ChatDescriptionTarget,
  type ChatStickerSetTarget,
  type ChatTarget,
  type ChatTitleTarget,
  type CommandMenuTarget,
  captchaChallengeSchema,
  type DefaultRightsTarget,
  type DeleteMessagesTarget,
  type DeleteTarget,
  type ForumTopicTarget,
  type GeneralNameTarget,
  isExpired,
  type JoinTarget,
  MAX_RULE_SWITCHES,
  type MemberTagTarget,
  type MessageReactionTarget,
  type ModerationPort,
  type MuteTarget,
  type NamedForumTopicTarget,
  type NewTopicTarget,
  type PinnedMessageTarget,
  type PolicyStore,
  parseAuditQuery,
  parseAuditRecord,
  parseAuditScope,
  parseCaptchaChallenge,
  parseRuleSet,
  prefilterPolicySchema,
  type ReactionActorTarget,
  type ReactionChoice,
  type RenamedTopicTarget,
  type ReplyMessage,
  type ReplyPort,
  type RuleSet,
  type RuntimeStore,
  type SenderChatTarget,
  type Storage,
  type SuggestedPostTarget,
  type TopicPinTarget,
} from "@tasb/core";

export function createMemoryStorage(options?: {
  readonly maxAudits?: number;
}): Storage & {
  readonly records: readonly AuditRecord[];
} {
  const records: AuditRecord[] = [];
  const rules = new Map<string, RuleSet>();
  return {
    records,
    async appendAudit(record) {
      records.push(parseAuditRecord(record));
      trimAudits(records, options?.maxAudits);
    },
    async claimAudit(record) {
      const parsed = parseAuditRecord(record);
      const id = auditKey(parsed);
      if (records.some((item) => auditKey(item) === id)) {
        return false;
      }
      records.push(parsed);
      trimAudits(records, options?.maxAudits);
      return true;
    },
    async putAuditsIfAbsent(input) {
      const seen = new Set(records.map(auditKey));
      for (const record of input) {
        const parsed = parseAuditRecord(record);
        const id = auditKey(parsed);
        if (seen.has(id)) {
          continue;
        }
        seen.add(id);
        records.push(parsed);
      }
      trimAudits(records, options?.maxAudits);
    },
    async listAudits(query: AuditQuery) {
      const parsed = parseAuditQuery(query);
      const matched = records.filter((record) => matchesScope(record, parsed));
      return matched.slice(Math.max(0, matched.length - parsed.limit));
    },
    async getAudit(tenantId, chatId, eventId) {
      return (
        records.find(
          (record) =>
            record.tenantId === tenantId &&
            record.chatId === chatId &&
            record.eventId === eventId,
        ) ?? null
      );
    },
    async exportAudits(scope) {
      const parsed = parseAuditScope(scope);
      return records.filter((record) => matchesScope(record, parsed));
    },
    async countAudits(scope) {
      const parsed = parseAuditScope(scope);
      return records.filter((record) => matchesScope(record, parsed)).length;
    },
    async deleteAudits(scope) {
      const parsed = parseAuditScope(scope);
      let removed = 0;
      for (let index = records.length - 1; index >= 0; index -= 1) {
        const record = records[index];
        if (record && matchesScope(record, parsed)) {
          records.splice(index, 1);
          removed += 1;
        }
      }
      return removed;
    },
    async getRuleSet(tenantId, chatId) {
      return rules.get(key(tenantId, chatId)) ?? null;
    },
    async putRuleSet(tenantId, chatId, ruleSet) {
      rules.set(key(tenantId, chatId), parseRuleSet(ruleSet));
    },
  };
}

export function createMemoryModerator(): ModerationPort & {
  readonly deleted: readonly DeleteTarget[];
  readonly deletedMessages: readonly DeleteMessagesTarget[];
  readonly muted: readonly MuteTarget[];
  readonly banned: readonly BanTarget[];
  readonly senderBanned: readonly SenderChatTarget[];
  readonly senderUnbanned: readonly SenderChatTarget[];
  readonly declined: readonly JoinTarget[];
  readonly suggestedPostsDeclined: readonly SuggestedPostTarget[];
  readonly defaultRightsSet: readonly DefaultRightsTarget[];
  readonly commandMenusSet: readonly CommandMenuTarget[];
  readonly approved: readonly JoinTarget[];
  readonly deferred: readonly (JoinTarget & { readonly queryId: string })[];
  readonly restricted: readonly MuteTarget[];
  readonly released: readonly BanTarget[];
  readonly unbanned: readonly BanTarget[];
  readonly unmuted: readonly BanTarget[];
  readonly locked: readonly ChatTarget[];
  readonly unlocked: readonly ChatTarget[];
  readonly reactionsCleared: readonly ReactionActorTarget[];
  readonly invitesRevoked: readonly ChatTarget[];
  readonly unpinned: readonly ChatTarget[];
  readonly topicsUnpinned: readonly TopicPinTarget[];
  readonly topicsClosed: readonly ForumTopicTarget[];
  readonly topicsOpened: readonly ForumTopicTarget[];
  readonly generalsHidden: readonly ChatTarget[];
  readonly generalsShown: readonly ChatTarget[];
  readonly topicsDeleted: readonly NamedForumTopicTarget[];
  readonly messagesPinned: readonly PinnedMessageTarget[];
  readonly messagesUnpinned: readonly PinnedMessageTarget[];
  readonly messageReactionsRemoved: readonly MessageReactionTarget[];
  readonly photosDeleted: readonly ChatTarget[];
  readonly chatsLeft: readonly ChatTarget[];
  readonly memberTagsSet: readonly MemberTagTarget[];
  readonly adminTitlesSet: readonly AdminTitleTarget[];
  readonly stickerSetsDeleted: readonly ChatTarget[];
  readonly stickerSetsSet: readonly ChatStickerSetTarget[];
  readonly reactionsSet: readonly ReactionChoice[];
  readonly titlesSet: readonly ChatTitleTarget[];
  readonly descriptionsSet: readonly ChatDescriptionTarget[];
  readonly topicsRenamed: readonly RenamedTopicTarget[];
  readonly generalsRenamed: readonly GeneralNameTarget[];
} {
  const deleted: DeleteTarget[] = [];
  const deletedMessages: DeleteMessagesTarget[] = [];
  const muted: MuteTarget[] = [];
  const banned: BanTarget[] = [];
  const senderBanned: SenderChatTarget[] = [];
  const senderUnbanned: SenderChatTarget[] = [];
  const declined: JoinTarget[] = [];
  const suggestedPostsDeclined: SuggestedPostTarget[] = [];
  const defaultRightsSet: DefaultRightsTarget[] = [];
  const commandMenusSet: CommandMenuTarget[] = [];
  const approved: JoinTarget[] = [];
  const deferred: (JoinTarget & { readonly queryId: string })[] = [];
  const restricted: MuteTarget[] = [];
  const released: BanTarget[] = [];
  const unbanned: BanTarget[] = [];
  const unmuted: BanTarget[] = [];
  const locked: ChatTarget[] = [];
  const unlocked: ChatTarget[] = [];
  const reactionsCleared: ReactionActorTarget[] = [];
  const invitesRevoked: ChatTarget[] = [];
  const unpinned: ChatTarget[] = [];
  const topicsUnpinned: TopicPinTarget[] = [];
  const topicsClosed: ForumTopicTarget[] = [];
  const topicsOpened: ForumTopicTarget[] = [];
  const generalsHidden: ChatTarget[] = [];
  const generalsShown: ChatTarget[] = [];
  const topicsDeleted: NamedForumTopicTarget[] = [];
  const messagesPinned: PinnedMessageTarget[] = [];
  const messagesUnpinned: PinnedMessageTarget[] = [];
  const messageReactionsRemoved: MessageReactionTarget[] = [];
  const photosDeleted: ChatTarget[] = [];
  const chatsLeft: ChatTarget[] = [];
  const memberTagsSet: MemberTagTarget[] = [];
  const adminTitlesSet: AdminTitleTarget[] = [];
  const stickerSetsDeleted: ChatTarget[] = [];
  const stickerSetsSet: ChatStickerSetTarget[] = [];
  const reactionsSet: ReactionChoice[] = [];
  const titlesSet: ChatTitleTarget[] = [];
  const descriptionsSet: ChatDescriptionTarget[] = [];
  const topicsRenamed: RenamedTopicTarget[] = [];
  const generalsRenamed: GeneralNameTarget[] = [];
  return {
    deleted,
    deletedMessages,
    muted,
    banned,
    senderBanned,
    senderUnbanned,
    declined,
    suggestedPostsDeclined,
    defaultRightsSet,
    commandMenusSet,
    approved,
    deferred,
    restricted,
    released,
    unbanned,
    unmuted,
    locked,
    unlocked,
    reactionsCleared,
    invitesRevoked,
    unpinned,
    topicsUnpinned,
    topicsClosed,
    topicsOpened,
    generalsHidden,
    generalsShown,
    topicsDeleted,
    messagesPinned,
    messagesUnpinned,
    messageReactionsRemoved,
    photosDeleted,
    chatsLeft,
    memberTagsSet,
    adminTitlesSet,
    stickerSetsDeleted,
    stickerSetsSet,
    reactionsSet,
    titlesSet,
    descriptionsSet,
    topicsRenamed,
    generalsRenamed,
    async deleteMessage(target) {
      deleted.push({ ...target });
    },
    async deleteMessages(target) {
      deletedMessages.push({
        tenantId: target.tenantId,
        chatId: target.chatId,
        messageIds: [...target.messageIds],
      });
    },
    async muteActor(target) {
      muted.push({ ...target });
    },
    async banActor(target) {
      banned.push({ ...target });
    },
    async banSenderChat(target) {
      senderBanned.push({
        tenantId: target.tenantId,
        chatId: target.chatId,
        senderChatId: target.senderChatId,
      });
    },
    async unbanSenderChat(target) {
      senderUnbanned.push({
        tenantId: target.tenantId,
        chatId: target.chatId,
        senderChatId: target.senderChatId,
      });
    },
    async approveJoin(target) {
      approved.push({
        tenantId: target.tenantId,
        chatId: target.chatId,
        actorId: target.actorId,
      });
    },
    async setCommandMenu(target) {
      commandMenusSet.push({
        tenantId: target.tenantId,
        commands: target.commands.map((item) => ({
          command: item.command,
          description: item.description,
        })),
      });
    },
    async setDefaultRights(target) {
      defaultRightsSet.push(
        target.rights === undefined
          ? { tenantId: target.tenantId, forChannels: target.forChannels }
          : {
              tenantId: target.tenantId,
              forChannels: target.forChannels,
              rights: { ...target.rights },
            },
      );
    },
    async declinePost(target) {
      suggestedPostsDeclined.push(
        target.comment === undefined
          ? {
              tenantId: target.tenantId,
              chatId: target.chatId,
              messageId: target.messageId,
            }
          : {
              tenantId: target.tenantId,
              chatId: target.chatId,
              messageId: target.messageId,
              comment: target.comment,
            },
      );
    },
    async declineJoin(target) {
      declined.push(
        target.queryId === undefined
          ? {
              tenantId: target.tenantId,
              chatId: target.chatId,
              actorId: target.actorId,
            }
          : {
              tenantId: target.tenantId,
              chatId: target.chatId,
              actorId: target.actorId,
              queryId: target.queryId,
            },
      );
    },
    async deferJoin(target) {
      deferred.push({
        tenantId: target.tenantId,
        chatId: target.chatId,
        actorId: target.actorId,
        queryId: target.queryId,
      });
    },
    async restrictActor(target) {
      restricted.push({ ...target });
    },
    async releaseActor(target) {
      released.push({ ...target });
    },
    async lockChat(target) {
      locked.push({
        tenantId: target.tenantId,
        chatId: target.chatId,
      });
    },
    async unlockChat(target) {
      unlocked.push({
        tenantId: target.tenantId,
        chatId: target.chatId,
      });
    },
    async unbanActor(target) {
      unbanned.push({ ...target });
    },
    async unmuteActor(target) {
      unmuted.push({ ...target });
      return "lifted" as const;
    },
    async readMember() {
      throw new Error("member_unavailable");
    },
    async readPermissions() {
      throw new Error("perms_unavailable");
    },
    async readAdministrators() {
      throw new Error("admins_unavailable");
    },
    async readMemberCount() {
      throw new Error("count_unavailable");
    },
    async readBoostCount() {
      throw new Error("boosts_unavailable");
    },
    async readDefaultRights() {
      throw new Error("botrights_unavailable");
    },
    async readCommandMenu() {
      throw new Error("commands_unavailable");
    },
    async createTopic(_target: NewTopicTarget) {
      throw new Error("newtopic_unavailable");
    },
    async clearReactions(target) {
      reactionsCleared.push({
        tenantId: target.tenantId,
        chatId: target.chatId,
        actorId: target.actorId,
        kind: target.kind,
      });
    },
    async revokeInvite(target) {
      invitesRevoked.push({
        tenantId: target.tenantId,
        chatId: target.chatId,
      });
    },
    async unpinChat(target) {
      unpinned.push({
        tenantId: target.tenantId,
        chatId: target.chatId,
      });
    },
    async pinMessage(target) {
      messagesPinned.push({
        tenantId: target.tenantId,
        chatId: target.chatId,
        messageId: target.messageId,
      });
    },
    async unpinMessage(target) {
      messagesUnpinned.push({
        tenantId: target.tenantId,
        chatId: target.chatId,
        messageId: target.messageId,
      });
    },
    async removeReaction(target) {
      messageReactionsRemoved.push({
        tenantId: target.tenantId,
        chatId: target.chatId,
        messageId: target.messageId,
        actorId: target.actorId,
        kind: target.kind,
      });
    },
    async deletePhoto(target) {
      photosDeleted.push({
        tenantId: target.tenantId,
        chatId: target.chatId,
      });
    },
    async leaveChat(target) {
      chatsLeft.push({
        tenantId: target.tenantId,
        chatId: target.chatId,
      });
    },
    async setMemberTag(target) {
      memberTagsSet.push({
        tenantId: target.tenantId,
        chatId: target.chatId,
        actorId: target.actorId,
        tag: target.tag,
      });
    },
    async setAdminTitle(target) {
      adminTitlesSet.push({
        tenantId: target.tenantId,
        chatId: target.chatId,
        actorId: target.actorId,
        title: target.title,
      });
    },
    async deleteStickerSet(target) {
      stickerSetsDeleted.push({
        tenantId: target.tenantId,
        chatId: target.chatId,
      });
    },
    async setReaction(target) {
      reactionsSet.push({
        tenantId: target.tenantId,
        chatId: target.chatId,
        messageId: target.messageId,
        emoji: target.emoji,
      });
    },
    async setStickerSet(target) {
      stickerSetsSet.push({
        tenantId: target.tenantId,
        chatId: target.chatId,
        name: target.name,
      });
    },
    async setTitle(target) {
      titlesSet.push({
        tenantId: target.tenantId,
        chatId: target.chatId,
        title: target.title,
      });
    },
    async setDescription(target) {
      descriptionsSet.push({
        tenantId: target.tenantId,
        chatId: target.chatId,
        description: target.description,
      });
    },
    async renameTopic(target) {
      topicsRenamed.push({
        tenantId: target.tenantId,
        chatId: target.chatId,
        threadId: target.threadId,
        name: target.name,
      });
    },
    async renameGeneral(target) {
      generalsRenamed.push({
        tenantId: target.tenantId,
        chatId: target.chatId,
        name: target.name,
      });
    },
    async unpinTopic(target) {
      topicsUnpinned.push(
        target.threadId === undefined
          ? { tenantId: target.tenantId, chatId: target.chatId }
          : {
              tenantId: target.tenantId,
              chatId: target.chatId,
              threadId: target.threadId,
            },
      );
    },
    async closeTopic(target) {
      topicsClosed.push(
        target.threadId === undefined
          ? { tenantId: target.tenantId, chatId: target.chatId }
          : {
              tenantId: target.tenantId,
              chatId: target.chatId,
              threadId: target.threadId,
            },
      );
    },
    async openTopic(target) {
      topicsOpened.push(
        target.threadId === undefined
          ? { tenantId: target.tenantId, chatId: target.chatId }
          : {
              tenantId: target.tenantId,
              chatId: target.chatId,
              threadId: target.threadId,
            },
      );
    },
    async hideGeneral(target) {
      generalsHidden.push({
        tenantId: target.tenantId,
        chatId: target.chatId,
      });
    },
    async showGeneral(target) {
      generalsShown.push({
        tenantId: target.tenantId,
        chatId: target.chatId,
      });
    },
    async deleteTopic(target) {
      topicsDeleted.push({
        tenantId: target.tenantId,
        chatId: target.chatId,
        threadId: target.threadId,
      });
    },
  };
}

export function createMemoryCaptchaStore(): CaptchaStore {
  const values = new Map<string, CaptchaChallenge>();
  return {
    async get(tenantId, chatId, actorId) {
      return values.get(captchaKey(tenantId, chatId, actorId)) ?? null;
    },
    async put(challenge) {
      const parsed = parseCaptchaChallenge(challenge);
      values.set(
        captchaKey(parsed.tenantId, parsed.chatId, parsed.actorId),
        parsed,
      );
    },
    async delete(tenantId, chatId, actorId) {
      values.delete(captchaKey(tenantId, chatId, actorId));
    },
    async deleteMany(challenges) {
      for (const challenge of challenges) {
        const parsed = parseCaptchaChallenge(challenge);
        values.delete(
          captchaKey(parsed.tenantId, parsed.chatId, parsed.actorId),
        );
      }
    },
    async take(tenantId, chatId, actorId, nonce) {
      const current = values.get(captchaKey(tenantId, chatId, actorId));
      if (current === undefined || current.nonce !== nonce) {
        return null;
      }
      values.delete(captchaKey(tenantId, chatId, actorId));
      return current;
    },
    async takeMany(challenges) {
      const taken: CaptchaChallenge[] = [];
      for (const challenge of challenges) {
        const parsed = parseCaptchaChallenge(challenge);
        const current = values.get(
          captchaKey(parsed.tenantId, parsed.chatId, parsed.actorId),
        );
        if (current === undefined || current.nonce !== parsed.nonce) {
          continue;
        }
        values.delete(
          captchaKey(parsed.tenantId, parsed.chatId, parsed.actorId),
        );
        taken.push(current);
      }
      return taken;
    },
    async attachPrompt(tenantId, chatId, actorId, nonce, messageId) {
      const current = values.get(captchaKey(tenantId, chatId, actorId));
      if (current === undefined || current.nonce !== nonce) {
        return false;
      }
      const parsed = captchaChallengeSchema.safeParse({
        ...current,
        messageId,
      });
      if (!parsed.success || parsed.data.messageId === undefined) {
        return false;
      }
      values.set(captchaKey(tenantId, chatId, actorId), parsed.data);
      return true;
    },
    async findByNonce(tenantId, chatId, nonce) {
      for (const challenge of values.values()) {
        if (
          challenge.tenantId === tenantId &&
          challenge.chatId === chatId &&
          challenge.nonce === nonce
        ) {
          return challenge;
        }
      }
      return null;
    },
    async listExpired(nowIso) {
      return [...values.values()].filter((challenge) =>
        isExpired(challenge.expiresAt, nowIso),
      );
    },
  };
}

function trimAudits(records: AuditRecord[], cap: number | undefined): void {
  if (cap !== undefined && records.length > cap) {
    records.splice(0, records.length - cap);
  }
}

function auditKey(record: AuditRecord): string {
  return `${record.tenantId}\n${record.chatId}\n${record.eventId}`;
}

function captchaKey(tenantId: string, chatId: string, actorId: string): string {
  return `${tenantId}\n${chatId}\n${actorId}`;
}

export function createMemoryPolicyStore(): PolicyStore {
  const values = new Map<string, string>();
  return {
    async get(tenantId, chatId) {
      const raw = values.get(policyKey(tenantId, chatId));
      if (raw === undefined) {
        return null;
      }
      const parsed = prefilterPolicySchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    },
    async put(tenantId, chatId, policy) {
      const parsed = prefilterPolicySchema.parse(policy);
      values.set(policyKey(tenantId, chatId), JSON.stringify(parsed));
    },
  };
}

function matchesScope(
  record: AuditRecord,
  scope: { readonly tenantId: string; readonly chatId?: string | undefined },
): boolean {
  return (
    record.tenantId === scope.tenantId &&
    (scope.chatId === undefined || record.chatId === scope.chatId)
  );
}

function key(tenantId: string, chatId: string): string {
  return `${tenantId}\n${chatId}`;
}

function policyKey(tenantId: string, chatId: string): string {
  return `${tenantId.length}:${tenantId}${chatId.length}:${chatId}`;
}

const MAX_SWITCH_CHATS = 256;

export function createMemoryRuntimeStore(): RuntimeStore {
  const dryRun = new Set<string>();
  const switches = new Map<string, Map<string, boolean>>();
  return {
    async getDryRun(tenantId, chatId) {
      return dryRun.has(key(tenantId, chatId));
    },
    async setDryRun(tenantId, chatId, enabled) {
      const id = key(tenantId, chatId);
      if (enabled) {
        dryRun.add(id);
        return;
      }
      dryRun.delete(id);
    },
    async listRuleSwitches(tenantId, chatId) {
      const saved = switches.get(key(tenantId, chatId));
      if (!saved) {
        return [];
      }
      return [...saved.entries()].map(([ruleId, enabled]) => ({
        ruleId,
        enabled,
      }));
    },
    async setRuleSwitch(tenantId, chatId, ruleId, enabled) {
      const id = key(tenantId, chatId);
      let saved = switches.get(id);
      if (!saved) {
        if (switches.size >= MAX_SWITCH_CHATS) {
          return false;
        }
        saved = new Map();
        switches.set(id, saved);
      }
      if (!saved.has(ruleId) && saved.size >= MAX_RULE_SWITCHES) {
        return false;
      }
      saved.set(ruleId, enabled);
      return true;
    },
    async clearRuleSwitch(tenantId, chatId, ruleId) {
      const id = key(tenantId, chatId);
      const saved = switches.get(id);
      if (!saved) {
        return;
      }
      saved.delete(ruleId);
      if (saved.size === 0) {
        switches.delete(id);
      }
    },
  };
}

export function createMemoryReply(): ReplyPort & {
  readonly sent: readonly ReplyMessage[];
} {
  const sent: ReplyMessage[] = [];
  return {
    sent,
    async send(message) {
      sent.push({
        tenantId: message.tenantId,
        chatId: message.chatId,
        text: message.text,
      });
    },
  };
}

export {
  createMemoryBlocklistStore,
  createMemoryReviewQueue,
  createMemoryRulePackArchive,
  createMemoryRuleSubscriptionStore,
} from "@tasb/core";

export function createMemoryCache(nowMs: () => number = Date.now): Cache {
  const values = new Map<string, { value: string; expiresAt: number }>();
  return {
    async get(key) {
      const hit = values.get(key);
      if (!hit) {
        return null;
      }
      if (nowMs() >= hit.expiresAt) {
        values.delete(key);
        return null;
      }
      return hit.value;
    },
    async set(key, value, ttlSeconds) {
      values.set(key, { value, expiresAt: nowMs() + ttlSeconds * 1000 });
    },
  };
}
