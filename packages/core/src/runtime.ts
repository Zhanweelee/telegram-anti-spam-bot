import { z } from "zod";

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
}
