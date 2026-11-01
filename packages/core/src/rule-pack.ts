import { z } from "zod";
import { parseRuleSet, type RuleSet } from "./rule.js";

const idSchema = z.string().min(1).max(128);
export const rulePackIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
export const ruleSubscriptionDocumentSchema = z.strictObject({
  packId: rulePackIdSchema.nullable(),
});
export const MAX_RULE_SUBSCRIPTIONS = 128;

export class RulePackCapacityError extends Error {
  constructor() {
    super("pack_full");
    this.name = "RulePackCapacityError";
  }
}

export interface RulePackSource {
  load(packId: string): Promise<unknown>;
}

export interface RulePackArchive {
  get(
    tenantId: string,
    chatId: string,
    packId: string,
  ): Promise<RuleSet | null>;
  put(
    tenantId: string,
    chatId: string,
    packId: string,
    rules: RuleSet,
  ): Promise<void>;
}

export interface RuleSubscriptionStore {
  get(tenantId: string, chatId: string): Promise<string | null>;
  put(tenantId: string, chatId: string, packId: string | null): Promise<void>;
}

export function parseRulePackId(value: string): string | null {
  const parsed = rulePackIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function createMemoryRuleSubscriptionStore(): RuleSubscriptionStore {
  const tenants = new Map<string, Map<string, string>>();
  return {
    async get(tenantId, chatId) {
      return tenants.get(tenantId)?.get(chatId) ?? null;
    },
    async put(tenantId, chatId, packId) {
      const parsedTenant = idSchema.parse(tenantId);
      const parsedChat = idSchema.parse(chatId);
      const chats = tenants.get(parsedTenant) ?? new Map<string, string>();
      if (packId === null) {
        chats.delete(parsedChat);
        tenants.set(parsedTenant, chats);
        return;
      }
      const parsedPack = rulePackIdSchema.parse(packId);
      if (!chats.has(parsedChat) && chats.size >= MAX_RULE_SUBSCRIPTIONS) {
        throw new RulePackCapacityError();
      }
      chats.set(parsedChat, parsedPack);
      tenants.set(parsedTenant, chats);
    },
  };
}

export function createMemoryRulePackArchive(): RulePackArchive {
  const values = new Map<string, RuleSet>();
  return {
    async get(tenantId, chatId, packId) {
      return values.get(archiveKey(tenantId, chatId, packId)) ?? null;
    },
    async put(tenantId, chatId, packId, rules) {
      const parsed = parseRuleSet(rules);
      const key = archiveKey(tenantId, chatId, packId);
      if (!values.has(key) && values.size >= MAX_RULE_SUBSCRIPTIONS) {
        throw new RulePackCapacityError();
      }
      values.set(key, parsed);
    },
  };
}

function archiveKey(tenantId: string, chatId: string, packId: string): string {
  return `${tenantId}\n${chatId}\n${packId}`;
}
