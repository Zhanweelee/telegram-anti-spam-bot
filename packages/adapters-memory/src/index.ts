import {
  type AuditQuery,
  type AuditRecord,
  type BanTarget,
  type Cache,
  type DeleteTarget,
  type ModerationPort,
  type MuteTarget,
  parseAuditQuery,
  parseAuditRecord,
  parseRuleSet,
  type RuleSet,
  type Storage,
} from "@tasb/core";

export function createMemoryStorage(): Storage & {
  readonly records: readonly AuditRecord[];
} {
  const records: AuditRecord[] = [];
  const rules = new Map<string, RuleSet>();
  return {
    records,
    async appendAudit(record) {
      records.push(parseAuditRecord(record));
    },
    async listAudits(query: AuditQuery) {
      const parsed = parseAuditQuery(query);
      return records
        .filter(
          (record) =>
            record.tenantId === parsed.tenantId &&
            (parsed.chatId === undefined || record.chatId === parsed.chatId),
        )
        .slice(0, parsed.limit);
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
} {
  const deleted: DeleteTarget[] = [];
  const muted: MuteTarget[] = [];
  const banned: BanTarget[] = [];
  return {
    deleted,
    muted,
    banned,
    async deleteMessage(target) {
      deleted.push({ ...target });
    },
    async muteActor(target) {
      muted.push({ ...target });
    },
    async banActor(target) {
      banned.push({ ...target });
    },
  };
}

function key(tenantId: string, chatId: string): string {
  return `${tenantId}\n${chatId}`;
}

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
