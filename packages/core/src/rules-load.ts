import type { Cache } from "./cache.js";
import type { Logger } from "./logger.js";
import { type RuleSet, ruleSetSchema } from "./rule.js";

export const DEFAULT_RULE_CACHE_TTL_SECONDS = 60;

/** No rules. The pipeline allows the event. */
export const openRuleSet: RuleSet = {
  version: 1,
  aggregate: "max",
  rules: [],
};

export interface RuleSource {
  /**
   * Chat-specific document, or null when this chat inherits the default.
   * The document is untrusted until `ruleSetSchema` accepts it.
   */
  loadChat(tenantId: string, chatId: string): Promise<unknown | null>;
  loadDefault(tenantId: string): Promise<unknown>;
}

export interface LoadRuleSetInput {
  readonly tenantId: string;
  readonly chatId: string;
  readonly cache: Cache;
  readonly source: RuleSource;
  readonly logger: Logger;
  readonly ttlSeconds?: number;
}

export async function loadRuleSet(input: LoadRuleSetInput): Promise<RuleSet> {
  const key = `rules:${input.tenantId}:${input.chatId}`;
  const ttl = input.ttlSeconds ?? DEFAULT_RULE_CACHE_TTL_SECONDS;
  const cached = await readCache(input, key);
  if (cached !== null) {
    const parsed = parseCached(cached);
    if (parsed) {
      return parsed;
    }
    input.logger.warn("rules_invalid", {
      tenantId: input.tenantId,
      chatId: input.chatId,
      scope: "cache",
    });
    await remember(input, key, openRuleSet, ttl);
    return openRuleSet;
  }

  let document: unknown;
  let scope: "chat" | "default";
  try {
    const override = await input.source.loadChat(input.tenantId, input.chatId);
    if (override === null) {
      document = await input.source.loadDefault(input.tenantId);
      scope = "default";
    } else {
      document = override;
      scope = "chat";
    }
  } catch {
    input.logger.warn("rules_invalid", {
      tenantId: input.tenantId,
      chatId: input.chatId,
      scope: "source",
    });
    await remember(input, key, openRuleSet, ttl);
    return openRuleSet;
  }

  const parsed = parseDocument(document);
  if (!parsed) {
    input.logger.warn("rules_invalid", {
      tenantId: input.tenantId,
      chatId: input.chatId,
      scope,
    });
    await remember(input, key, openRuleSet, ttl);
    return openRuleSet;
  }
  await remember(input, key, parsed, ttl);
  return parsed;
}

async function readCache(
  input: LoadRuleSetInput,
  key: string,
): Promise<string | null> {
  try {
    return await input.cache.get(key);
  } catch {
    input.logger.warn("rules_cache_failed", {
      tenantId: input.tenantId,
      chatId: input.chatId,
      op: "get",
    });
    return null;
  }
}

async function remember(
  input: LoadRuleSetInput,
  key: string,
  rules: RuleSet,
  ttl: number,
): Promise<void> {
  try {
    await input.cache.set(key, JSON.stringify(rules), ttl);
  } catch {
    input.logger.warn("rules_cache_failed", {
      tenantId: input.tenantId,
      chatId: input.chatId,
      op: "set",
    });
  }
}

function parseCached(value: string): RuleSet | null {
  try {
    return parseDocument(JSON.parse(value));
  } catch {
    return null;
  }
}

function parseDocument(value: unknown): RuleSet | null {
  const parsed = ruleSetSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
