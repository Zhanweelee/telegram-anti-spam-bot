import type { Cache } from "./cache.js";
import type { Logger } from "./logger.js";
import { type RuleSet, ruleSetSchema } from "./rule.js";
import type { RulePackArchive, RulePackSource } from "./rule-pack.js";
import type { RuleActionOverride, RuleSwitch } from "./runtime.js";

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
  readonly switches?: readonly RuleSwitch[];
  readonly actions?: readonly RuleActionOverride[];
}

export interface RulePackRequest {
  readonly id: string;
  readonly source: RulePackSource;
  readonly archive: RulePackArchive;
}

export function applyRuleSwitches(
  rules: RuleSet,
  switches: readonly RuleSwitch[],
): RuleSet {
  if (switches.length === 0) {
    return rules;
  }
  const enabled = new Map(switches.map((item) => [item.ruleId, item.enabled]));
  let changed = false;
  const next = rules.rules.map((rule) => {
    const flag = enabled.get(rule.id);
    if (flag === undefined || flag === rule.enabled) {
      return rule;
    }
    changed = true;
    return { ...rule, enabled: flag };
  });
  return changed ? { ...rules, rules: next } : rules;
}

export function applyRuleActions(
  rules: RuleSet,
  actions: readonly RuleActionOverride[],
): RuleSet {
  if (actions.length === 0) {
    return rules;
  }
  const chosen = new Map(actions.map((item) => [item.ruleId, item.action]));
  let changed = false;
  const next = rules.rules.map((rule) => {
    const action = chosen.get(rule.id);
    if (action === undefined) {
      return rule;
    }
    if (rule.actions.length === 1 && rule.actions[0] === action) {
      return rule;
    }
    changed = true;
    return { ...rule, actions: [action] };
  });
  return changed ? { ...rules, rules: next } : rules;
}

export async function loadRuleSet(input: LoadRuleSetInput): Promise<RuleSet> {
  return applyRuleActions(
    applyRuleSwitches(await loadStoredRuleSet(input), input.switches ?? []),
    input.actions ?? [],
  );
}

async function loadStoredRuleSet(input: LoadRuleSetInput): Promise<RuleSet> {
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

/**
 * Local rules unless `pack` is set. A failed pack refresh keeps the last
 * schema-valid copy, and does not replace it with an empty ruleset.
 */
export async function resolveRuleSet(
  input: LoadRuleSetInput & { readonly pack?: RulePackRequest },
): Promise<RuleSet> {
  return applyRuleActions(
    applyRuleSwitches(await resolveStoredRuleSet(input), input.switches ?? []),
    input.actions ?? [],
  );
}

async function resolveStoredRuleSet(
  input: LoadRuleSetInput & { readonly pack?: RulePackRequest },
): Promise<RuleSet> {
  const pack = input.pack;
  if (!pack) {
    return loadStoredRuleSet(input);
  }
  const key = `pack:${input.tenantId}:${input.chatId}:${pack.id}`;
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
      scope: "pack_cache",
    });
  }
  try {
    const document = await pack.source.load(pack.id);
    const parsed = parseDocument(document);
    if (parsed) {
      await saveArchive(input, pack, parsed);
      await remember(input, key, parsed, ttl);
      return parsed;
    }
  } catch {
    return keepPrevious(input, pack, key, ttl);
  }
  return keepPrevious(input, pack, key, ttl);
}

async function keepPrevious(
  input: LoadRuleSetInput,
  pack: RulePackRequest,
  key: string,
  ttl: number,
): Promise<RuleSet> {
  input.logger.warn("pack_update_failed", {
    tenantId: input.tenantId,
    chatId: input.chatId,
    packId: pack.id,
  });
  const previous = await readArchive(pack, input);
  if (previous) {
    await remember(input, key, previous, ttl);
    return previous;
  }
  return loadStoredRuleSet(input);
}

async function saveArchive(
  input: LoadRuleSetInput,
  pack: RulePackRequest,
  rules: RuleSet,
): Promise<void> {
  try {
    await pack.archive.put(input.tenantId, input.chatId, pack.id, rules);
  } catch {
    input.logger.warn("pack_archive_failed", {
      tenantId: input.tenantId,
      chatId: input.chatId,
      packId: pack.id,
    });
  }
}

async function readArchive(
  pack: RulePackRequest,
  input: LoadRuleSetInput,
): Promise<RuleSet | null> {
  try {
    const rules = await pack.archive.get(input.tenantId, input.chatId, pack.id);
    if (!rules) {
      return null;
    }
    return parseDocument(rules);
  } catch {
    return null;
  }
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
