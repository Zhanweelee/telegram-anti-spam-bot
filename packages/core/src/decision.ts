import { z } from "zod";
import { type Evidence, evidenceSchema } from "./evidence.js";

export const punitiveActions = [
  "log",
  "report",
  "captcha",
  "decline",
  "delete",
  "warn",
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
  warn: 6,
  mute: 7,
  ban: 8,
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

export const textPlaces = [
  "message",
  "profile",
  "senderTag",
  "buttonText",
  "authorSignature",
  "mirrorSignature",
  "pollOption",
  "checklistTask",
  "mediaName",
  "performer",
  "gameText",
  "invoiceText",
  "venueAddress",
  "pollExplanation",
  "pollQuestion",
  "prizeText",
  "checklistTitle",
  "gameTitle",
  "invoiceTitle",
  "venueTitle",
  "webAppButtonText",
  "quoteText",
  "giftText",
  "giftLabel",
  "topicName",
  "declineComment",
  "addedText",
  "hiddenName",
  "memberName",
  "sharedName",
  "managedName",
] as const;
export const textPlaceSchema = z.enum(textPlaces);
export type TextPlace = z.output<typeof textPlaceSchema>;

export const detectorHitSchema = z.strictObject({
  detectorId: z.string().min(1),
  score: z.number().min(0).max(1),
  reasons: z.array(z.string().min(1)).min(1),
  evidence: z.array(evidenceSchema),
  /** Which visible texts matched. Side-field rules only count their own place. */
  places: z.array(textPlaceSchema).min(1).optional(),
});

export type DetectorHit = z.output<typeof detectorHitSchema>;
