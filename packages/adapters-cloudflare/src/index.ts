import {
  MAX_RULE_SWITCHES,
  type PolicyStore,
  prefilterPolicySchema,
  type RuntimeDocument,
  type RuntimeStore,
  ruleSwitchSchema,
  runtimeDocumentSchema,
} from "@tasb/core";

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
 * D1 stores audits and rule documents. KV stores prefilter policy and
 * the per-chat runtime switches. Workers AI is optional and stays out
 * of the committed wrangler config. Queues and Durable Objects stay
 * unused. This module must not be imported by @tasb/core, and it does
 * not import Workers types.
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

const DEFAULT_RUNTIME_TTL_MS = 60_000;

const emptyRuntime: RuntimeDocument = { dryRun: false, switches: [] };

export function createKvRuntimeStore(
  kv: StringStore,
  options?: { readonly now?: () => number; readonly ttlMs?: number },
): RuntimeStore {
  const now = options?.now ?? (() => Date.now());
  const ttlMs = options?.ttlMs ?? DEFAULT_RUNTIME_TTL_MS;
  const cache = new Map<
    string,
    { readonly document: RuntimeDocument; readonly expiresAt: number }
  >();

  async function load(
    tenantId: string,
    chatId: string,
  ): Promise<RuntimeDocument> {
    const id = runtimeKey(tenantId, chatId);
    const at = now();
    const hit = cache.get(id);
    if (hit && hit.expiresAt > at) {
      return hit.document;
    }
    const document = parseRuntime(await kv.get(id));
    cache.set(id, { document, expiresAt: at + ttlMs });
    return document;
  }

  async function save(
    tenantId: string,
    chatId: string,
    document: RuntimeDocument,
  ): Promise<void> {
    const id = runtimeKey(tenantId, chatId);
    const parsed = runtimeDocumentSchema.parse(document);
    await kv.put(id, JSON.stringify(parsed));
    cache.set(id, { document: parsed, expiresAt: now() + ttlMs });
  }

  return {
    async getDryRun(tenantId, chatId) {
      return (await load(tenantId, chatId)).dryRun;
    },
    async setDryRun(tenantId, chatId, enabled) {
      const current = await load(tenantId, chatId);
      if (current.dryRun === enabled) {
        return;
      }
      await save(tenantId, chatId, { ...current, dryRun: enabled });
    },
    async listRuleSwitches(tenantId, chatId) {
      return (await load(tenantId, chatId)).switches;
    },
    async setRuleSwitch(tenantId, chatId, ruleId, enabled) {
      if (!ruleSwitchSchema.safeParse({ ruleId, enabled }).success) {
        return false;
      }
      const current = await load(tenantId, chatId);
      const index = current.switches.findIndex(
        (item) => item.ruleId === ruleId,
      );
      if (index === -1 && current.switches.length >= MAX_RULE_SWITCHES) {
        return false;
      }
      if (index !== -1 && current.switches[index]?.enabled === enabled) {
        return true;
      }
      const switches =
        index === -1
          ? [...current.switches, { ruleId, enabled }]
          : current.switches.map((item) =>
              item.ruleId === ruleId ? { ruleId, enabled } : item,
            );
      await save(tenantId, chatId, { ...current, switches });
      return true;
    },
    async clearRuleSwitch(tenantId, chatId, ruleId) {
      const current = await load(tenantId, chatId);
      const switches = current.switches.filter(
        (item) => item.ruleId !== ruleId,
      );
      if (switches.length === current.switches.length) {
        return;
      }
      await save(tenantId, chatId, { ...current, switches });
    },
  };
}

function parseRuntime(raw: string | null): RuntimeDocument {
  if (raw === null) {
    return emptyRuntime;
  }
  try {
    const parsed = runtimeDocumentSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : emptyRuntime;
  } catch {
    return emptyRuntime;
  }
}

function recordKey(tenantId: string, chatId: string): string {
  return `policy\n${tenantId.length}:${tenantId}${chatId.length}:${chatId}`;
}

function runtimeKey(tenantId: string, chatId: string): string {
  return `runtime\n${tenantId.length}:${tenantId}${chatId.length}:${chatId}`;
}
