import { z } from "zod";
import { type Evidence, evidenceSchema } from "./evidence.js";

export const punitiveActions = [
  "log",
  "report",
  "captcha",
  "decline",
  "delete",
  "mute",
  "ban",
] as const;
export const decisionActions = ["allow", ...punitiveActions] as const;

export const decisionActionSchema = z.enum(decisionActions);
export type DecisionAction = z.output<typeof decisionActionSchema>;

const severity: Record<DecisionAction, number> = {
  allow: 0,
  log: 1,
  report: 2,
  captcha: 3,
  decline: 4,
  delete: 5,
  mute: 6,
  ban: 7,
};

export function moreSevere(
  left: DecisionAction,
  right: DecisionAction,
): DecisionAction {
  return severity[left] >= severity[right] ? left : right;
}

export interface Decision {
  readonly action: DecisionAction;
  readonly ruleIds: readonly string[];
  readonly score: number;
  readonly reasons: readonly string[];
  readonly evidence: readonly Evidence[];
}

export const detectorHitSchema = z.strictObject({
  detectorId: z.string().min(1),
  score: z.number().min(0).max(1),
  reasons: z.array(z.string().min(1)).min(1),
  evidence: z.array(evidenceSchema),
});

export type DetectorHit = z.output<typeof detectorHitSchema>;
