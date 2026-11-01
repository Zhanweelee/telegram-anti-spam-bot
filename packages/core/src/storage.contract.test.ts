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
    async listAudits(query) {
      const parsed = parseAuditQuery(query);
      return records
        .filter((record) => inScope(record, parsed))
        .slice(0, parsed.limit);
    },
    async exportAudits(scope) {
      const parsed = parseAuditScope(scope);
      return records.filter((record) => inScope(record, parsed));
    },
    async deleteAudits(scope) {
      const parsed = parseAuditScope(scope);
      for (let index = records.length - 1; index >= 0; index -= 1) {
        const record = records[index];
        if (record && inScope(record, parsed)) {
          records.splice(index, 1);
        }
      }
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
