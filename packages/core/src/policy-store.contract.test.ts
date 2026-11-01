import { bindPolicyStoreContract } from "./policy-store.contract.js";
import type { PolicyStore } from "./policy-store.js";
import { prefilterPolicySchema } from "./prefilter.js";

function createReferenceStore(): PolicyStore {
  const values = new Map<string, string>();
  return {
    async get(tenantId, chatId) {
      const raw = values.get(scopedKey(tenantId, chatId));
      if (raw === undefined) {
        return null;
      }
      const parsed = prefilterPolicySchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    },
    async put(tenantId, chatId, policy) {
      const parsed = prefilterPolicySchema.parse(policy);
      values.set(scopedKey(tenantId, chatId), JSON.stringify(parsed));
    },
  };
}

function scopedKey(tenantId: string, chatId: string): string {
  return `${tenantId.length}:${tenantId}${chatId.length}:${chatId}`;
}

bindPolicyStoreContract(createReferenceStore);
