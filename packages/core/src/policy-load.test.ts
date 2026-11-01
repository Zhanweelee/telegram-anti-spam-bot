import { describe, expect, it } from "vitest";
import type { Cache } from "./cache.js";
import { createMemoryLogger } from "./logger.js";
import { loadPolicy } from "./policy-load.js";
import type { PolicyStore } from "./policy-store.js";
import type { PrefilterPolicy } from "./prefilter.js";

const phrase = "请免费领取礼品";

const stored: PrefilterPolicy = {
  exemptAdmins: false,
  allowActorIds: ["user_9"],
};

const fallback: PrefilterPolicy = {
  exemptAdmins: true,
  allowActorIds: [],
};

function memoryCache(): Cache & { readonly values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    async get(key) {
      return values.get(key) ?? null;
    },
    async set(key, value) {
      values.set(key, value);
    },
  };
}

function store(options?: {
  readonly policy?: PrefilterPolicy | null;
  readonly fail?: boolean;
  readonly invalid?: boolean;
}): PolicyStore & { gets: number } {
  let gets = 0;
  const api: PolicyStore & { gets: number } = {
    get gets() {
      return gets;
    },
    async get() {
      gets += 1;
      if (options?.fail) {
        throw new Error(phrase);
      }
      if (options?.invalid) {
        return { exemptAdmins: false, allowActorIds: [""] } as PrefilterPolicy;
      }
      return options?.policy === undefined ? stored : options.policy;
    },
    async put() {
      throw new Error("unused");
    },
  };
  return api;
}

describe("loadPolicy", () => {
  it("reads the store once and then serves the cache", async () => {
    const cache = memoryCache();
    const policies = store();
    const logger = createMemoryLogger();
    const first = await loadPolicy({
      tenantId: "local",
      chatId: "chat_1",
      cache,
      store: policies,
      logger,
      fallback,
    });
    first.allowActorIds.push("mutated");
    const second = await loadPolicy({
      tenantId: "local",
      chatId: "chat_1",
      cache,
      store: policies,
      logger,
      fallback,
    });
    expect(first.allowActorIds).toEqual(["user_9", "mutated"]);
    expect(second).toEqual(stored);
    expect(policies.gets).toBe(1);
  });

  it("uses the fallback when the chat has no policy and caches it", async () => {
    const cache = memoryCache();
    const policies = store({ policy: null });
    const logger = createMemoryLogger();
    const input = {
      tenantId: "local",
      chatId: "chat_1",
      cache,
      store: policies,
      logger,
      fallback,
    };
    expect(await loadPolicy(input)).toEqual(fallback);
    expect(await loadPolicy(input)).toEqual(fallback);
    expect(policies.gets).toBe(1);
  });

  it("returns the fallback when the store throws and does not log the error text", async () => {
    const cache = memoryCache();
    const policies = store({ fail: true });
    const logger = createMemoryLogger();
    const input = {
      tenantId: "local",
      chatId: "chat_1",
      cache,
      store: policies,
      logger,
      fallback,
    };
    expect(await loadPolicy(input)).toEqual(fallback);
    expect(await loadPolicy(input)).toEqual(fallback);
    expect(policies.gets).toBe(1);
    const logged = JSON.stringify(logger.entries);
    expect(logged).toContain("policy_store_failed");
    expect(logged).not.toContain(phrase);
  });

  it("treats a corrupt cache entry as a miss and reads the store", async () => {
    const cache = memoryCache();
    cache.values.set(
      "policy:local:chat_1",
      JSON.stringify({ text: phrase, exemptAdmins: true }),
    );
    const policies = store();
    const logger = createMemoryLogger();
    const loaded = await loadPolicy({
      tenantId: "local",
      chatId: "chat_1",
      cache,
      store: policies,
      logger,
      fallback,
    });
    expect(loaded).toEqual(stored);
    expect(policies.gets).toBe(1);
    const logged = JSON.stringify(logger.entries);
    expect(logged).toContain("policy_invalid");
    expect(logged).not.toContain(phrase);
    expect(cache.values.get("policy:local:chat_1")).toBe(
      JSON.stringify(stored),
    );

    cache.values.set("policy:local:chat_2", "{");
    const second = store();
    const again = await loadPolicy({
      tenantId: "local",
      chatId: "chat_2",
      cache,
      store: second,
      logger,
      fallback,
      ttlSeconds: 30,
    });
    expect(again).toEqual(stored);
    expect(second.gets).toBe(1);
  });

  it("logs a cache read failure and still uses the store", async () => {
    const policies = store();
    const logger = createMemoryLogger();
    const cache: Cache = {
      async get() {
        throw new Error(phrase);
      },
      async set() {
        return undefined;
      },
    };
    const loaded = await loadPolicy({
      tenantId: "local",
      chatId: "chat_1",
      cache,
      store: policies,
      logger,
      fallback,
    });
    expect(loaded).toEqual(stored);
    const logged = JSON.stringify(logger.entries);
    expect(logged).toContain("policy_cache_failed");
    expect(logged).not.toContain(phrase);
  });

  it("returns the loaded policy when the cache write fails", async () => {
    const policies = store();
    const logger = createMemoryLogger();
    const cache: Cache = {
      async get() {
        return null;
      },
      async set() {
        throw new Error(phrase);
      },
    };
    const loaded = await loadPolicy({
      tenantId: "local",
      chatId: "chat_1",
      cache,
      store: policies,
      logger,
      fallback,
    });
    expect(loaded).toEqual(stored);
    const logged = JSON.stringify(logger.entries);
    expect(logged).toContain("policy_cache_failed");
    expect(logged).not.toContain(phrase);
  });

  it("replaces an unparsable stored policy with the fallback", async () => {
    const cache = memoryCache();
    const policies = store({ invalid: true });
    const logger = createMemoryLogger();
    const loaded = await loadPolicy({
      tenantId: "local",
      chatId: "chat_1",
      cache,
      store: policies,
      logger,
      fallback,
    });
    expect(loaded).toEqual(fallback);
    expect(JSON.stringify(logger.entries)).toContain("policy_invalid");
  });

  it("keeps the cached fallback after a later put until the cache is dropped", async () => {
    const cache = memoryCache();
    let current: PrefilterPolicy | null = null;
    let gets = 0;
    const policies: PolicyStore = {
      async get() {
        gets += 1;
        return current;
      },
      async put(_tenantId, _chatId, policy) {
        current = policy;
      },
    };
    const input = {
      tenantId: "local",
      chatId: "chat_1",
      cache,
      store: policies,
      logger: createMemoryLogger(),
      fallback,
    };
    expect(await loadPolicy(input)).toEqual(fallback);
    await policies.put("local", "chat_1", stored);
    expect(await loadPolicy(input)).toEqual(fallback);
    expect(gets).toBe(1);
  });

  it("rejects a fallback that is not a policy", async () => {
    const policies = store();
    await expect(
      loadPolicy({
        tenantId: "local",
        chatId: "chat_1",
        cache: memoryCache(),
        store: policies,
        logger: createMemoryLogger(),
        fallback: { exemptAdmins: true, allowActorIds: [""] },
      }),
    ).rejects.toThrow();
    expect(policies.gets).toBe(0);
  });
});
