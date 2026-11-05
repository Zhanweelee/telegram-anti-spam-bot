import { z } from "zod";
import { punitiveActions } from "./decision.js";
import { type Event, eventKindSchema } from "./event.js";

export type RuleWhen =
  | { readonly eventKind: z.output<typeof eventKindSchema> }
  | { readonly serviceName: true }
  | { readonly senderTag: true }
  | { readonly buttonText: true }
  | { readonly authorSignature: true }
  | { readonly mirrorSignature: true }
  | { readonly pollOption: true }
  | { readonly checklistTask: true }
  | { readonly mediaName: true }
  | { readonly performer: true }
  | { readonly gameText: true }
  | { readonly invoiceText: true }
  | { readonly venueAddress: true }
  | { readonly pollExplanation: true }
  | { readonly all: readonly RuleWhen[] }
  | { readonly any: readonly RuleWhen[] }
  | { readonly not: RuleWhen };

export const ruleWhenSchema: z.ZodType<RuleWhen> = z.lazy(() =>
  z.union([
    z.strictObject({ eventKind: eventKindSchema }),
    z.strictObject({ serviceName: z.literal(true) }),
    z.strictObject({ senderTag: z.literal(true) }),
    z.strictObject({ buttonText: z.literal(true) }),
    z.strictObject({ authorSignature: z.literal(true) }),
    z.strictObject({ mirrorSignature: z.literal(true) }),
    z.strictObject({ pollOption: z.literal(true) }),
    z.strictObject({ checklistTask: z.literal(true) }),
    z.strictObject({ mediaName: z.literal(true) }),
    z.strictObject({ performer: z.literal(true) }),
    z.strictObject({ gameText: z.literal(true) }),
    z.strictObject({ invoiceText: z.literal(true) }),
    z.strictObject({ venueAddress: z.literal(true) }),
    z.strictObject({ pollExplanation: z.literal(true) }),
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
  if ("serviceName" in when) {
    return serviceName(event);
  }
  if ("senderTag" in when) {
    return senderTag(event);
  }
  if ("buttonText" in when) {
    return buttonText(event);
  }
  if ("authorSignature" in when) {
    return authorSignature(event);
  }
  if ("mirrorSignature" in when) {
    return mirrorSignature(event);
  }
  if ("pollOption" in when) {
    return pollOption(event);
  }
  if ("checklistTask" in when) {
    return checklistTask(event);
  }
  if ("mediaName" in when) {
    return mediaName(event);
  }
  if ("performer" in when) {
    return performer(event);
  }
  if ("gameText" in when) {
    return gameText(event);
  }
  if ("invoiceText" in when) {
    return invoiceText(event);
  }
  if ("venueAddress" in when) {
    return venueAddress(event);
  }
  if ("pollExplanation" in when) {
    return pollExplanation(event);
  }
  if ("all" in when) {
    return when.all.every((item) => matchesWhen(item, event));
  }
  if ("any" in when) {
    return when.any.some((item) => matchesWhen(item, event));
  }
  return !matchesWhen(when.not, event);
}

function pollExplanation(event: Event): boolean {
  return event.message?.pollExplanation !== undefined;
}

function venueAddress(event: Event): boolean {
  return event.message?.venueAddress !== undefined;
}

function invoiceText(event: Event): boolean {
  return event.message?.invoiceText !== undefined;
}

function gameText(event: Event): boolean {
  return event.message?.gameText !== undefined;
}

function performer(event: Event): boolean {
  return event.message?.performer !== undefined;
}

function mediaName(event: Event): boolean {
  return event.message?.mediaName !== undefined;
}

function checklistTask(event: Event): boolean {
  return event.message?.checklistTask !== undefined;
}

function pollOption(event: Event): boolean {
  return event.message?.pollOption !== undefined;
}

function mirrorSignature(event: Event): boolean {
  return event.message?.mirrorSignature !== undefined;
}

function authorSignature(event: Event): boolean {
  return event.message?.authorSignature !== undefined;
}

function buttonText(event: Event): boolean {
  return event.message?.buttonText !== undefined;
}

function senderTag(event: Event): boolean {
  return event.message?.senderTag !== undefined;
}

function serviceName(event: Event): boolean {
  const message = event.message;
  if (!message) {
    return false;
  }
  return (
    message.notice === "join" ||
    message.asCallInvite === true ||
    message.ownerNotice !== undefined ||
    message.asProximity === true
  );
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
