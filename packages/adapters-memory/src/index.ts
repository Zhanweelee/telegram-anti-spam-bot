import {
  type AuditQuery,
  type AuditRecord,
  type BanTarget,
  type Cache,
  type CaptchaChallenge,
  type CaptchaStore,
  type DeleteTarget,
  isExpired,
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
  type ReplyMessage,
  type ReplyPort,
  type RuleSet,
  type RuntimeStore,
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
  readonly muted: readonly MuteTarget[];
  readonly banned: readonly BanTarget[];
  readonly declined: readonly BanTarget[];
  readonly restricted: readonly MuteTarget[];
  readonly released: readonly BanTarget[];
} {
  const deleted: DeleteTarget[] = [];
  const muted: MuteTarget[] = [];
  const banned: BanTarget[] = [];
  const declined: BanTarget[] = [];
  const restricted: MuteTarget[] = [];
  const released: BanTarget[] = [];
  return {
    deleted,
    muted,
    banned,
    declined,
    restricted,
    released,
    async deleteMessage(target) {
      deleted.push({ ...target });
    },
    async muteActor(target) {
      muted.push({ ...target });
    },
    async banActor(target) {
      banned.push({ ...target });
    },
    async declineJoin(target) {
      declined.push({ ...target });
    },
    async restrictActor(target) {
      restricted.push({ ...target });
    },
    async releaseActor(target) {
      released.push({ ...target });
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
