import {
  type AuditQuery,
  type AuditRecord,
  type BanTarget,
  type Cache,
  type CaptchaChallenge,
  type CaptchaStore,
  type ChatTarget,
  captchaChallengeSchema,
  type DeleteMessagesTarget,
  type DeleteTarget,
  isExpired,
  type JoinTarget,
  MAX_RULE_SWITCHES,
  type ModerationPort,
  type MuteTarget,
  type PolicyStore,
  parseAuditQuery,
  parseAuditRecord,
  parseAuditScope,
  parseCaptchaChallenge,
  parseRuleSet,
  prefilterPolicySchema,
  type ReactionActorTarget,
  type ReplyMessage,
  type ReplyPort,
  type RuleSet,
  type RuntimeStore,
  type SenderChatTarget,
  type Storage,
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
} {
  const deleted: DeleteTarget[] = [];
  const deletedMessages: DeleteMessagesTarget[] = [];
  const muted: MuteTarget[] = [];
  const banned: BanTarget[] = [];
  const senderBanned: SenderChatTarget[] = [];
  const senderUnbanned: SenderChatTarget[] = [];
  const declined: JoinTarget[] = [];
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
  return {
    deleted,
    deletedMessages,
    muted,
    banned,
    senderBanned,
    senderUnbanned,
    declined,
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
