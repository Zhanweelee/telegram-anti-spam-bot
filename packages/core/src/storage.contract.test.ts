import { parseAuditQuery, parseAuditRecord, type Storage } from "./ports.js";
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
        .filter(
          (record) =>
            record.tenantId === parsed.tenantId &&
            (parsed.chatId === undefined || record.chatId === parsed.chatId),
        )
        .slice(0, parsed.limit);
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
