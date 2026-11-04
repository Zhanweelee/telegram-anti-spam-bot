import { describe, expect, it } from "vitest";
import type { Cache } from "./cache.js";
import { createMemoryLogger } from "./logger.js";
import {
  createMemoryRulePackArchive,
  createMemoryRuleSubscriptionStore,
  type RulePackSource,
} from "./rule-pack.js";
import {
  applyRuleActions,
  applyRuleSwitches,
  type LoadRuleSetInput,
  loadRuleSet,
  openRuleSet,
  type RuleSource,
  resolveRuleSet,
} from "./rules-load.js";

const valid = {
  version: 1,
  aggregate: "max",
  rules: [
    {
      id: "spam_keywords",
      enabled: true,
      detectorIds: ["keyword"],
      threshold: 1,
      actions: ["delete"],
    },
  ],
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

function source(options?: {
  readonly chat?: unknown | null;
  readonly fallback?: unknown;
  readonly failChat?: boolean;
}): RuleSource & { calls: number } {
  let calls = 0;
  const api: RuleSource & { calls: number } = {
    get calls() {
      return calls;
    },
    async loadChat() {
      calls += 1;
      if (options?.failChat) {
        throw new Error("请免费领取礼品");
      }
      return options && "chat" in options ? (options.chat ?? null) : null;
    },
    async loadDefault() {
      calls += 1;
      return options?.fallback ?? valid;
    },
  };
  return api;
}

function input(
  cache: Cache,
  ruleSource: RuleSource,
  logger = createMemoryLogger(),
): LoadRuleSetInput & { logger: ReturnType<typeof createMemoryLogger> } {
  return {
    tenantId: "local",
    chatId: "chat_1",
    cache,
    source: ruleSource,
    logger,
  };
}

describe("loadRuleSet", () => {
  it("reads the source once and then serves the cache", async () => {
    const cache = memoryCache();
    const rules = source();
    const first = await loadRuleSet(input(cache, rules));
    const second = await loadRuleSet(input(cache, rules));
    expect(first.rules).toHaveLength(1);
    expect(second).toEqual(first);
    expect(rules.calls).toBe(2);
  });

  it("prefers a chat document over the default", async () => {
    const cache = memoryCache();
    const rules = source({ chat: openRuleSet });
    const loaded = await loadRuleSet(input(cache, rules));
    expect(loaded).toEqual(openRuleSet);
    expect(rules.calls).toBe(1);
  });

  it("fail-opens a chat whose document is invalid and omits the document from logs", async () => {
    const phrase = "配置里不该出现的句子";
    const logger = createMemoryLogger();
    const cache = memoryCache();
    const loaded = await loadRuleSet(
      input(
        cache,
        source({ chat: { version: 1, leak: phrase, text: phrase } }),
        logger,
      ),
    );
    expect(loaded).toEqual(openRuleSet);
    const logged = JSON.stringify(logger.entries);
    expect(logged).toContain("rules_invalid");
    expect(logged).toContain('"scope":"chat"');
    expect(logged).not.toContain(phrase);
    const again = await loadRuleSet(input(cache, source(), logger));
    expect(again).toEqual(openRuleSet);
    expect(
      logger.entries.filter((entry) => entry.message === "rules_invalid"),
    ).toHaveLength(1);
  });

  it("fail-opens when the default document or the source throws", async () => {
    const logger = createMemoryLogger();
    const invalidDefault = await loadRuleSet(
      input(memoryCache(), source({ fallback: { version: 9 } }), logger),
    );
    expect(invalidDefault).toEqual(openRuleSet);
    expect(JSON.stringify(logger.entries)).toContain('"scope":"default"');

    const thrown = createMemoryLogger();
    const opened = await loadRuleSet(
      input(memoryCache(), source({ failChat: true }), thrown),
    );
    expect(opened).toEqual(openRuleSet);
    expect(JSON.stringify(thrown.entries)).not.toContain("请免费领取礼品");
    expect(JSON.stringify(thrown.entries)).toContain('"scope":"source"');
  });

  it("fail-opens a corrupt cache entry", async () => {
    const cache = memoryCache();
    cache.values.set("rules:local:chat_1", "{");
    const logger = createMemoryLogger();
    const loaded = await loadRuleSet(input(cache, source(), logger));
    expect(loaded).toEqual(openRuleSet);
    expect(JSON.stringify(logger.entries)).toContain('"scope":"cache"');
  });

  it("still returns rules when the cache port fails", async () => {
    const logger = createMemoryLogger();
    const broken: Cache = {
      async get() {
        throw new Error("kv down");
      },
      async set() {
        throw new Error("kv down");
      },
    };
    const loaded = await loadRuleSet(input(broken, source(), logger));
    expect(loaded.rules[0]?.id).toBe("spam_keywords");
    const messages = logger.entries.map((entry) => entry.message);
    expect(messages).toContain("rules_cache_failed");
    expect(JSON.stringify(logger.entries)).not.toContain("kv down");
  });

  it("keeps tenants on separate cache keys", async () => {
    const cache = memoryCache();
    const rules: RuleSource = {
      async loadChat() {
        return null;
      },
      async loadDefault(tenantId) {
        return tenantId === "other" ? openRuleSet : valid;
      },
    };
    const local = await loadRuleSet({
      ...input(cache, rules),
      tenantId: "local",
    });
    const other = await loadRuleSet({
      ...input(cache, rules),
      tenantId: "other",
    });
    expect(local.rules).toHaveLength(1);
    expect(other.rules).toHaveLength(0);
  });

  it("leaves the pack source unread until a chat opts in", async () => {
    const cache = memoryCache();
    const packs = countingPacks(valid);
    const loaded = await resolveRuleSet(input(cache, source()));
    expect(loaded.rules[0]?.id).toBe("spam_keywords");
    expect(packs.calls).toBe(0);
  });

  it("keeps the last valid pack when a refresh fails", async () => {
    const phrase = "社区规则里的句子";
    const cache = memoryCache();
    const logger = createMemoryLogger();
    const archive = createMemoryRulePackArchive();
    const local = source();
    const packRules = {
      version: 1,
      aggregate: "max",
      rules: [
        {
          id: "community_keywords",
          enabled: true,
          detectorIds: ["keyword"],
          threshold: 1,
          actions: ["delete"],
        },
      ],
    };
    let body: unknown = packRules;
    const packs: RulePackSource = {
      async load() {
        if (body instanceof Error) {
          throw body;
        }
        return body;
      },
    };
    const first = await resolveRuleSet({
      ...input(cache, local, logger),
      pack: { id: "community", source: packs, archive },
    });
    expect(first.rules[0]?.id).toBe("community_keywords");
    expect(local.calls).toBe(0);
    body = new Error(phrase);
    const kept = await resolveRuleSet({
      ...input(memoryCache(), local, logger),
      pack: { id: "community", source: packs, archive },
    });
    expect(kept.rules[0]?.id).toBe("community_keywords");
    expect(local.calls).toBe(0);
    expect(JSON.stringify(logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(logger.entries)).toContain("pack_update_failed");
    body = { version: 1, text: phrase };
    const still = await resolveRuleSet({
      ...input(memoryCache(), local, logger),
      pack: { id: "community", source: packs, archive },
    });
    expect(still.rules[0]?.id).toBe("community_keywords");
    expect(JSON.stringify(logger.entries)).not.toContain(phrase);
  });

  it("falls back to local rules when the first pack fetch fails", async () => {
    const logger = createMemoryLogger();
    const packs: RulePackSource = {
      async load() {
        throw new Error("missing");
      },
    };
    const loaded = await resolveRuleSet({
      ...input(memoryCache(), source(), logger),
      pack: {
        id: "community",
        source: packs,
        archive: createMemoryRulePackArchive(),
      },
    });
    expect(loaded.rules[0]?.id).toBe("spam_keywords");
    expect(JSON.stringify(logger.entries)).toContain("pack_update_failed");
    expect(JSON.stringify(logger.entries)).not.toContain("missing");
  });

  it("serves a cached pack without reading the source again", async () => {
    const cache = memoryCache();
    const packs = countingPacks({
      version: 1,
      aggregate: "sum",
      rules: [],
    });
    const archive = createMemoryRulePackArchive();
    const base = input(cache, source());
    await resolveRuleSet({
      ...base,
      pack: { id: "community", source: packs, archive },
    });
    await resolveRuleSet({
      ...base,
      pack: { id: "community", source: packs, archive },
    });
    expect(packs.calls).toBe(1);
  });

  it("replaces a corrupt pack cache and hides archive errors", async () => {
    const cache = memoryCache();
    cache.values.set("pack:local:chat_1:community", "{");
    const logger = createMemoryLogger();
    const archive = {
      async get() {
        throw new Error("archive down");
      },
      async put() {
        throw new Error("archive down");
      },
    };
    const packRules = {
      version: 1,
      aggregate: "max" as const,
      rules: [
        {
          id: "community_keywords",
          enabled: true,
          detectorIds: ["keyword"],
          threshold: 1,
          actions: ["delete" as const],
        },
      ],
    };
    const loaded = await resolveRuleSet({
      ...input(cache, source(), logger),
      pack: {
        id: "community",
        source: countingPacks(packRules),
        archive,
      },
    });
    expect(loaded.rules[0]?.id).toBe("community_keywords");
    const failed = await resolveRuleSet({
      ...input(memoryCache(), source(), logger),
      pack: {
        id: "community",
        source: {
          async load() {
            throw new Error("refresh down");
          },
        },
        archive,
      },
    });
    expect(failed.rules[0]?.id).toBe("spam_keywords");
    const logged = JSON.stringify(logger.entries);
    expect(logged).toContain("pack_cache");
    expect(logged).toContain("pack_archive_failed");
    expect(logged).not.toContain("archive down");
    expect(logged).not.toContain("refresh down");
  });

  it("isolates subscriptions by tenant", async () => {
    const store = createMemoryRuleSubscriptionStore();
    await store.put("local", "chat_1", "community");
    expect(await store.get("local", "chat_1")).toBe("community");
    expect(await store.get("other", "chat_1")).toBeNull();
    await store.put("local", "chat_1", null);
    expect(await store.get("local", "chat_1")).toBeNull();
  });
});

describe("applyRuleSwitches", () => {
  it("enables a disabled rule and ignores unknown ids", () => {
    const rules = {
      version: 1 as const,
      aggregate: "max" as const,
      rules: [
        {
          id: "spam_keywords",
          enabled: true,
          detectorIds: ["keyword"],
          threshold: 1,
          actions: ["delete" as const],
        },
        {
          id: "via_inline",
          enabled: false,
          detectorIds: ["via"],
          threshold: 1,
          actions: ["delete" as const],
        },
      ],
    };
    const same = applyRuleSwitches(rules, []);
    expect(same).toBe(rules);
    const ignored = applyRuleSwitches(rules, [
      { ruleId: "missing", enabled: false },
    ]);
    expect(ignored).toBe(rules);
    const next = applyRuleSwitches(rules, [
      { ruleId: "via_inline", enabled: true },
      { ruleId: "missing", enabled: false },
    ]);
    expect(next).not.toBe(rules);
    expect(next.rules[0]).toBe(rules.rules[0]);
    expect(next.rules[1]?.enabled).toBe(true);
    expect(rules.rules[1]?.enabled).toBe(false);
  });

  it("applies a switch after the cached ruleset", async () => {
    const cached = memoryCache();
    const rules = source();
    const first = await loadRuleSet(input(cached, rules));
    expect(first.rules[0]?.enabled).toBe(true);
    const reads = rules.calls;
    const second = await loadRuleSet({
      ...input(cached, rules),
      switches: [{ ruleId: "spam_keywords", enabled: false }],
    });
    expect(rules.calls).toBe(reads);
    expect(second.rules[0]?.enabled).toBe(false);
    expect(cached.values.get("rules:local:chat_1")).toContain('"enabled":true');
    const packed = await resolveRuleSet({
      ...input(cached, rules),
      switches: [{ ruleId: "spam_keywords", enabled: false }],
      pack: {
        id: "community",
        source: countingPacks({
          version: 1,
          aggregate: "max",
          rules: [
            {
              id: "via_inline",
              enabled: false,
              detectorIds: ["via"],
              threshold: 1,
              actions: ["delete"],
            },
          ],
        }),
        archive: createMemoryRulePackArchive(),
      },
    });
    expect(packed.rules[0]?.id).toBe("via_inline");
    expect(packed.rules[0]?.enabled).toBe(false);
    const opened = await resolveRuleSet({
      ...input(memoryCache(), rules),
      switches: [{ ruleId: "via_inline", enabled: true }],
      pack: {
        id: "community",
        source: countingPacks({
          version: 1,
          aggregate: "max",
          rules: [
            {
              id: "via_inline",
              enabled: false,
              detectorIds: ["via"],
              threshold: 1,
              actions: ["delete"],
            },
          ],
        }),
        archive: createMemoryRulePackArchive(),
      },
    });
    expect(opened.rules[0]?.enabled).toBe(true);
  });

  it("replaces a rule action after the cached ruleset", async () => {
    const cached = memoryCache();
    const rules = source();
    const first = await loadRuleSet(input(cached, rules));
    expect(first.rules[0]?.actions).toEqual(["delete"]);
    const reads = rules.calls;
    const replaced = await loadRuleSet({
      ...input(cached, rules),
      switches: [{ ruleId: "spam_keywords", enabled: false }],
      actions: [{ ruleId: "spam_keywords", action: "warn" }],
    });
    expect(rules.calls).toBe(reads);
    expect(replaced.rules[0]?.enabled).toBe(false);
    expect(replaced.rules[0]?.actions).toEqual(["warn"]);
    expect(cached.values.get("rules:local:chat_1")).toContain(
      '"actions":["delete"]',
    );
    expect(first.rules[0]?.actions).toEqual(["delete"]);
    const packed = await resolveRuleSet({
      ...input(cached, rules),
      actions: [{ ruleId: "via_inline", action: "mute" }],
      pack: {
        id: "community",
        source: countingPacks({
          version: 1,
          aggregate: "max",
          rules: [
            {
              id: "via_inline",
              enabled: true,
              detectorIds: ["via"],
              threshold: 1,
              actions: ["delete", "report"],
            },
          ],
        }),
        archive: createMemoryRulePackArchive(),
      },
    });
    expect(packed.rules[0]?.actions).toEqual(["mute"]);
    const kept = await loadRuleSet({
      ...input(memoryCache(), rules),
      actions: [{ ruleId: "missing", action: "ban" }],
    });
    expect(kept.rules[0]?.actions).toEqual(["delete"]);
    expect(kept).toEqual(first);
    const same = applyRuleActions(first, [
      { ruleId: "spam_keywords", action: "delete" },
    ]);
    expect(same).toBe(first);
  });
});

function countingPacks(body: unknown): RulePackSource & { calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async load() {
      calls += 1;
      return body;
    },
  };
}
