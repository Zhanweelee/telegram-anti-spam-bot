import { describe, expect, it } from "vitest";
import type { Cache } from "./cache.js";
import { createMemoryLogger } from "./logger.js";
import {
  type LoadRuleSetInput,
  loadRuleSet,
  openRuleSet,
  type RuleSource,
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
});
