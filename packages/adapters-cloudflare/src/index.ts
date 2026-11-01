import { type PolicyStore, prefilterPolicySchema } from "@tasb/core";

export {
  createWorkersAiClassifier,
  FREE_PLAN_TEXT_MODEL,
  LlmUnavailableError,
  PAID_PLAN_MODELS,
  type WorkersAiBinding,
} from "./ai.js";
export {
  applyStorageMigrations,
  createD1ReviewQueue,
  createD1Storage,
  type SqlDatabase,
  type SqlPrepared,
  storageMigrationStatements,
} from "./d1.js";
export {
  hmacSha256Hex,
  sha256HexUtf8,
  signaturesMatch,
} from "./plugin-digest.js";

/**
 * Cloudflare bindings adapter.
 * D1 stores audits and rule documents. KV stores prefilter policy.
 * Workers AI is optional and stays out of the committed wrangler config.
 * Queues and Durable Objects stay unused. This module must not be
 * imported by @tasb/core, and it does not import Workers types.
 */
export const cloudflareAdapter = {
  id: "cloudflare",
  version: "0.0.0",
  plannedBindings: ["d1", "kv", "ai", "queues", "durable_objects"],
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
