import { type PolicyStore, prefilterPolicySchema } from "@tasb/core";

/**
 * Cloudflare bindings adapter.
 * D1 / Queues / Durable Objects implementations land with later storage work.
 * The policy store talks to a string map so tests do not import Workers types.
 * This module must not be imported by @tasb/core.
 */
export const cloudflareAdapter = {
  id: "cloudflare",
  version: "0.0.0",
  plannedBindings: ["d1", "kv", "queues", "durable_objects"],
} as const;

/** Minimal KV surface. The worker binding satisfies this when P0-08 wires it. */
export interface StringStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

export function createKvPolicyStore(kv: StringStore): PolicyStore {
  return {
    async get(tenantId, chatId) {
      const raw = await kv.get(recordKey(tenantId, chatId));
      if (raw === null) {
        return null;
      }
      try {
        const parsed = prefilterPolicySchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : null;
      } catch {
        return null;
      }
    },
    async put(tenantId, chatId, policy) {
      const parsed = prefilterPolicySchema.parse(policy);
      await kv.put(recordKey(tenantId, chatId), JSON.stringify(parsed));
    },
  };
}

function recordKey(tenantId: string, chatId: string): string {
  return `policy\n${tenantId.length}:${tenantId}${chatId.length}:${chatId}`;
}
