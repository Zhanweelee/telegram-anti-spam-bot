/**
 * Cloud tenant directory and the free-quota policy.
 * Amounts are configuration. Payment providers are not implemented.
 */
export interface TenantDirectoryRecord {
  readonly tenantId: string;
  readonly createdAt: string;
}

export const cloudModule = {
  id: "cloud",
  version: "0.0.0",
} as const;

export { createMemoryChatDirectory } from "./chats.js";
export {
  createMemoryQuotaStore,
  defaultBasicDetectorIds,
  defaultQuotaLimit,
  defaultQuotaPolicy,
  degradeRules,
  type QuotaPolicy,
  type QuotaStore,
  type QuotaUsage,
  quotaPolicyFromEnv,
  quotaPolicySchema,
} from "./quota.js";
