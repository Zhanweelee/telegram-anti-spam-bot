import { z } from "zod";
import { punitiveActions } from "./decision.js";

/** One chat can override at most this many rule ids. */
export const MAX_RULE_SWITCHES = 32;

const ruleIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);

/** One rule's enabled flag for a single chat. Unknown ids are ignored later. */
export interface RuleSwitch {
  readonly ruleId: string;
  readonly enabled: boolean;
}

export const ruleSwitchSchema = z.strictObject({
  ruleId: ruleIdSchema,
  enabled: z.boolean(),
});

/** One KV value per chat. A bad document is ignored by the adapter. */
export const runtimeDocumentSchema = z
  .strictObject({
    dryRun: z.boolean(),
    switches: z.array(ruleSwitchSchema).max(MAX_RULE_SWITCHES),
  })
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    for (const item of value.switches) {
      if (seen.has(item.ruleId)) {
        ctx.addIssue({
          code: "custom",
          message: "duplicate_rule_id",
          path: ["switches"],
        });
      }
      seen.add(item.ruleId);
    }
  });

export type RuntimeDocument = z.output<typeof runtimeDocumentSchema>;

/** One rule's single punitive action for a single chat. Unknown ids are ignored later. */
export const ruleActionSchema = z.strictObject({
  ruleId: ruleIdSchema,
  action: z.enum(punitiveActions),
});

export type RuleActionOverride = z.output<typeof ruleActionSchema>;

/** Separate from the runtime document so an old worker can still read switches. */
export const ruleActionDocumentSchema = z
  .strictObject({
    actions: z.array(ruleActionSchema).max(MAX_RULE_SWITCHES),
  })
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    for (const item of value.actions) {
      if (seen.has(item.ruleId)) {
        ctx.addIssue({
          code: "custom",
          message: "duplicate_rule_id",
          path: ["actions"],
        });
      }
      seen.add(item.ruleId);
    }
  });

export type RuleActionDocument = z.output<typeof ruleActionDocumentSchema>;

const reportTargetSchema = z.string().regex(/^-?\d{1,20}$/);

/** One destination per chat. A bad document is ignored by the adapter. */
export const reportChatDocumentSchema = z.strictObject({
  targetId: reportTargetSchema,
});

export type ReportChatDocument = z.output<typeof reportChatDocumentSchema>;

/** Default flood detector: 5 messages in 10 seconds. See ADR 0010. */
export const FLOOD_THRESHOLD = 5;
export const FLOOD_WINDOW_SECONDS = 10;
export const MIN_FLOOD_THRESHOLD = 2;
export const MAX_FLOOD_THRESHOLD = 32;
export const MIN_FLOOD_WINDOW_SECONDS = 1;
export const MAX_FLOOD_WINDOW_SECONDS = 300;

/** One flood window per chat. A bad document is ignored by the adapter. */
export const floodPolicyDocumentSchema = z.strictObject({
  threshold: z.number().int().min(MIN_FLOOD_THRESHOLD).max(MAX_FLOOD_THRESHOLD),
  windowSeconds: z
    .number()
    .int()
    .min(MIN_FLOOD_WINDOW_SECONDS)
    .max(MAX_FLOOD_WINDOW_SECONDS),
});

export type FloodPolicy = z.output<typeof floodPolicyDocumentSchema>;

/** Default repeat detector: 3 copies in 60 seconds. See ADR 0010. */
export const REPEAT_THRESHOLD = 3;
export const REPEAT_WINDOW_SECONDS = 60;

/** Same bounds as flood: 2–32 copies, 1–300 seconds. */
export const repeatPolicyDocumentSchema = floodPolicyDocumentSchema;

export type RepeatPolicy = FloodPolicy;

/** Default rule mute: one hour. The manual /mute command keeps its own default. */
export const MUTE_DURATION_SECONDS = 60 * 60;
export const MIN_MUTE_DURATION_SECONDS = 30;
export const MAX_MUTE_DURATION_SECONDS = 366 * 24 * 60 * 60;

/** One automatic mute length per chat. A bad document is ignored by the adapter. */
export const muteDurationDocumentSchema = z.strictObject({
  seconds: z
    .number()
    .int()
    .min(MIN_MUTE_DURATION_SECONDS)
    .max(MAX_MUTE_DURATION_SECONDS),
});

export type MuteDurationDocument = z.output<typeof muteDurationDocumentSchema>;

/** Extra keywords for one chat. The built-in list stays in the detector. */
export const MAX_CHAT_KEYWORDS = 32;

export const chatKeywordSchema = z.string().min(1).max(32);

export const chatKeywordDocumentSchema = z
  .strictObject({
    keywords: z.array(chatKeywordSchema).max(MAX_CHAT_KEYWORDS),
  })
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    for (const keyword of value.keywords) {
      if (seen.has(keyword)) {
        ctx.addIssue({
          code: "custom",
          message: "duplicate_keyword",
          path: ["keywords"],
        });
      }
      seen.add(keyword);
    }
  });

export type ChatKeywordDocument = z.output<typeof chatKeywordDocumentSchema>;

/** Per-chat switches that are not prefilter policy and not rules. */
export interface RuntimeStore {
  getDryRun(tenantId: string, chatId: string): Promise<boolean>;
  setDryRun(tenantId: string, chatId: string, enabled: boolean): Promise<void>;
  listRuleSwitches(
    tenantId: string,
    chatId: string,
  ): Promise<readonly RuleSwitch[]>;
  /**
   * Returns false when a new chat or a new rule id would exceed the cap.
   * Updating an id that is already stored still succeeds.
   */
  setRuleSwitch(
    tenantId: string,
    chatId: string,
    ruleId: string,
    enabled: boolean,
  ): Promise<boolean>;
  clearRuleSwitch(
    tenantId: string,
    chatId: string,
    ruleId: string,
  ): Promise<void>;
  listRuleActions(
    tenantId: string,
    chatId: string,
  ): Promise<readonly RuleActionOverride[]>;
  /**
   * Returns false when a new chat or a new rule id would exceed the cap.
   * Updating an id that is already stored still succeeds.
   */
  setRuleAction(
    tenantId: string,
    chatId: string,
    ruleId: string,
    action: RuleActionOverride["action"],
  ): Promise<boolean>;
  clearRuleAction(
    tenantId: string,
    chatId: string,
    ruleId: string,
  ): Promise<void>;
  /** Null when this chat still uses the deployment default. */
  getReportChat(tenantId: string, chatId: string): Promise<string | null>;
  /**
   * Returns false when the id is not a chat id, or a new chat would exceed
   * the memory cap. Updating a chat that is already stored still succeeds.
   */
  setReportChat(
    tenantId: string,
    chatId: string,
    targetId: string,
  ): Promise<boolean>;
  clearReportChat(tenantId: string, chatId: string): Promise<void>;
  /** Null when this chat still uses 5 messages in 10 seconds. */
  getFloodPolicy(tenantId: string, chatId: string): Promise<FloodPolicy | null>;
  /**
   * Returns false when the policy is outside 2–32 messages or 1–300 seconds,
   * or a new chat would exceed the memory cap. The default 5/10 clears the
   * row. Updating a chat that is already stored still succeeds.
   */
  setFloodPolicy(
    tenantId: string,
    chatId: string,
    policy: FloodPolicy,
  ): Promise<boolean>;
  clearFloodPolicy(tenantId: string, chatId: string): Promise<void>;
  /** Extra keywords for this chat. Empty when only the built-in list applies. */
  listKeywords(tenantId: string, chatId: string): Promise<readonly string[]>;
  /**
   * Returns false when the token is empty or longer than 32 characters, or a
   * new chat or a new keyword would exceed the cap. Adding a token that is
   * already stored still succeeds.
   */
  addKeyword(
    tenantId: string,
    chatId: string,
    keyword: string,
  ): Promise<boolean>;
  /** True when a stored token was removed. */
  removeKeyword(
    tenantId: string,
    chatId: string,
    keyword: string,
  ): Promise<boolean>;
  clearKeywords(tenantId: string, chatId: string): Promise<void>;
  /** Null when this chat still uses 3 copies in 60 seconds. */
  getRepeatPolicy(
    tenantId: string,
    chatId: string,
  ): Promise<RepeatPolicy | null>;
  /**
   * Returns false when the policy is outside 2–32 copies or 1–300 seconds,
   * or a new chat would exceed the memory cap. The default 3/60 clears the
   * row. Updating a chat that is already stored still succeeds.
   */
  setRepeatPolicy(
    tenantId: string,
    chatId: string,
    policy: RepeatPolicy,
  ): Promise<boolean>;
  clearRepeatPolicy(tenantId: string, chatId: string): Promise<void>;
  /** Null when rule mute still lasts one hour. */
  getMuteDuration(tenantId: string, chatId: string): Promise<number | null>;
  /**
   * Returns false when the seconds are outside 30 to 366 days, or a new chat
   * would exceed the memory cap. 3600 clears the row. Updating a chat that is
   * already stored still succeeds.
   */
  setMuteDuration(
    tenantId: string,
    chatId: string,
    seconds: number,
  ): Promise<boolean>;
  clearMuteDuration(tenantId: string, chatId: string): Promise<void>;
}
