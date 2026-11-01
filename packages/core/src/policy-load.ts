import type { Cache } from "./cache.js";
import type { Logger } from "./logger.js";
import type { PolicyStore } from "./policy-store.js";
import { type PrefilterPolicy, prefilterPolicySchema } from "./prefilter.js";

export const DEFAULT_POLICY_CACHE_TTL_SECONDS = 60;

/** Missing policy. Admins stay exempt and the allowlist is empty. */
export const defaultPrefilterPolicy: PrefilterPolicy = {
  exemptAdmins: true,
  allowActorIds: [],
};

export interface LoadPolicyInput {
  readonly tenantId: string;
  readonly chatId: string;
  readonly cache: Cache;
  readonly store: PolicyStore;
  readonly logger: Logger;
  readonly fallback: PrefilterPolicy;
  readonly ttlSeconds?: number;
}

export function policyCacheKey(tenantId: string, chatId: string): string {
  return `policy:${tenantId}:${chatId}`;
}

export async function savePolicy(input: {
  readonly tenantId: string;
  readonly chatId: string;
  readonly policy: PrefilterPolicy;
  readonly cache: Cache;
  readonly store: PolicyStore;
  readonly logger: Logger;
  readonly ttlSeconds?: number;
}): Promise<void> {
  const policy = prefilterPolicySchema.parse(input.policy);
  await input.store.put(input.tenantId, input.chatId, policy);
  await remember(
    input.logger,
    input.cache,
    input.tenantId,
    input.chatId,
    policyCacheKey(input.tenantId, input.chatId),
    policy,
    input.ttlSeconds ?? DEFAULT_POLICY_CACHE_TTL_SECONDS,
  );
}

export async function loadPolicy(
  input: LoadPolicyInput,
): Promise<PrefilterPolicy> {
  const fallback = prefilterPolicySchema.parse(input.fallback);
  const key = policyCacheKey(input.tenantId, input.chatId);
  const ttl = input.ttlSeconds ?? DEFAULT_POLICY_CACHE_TTL_SECONDS;
  const cached = await readCache(input, key);
  if (cached !== null) {
    const parsed = parseCached(cached);
    if (parsed) {
      return parsed;
    }
    input.logger.warn("policy_invalid", {
      tenantId: input.tenantId,
      chatId: input.chatId,
      scope: "cache",
    });
  }

  let stored: PrefilterPolicy | null;
  try {
    stored = await input.store.get(input.tenantId, input.chatId);
  } catch {
    input.logger.warn("policy_store_failed", {
      tenantId: input.tenantId,
      chatId: input.chatId,
    });
    await remember(
      input.logger,
      input.cache,
      input.tenantId,
      input.chatId,
      key,
      fallback,
      ttl,
    );
    return copyPolicy(fallback);
  }

  if (stored === null) {
    await remember(
      input.logger,
      input.cache,
      input.tenantId,
      input.chatId,
      key,
      fallback,
      ttl,
    );
    return copyPolicy(fallback);
  }
  const parsed = prefilterPolicySchema.safeParse(stored);
  if (!parsed.success) {
    input.logger.warn("policy_invalid", {
      tenantId: input.tenantId,
      chatId: input.chatId,
      scope: "store",
    });
    await remember(
      input.logger,
      input.cache,
      input.tenantId,
      input.chatId,
      key,
      fallback,
      ttl,
    );
    return copyPolicy(fallback);
  }
  await remember(
    input.logger,
    input.cache,
    input.tenantId,
    input.chatId,
    key,
    parsed.data,
    ttl,
  );
  return copyPolicy(parsed.data);
}

async function readCache(
  input: LoadPolicyInput,
  key: string,
): Promise<string | null> {
  try {
    return await input.cache.get(key);
  } catch {
    input.logger.warn("policy_cache_failed", {
      tenantId: input.tenantId,
      chatId: input.chatId,
      op: "get",
    });
    return null;
  }
}

async function remember(
  logger: Logger,
  cache: Cache,
  tenantId: string,
  chatId: string,
  key: string,
  policy: PrefilterPolicy,
  ttl: number,
): Promise<void> {
  try {
    await cache.set(key, JSON.stringify(policy), ttl);
  } catch {
    logger.warn("policy_cache_failed", {
      tenantId,
      chatId,
      op: "set",
    });
  }
}

function parseCached(value: string): PrefilterPolicy | null {
  try {
    const parsed = prefilterPolicySchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function copyPolicy(policy: PrefilterPolicy): PrefilterPolicy {
  return {
    exemptAdmins: policy.exemptAdmins,
    allowActorIds: [...policy.allowActorIds],
  };
}
