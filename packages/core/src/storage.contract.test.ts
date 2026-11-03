import {
  parseAuditQuery,
  parseAuditRecord,
  parseAuditScope,
  type Storage,
} from "./ports.js";
import { parseRuleSet } from "./rule.js";
import { bindStorageContract } from "./testing.js";

function createReferenceStorage(): Storage {
  const records: ReturnType<typeof parseAuditRecord>[] = [];
  const rules = new Map<string, ReturnType<typeof parseRuleSet>>();
  return {
    async appendAudit(record) {
      records.push(parseAuditRecord(record));
    },
    async putAuditsIfAbsent(input) {
      for (const record of input) {
        const parsed = parseAuditRecord(record);
        const exists = records.some(
          (item) =>
            item.tenantId === parsed.tenantId &&
            item.chatId === parsed.chatId &&
            item.eventId === parsed.eventId,
        );
        if (!exists) {
          records.push(parsed);
        }
      }
    },
    async listAudits(query) {
      const parsed = parseAuditQuery(query);
      const matched = records.filter((record) => inScope(record, parsed));
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
      return records.filter((record) => inScope(record, parsed));
    },
    async countAudits(scope) {
      const parsed = parseAuditScope(scope);
      return records.filter((record) => inScope(record, parsed)).length;
    },
    async deleteAudits(scope) {
      const parsed = parseAuditScope(scope);
      let removed = 0;
      for (let index = records.length - 1; index >= 0; index -= 1) {
        const record = records[index];
        if (record && inScope(record, parsed)) {
          records.splice(index, 1);
          removed += 1;
        }
      }
      return removed;
    },
    async getRuleSet(tenantId, chatId) {
      return rules.get(`${tenantId}\n${chatId}`) ?? null;
    },
    async putRuleSet(tenantId, chatId, ruleSet) {
      rules.set(`${tenantId}\n${chatId}`, parseRuleSet(ruleSet));
    },
  };
}

bindStorageContract(createReferenceStorage);

function inScope(
  record: { readonly tenantId: string; readonly chatId: string },
  scope: { readonly tenantId: string; readonly chatId?: string | undefined },
): boolean {
  return (
    record.tenantId === scope.tenantId &&
    (scope.chatId === undefined || record.chatId === scope.chatId)
  );
}
