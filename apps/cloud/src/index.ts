/**
 * Cloud-only tenant directory.
 * Quota amounts and payment providers are intentionally absent.
 * Implementing billing requires an explicit human decision. See AGENTS.md.
 */
export interface TenantDirectoryRecord {
  readonly tenantId: string;
  readonly createdAt: string;
}

export const cloudModule = {
  id: "cloud",
  version: "0.0.0",
} as const;
