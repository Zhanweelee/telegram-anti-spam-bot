import { z } from "zod";
import { decisionActionSchema } from "./decision.js";
import { type AuditScope, parseAuditScope } from "./ports.js";
import { assertNoRawContent } from "./privacy.js";
import {
  parseReviewSample,
  type ReviewLabel,
  type ReviewSample,
} from "./review.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const idSchema = z.string().min(1).max(128);

export const feedbackLabels = ["spam", "ham"] as const;
export const feedbackLabelSchema = z.enum(feedbackLabels);
export type FeedbackLabel = z.output<typeof feedbackLabelSchema>;

export const feedbackCaseSchema = z.strictObject({
  id: idSchema,
  chatId: idSchema,
  label: feedbackLabelSchema,
  textSha256: sha256Schema.optional(),
  action: decisionActionSchema,
  score: z.number().finite().min(0),
  reasons: z.array(z.string().min(1).max(80)).max(16),
  ruleIds: z.array(z.string().min(1).max(64)).max(16),
});

export type FeedbackCase = z.output<typeof feedbackCaseSchema>;

export const feedbackEvalDocumentSchema = z.strictObject({
  tenantId: idSchema,
  chatId: idSchema.optional(),
  cases: z.array(feedbackCaseSchema).max(256),
});

export type FeedbackEvalDocument = z.output<typeof feedbackEvalDocumentSchema>;

export function parseFeedbackCase(input: unknown): FeedbackCase {
  return feedbackCaseSchema.parse(input);
}

/** `confirmed` is spam. `false_positive` is ham. */
export function feedbackLabelFromReview(label: ReviewLabel): FeedbackLabel {
  return label === "confirmed" ? "spam" : "ham";
}

/** Copy hash and features. Message text and evidence stay out. */
export function buildFeedbackCase(sample: ReviewSample): FeedbackCase {
  const parsed = parseReviewSample(sample);
  const item = {
    id: parsed.eventId,
    chatId: parsed.chatId,
    label: feedbackLabelFromReview(parsed.label),
    ...(parsed.textSha256 === undefined
      ? {}
      : { textSha256: parsed.textSha256 }),
    action: parsed.action,
    score: parsed.score,
    reasons: parsed.reasons,
    ruleIds: parsed.ruleIds,
  };
  const result = parseFeedbackCase(item);
  assertNoRawContent(result);
  return result;
}

export function feedbackEvalDocument(
  scope: AuditScope,
  samples: readonly ReviewSample[],
): string {
  const parsedScope = parseAuditScope(scope);
  const document = {
    tenantId: parsedScope.tenantId,
    ...(parsedScope.chatId === undefined ? {} : { chatId: parsedScope.chatId }),
    cases: samples.map((sample) => buildFeedbackCase(sample)),
  };
  const parsed = feedbackEvalDocumentSchema.parse(document);
  assertNoRawContent(parsed);
  return JSON.stringify(parsed);
}
