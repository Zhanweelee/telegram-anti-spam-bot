import type { PrefilterPolicy } from "./prefilter.js";

/**
 * Per-tenant, per-chat prefilter policy.
 * `null` means this chat has no stored policy and the caller should use its fallback.
 * A document that fails the schema is also `null`: adapters must not throw the raw JSON.
 */
export interface PolicyStore {
  get(tenantId: string, chatId: string): Promise<PrefilterPolicy | null>;
  put(tenantId: string, chatId: string, policy: PrefilterPolicy): Promise<void>;
}
