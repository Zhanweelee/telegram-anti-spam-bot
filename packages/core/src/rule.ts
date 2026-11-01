import { z } from "zod";
import { punitiveActions } from "./decision.js";
import { type Event, eventKindSchema } from "./event.js";

export type RuleWhen =
  | { readonly eventKind: z.output<typeof eventKindSchema> }
  | { readonly all: readonly RuleWhen[] }
  | { readonly any: readonly RuleWhen[] }
  | { readonly not: RuleWhen };

export const ruleWhenSchema: z.ZodType<RuleWhen> = z.lazy(() =>
  z.union([
    z.strictObject({ eventKind: eventKindSchema }),
    z.strictObject({ all: z.array(ruleWhenSchema).min(1) }),
    z.strictObject({ any: z.array(ruleWhenSchema).min(1) }),
    z.strictObject({ not: ruleWhenSchema }),
  ]),
);

const pluginIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);

export const ruleSchema = z.strictObject({
  id: pluginIdSchema,
  enabled: z.boolean(),
  when: ruleWhenSchema.optional(),
  detectorIds: z.array(pluginIdSchema).min(1),
  threshold: z.number().positive().max(100),
  actions: z.array(z.enum(punitiveActions)).min(1),
});

export const aggregateStrategies = ["max", "sum"] as const;

export const ruleSetSchema = z
  .strictObject({
    version: z.literal(1),
    aggregate: z.enum(aggregateStrategies),
    rules: z.array(ruleSchema),
  })
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    for (const rule of value.rules) {
      if (seen.has(rule.id)) {
        ctx.addIssue({
          code: "custom",
          message: "duplicate_rule_id",
          path: ["rules"],
        });
      }
      seen.add(rule.id);
    }
  });

export type Rule = z.output<typeof ruleSchema>;
export type RuleSet = z.output<typeof ruleSetSchema>;
export type AggregateStrategy = (typeof aggregateStrategies)[number];

export function parseRuleSet(input: unknown): RuleSet {
  return ruleSetSchema.parse(input);
}

export function matchesWhen(when: RuleWhen | undefined, event: Event): boolean {
  if (!when) {
    return true;
  }
  if ("eventKind" in when) {
    return when.eventKind === event.kind;
  }
  if ("all" in when) {
    return when.all.every((item) => matchesWhen(item, event));
  }
  if ("any" in when) {
    return when.any.some((item) => matchesWhen(item, event));
  }
  return !matchesWhen(when.not, event);
}

export function aggregateScores(
  strategy: AggregateStrategy,
  scores: readonly number[],
): number {
  if (scores.length === 0) {
    return 0;
  }
  if (strategy === "max") {
    return Math.max(...scores);
  }
  let total = 0;
  for (const score of scores) {
    total += score;
  }
  return total;
}
