import { z } from "zod";
import { decisionActionSchema } from "./decision.js";
import { type AuditRecord, type AuditScope, parseAuditScope } from "./ports.js";
import { assertNoRawContent } from "./privacy.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const isoSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/);
const idSchema = z.string().min(1).max(128);

export const MAX_REVIEW_SAMPLES = 256;

export const reviewLabels = ["false_positive", "confirmed"] as const;
export const reviewLabelSchema = z.enum(reviewLabels);
export type ReviewLabel = z.output<typeof reviewLabelSchema>;

export const reviewSampleSchema = z.strictObject({
  tenantId: idSchema,
  chatId: idSchema,
  eventId: idSchema,
  label: reviewLabelSchema,
  textSha256: sha256Schema.optional(),
  action: decisionActionSchema,
  score: z.number().finite().min(0),
  reasons: z.array(z.string().min(1).max(80)).max(16),
  ruleIds: z.array(z.string().min(1).max(64)).max(16),
  createdAt: isoSchema,
});

export type ReviewSample = z.output<typeof reviewSampleSchema>;

export class ReviewCapacityError extends Error {
  constructor() {
    super("review_full");
    this.name = "ReviewCapacityError";
  }
}

export interface ReviewQueue {
  enqueue(sample: ReviewSample): Promise<void>;
  list(scope: AuditScope): Promise<readonly ReviewSample[]>;
}

export function parseReviewSample(input: unknown): ReviewSample {
  return reviewSampleSchema.parse(input);
}

/** Copy hash and features from an audit. Evidence and message text stay out. */
export function buildReviewSample(
  audit: AuditRecord,
  label: ReviewLabel,
  createdAt: string,
): ReviewSample {
  const sample = {
    tenantId: audit.tenantId,
    chatId: audit.chatId,
    eventId: audit.eventId,
    label,
    ...(audit.textSha256 === undefined ? {} : { textSha256: audit.textSha256 }),
    action: audit.action,
    score: audit.score,
    reasons: audit.reasons.slice(0, 16).map(shortFeature),
    ruleIds: audit.ruleIds
      .slice(0, 16)
      .map((id) => id.slice(0, 64))
      .filter((id) => id.length > 0),
    createdAt,
  };
  const parsed = parseReviewSample(sample);
  assertNoRawContent(parsed);
  return parsed;
}

export function createMemoryReviewQueue(): ReviewQueue {
  const tenants = new Map<string, Map<string, Map<string, ReviewSample>>>();
  return {
    async enqueue(sample) {
      const parsed = parseReviewSample(sample);
      assertNoRawContent(parsed);
      const chats = tenants.get(parsed.tenantId) ?? new Map();
      const events = chats.get(parsed.chatId) ?? new Map();
      if (
        !events.has(parsed.eventId) &&
        countTenant(chats) >= MAX_REVIEW_SAMPLES
      ) {
        throw new ReviewCapacityError();
      }
      events.set(parsed.eventId, parsed);
      chats.set(parsed.chatId, events);
      tenants.set(parsed.tenantId, chats);
    },
    async list(scope) {
      const parsed = parseAuditScope(scope);
      const chats = tenants.get(parsed.tenantId);
      if (!chats) {
        return [];
      }
      const samples: ReviewSample[] = [];
      for (const [chatId, events] of chats) {
        if (parsed.chatId !== undefined && chatId !== parsed.chatId) {
          continue;
        }
        samples.push(...events.values());
      }
      samples.sort(byTime);
      return samples;
    },
  };
}

function shortFeature(value: string): string {
  if (value.length === 0 || value.length > 80 || /[\r\n]/.test(value)) {
    return "redacted";
  }
  return value;
}

function countTenant(
  chats: ReadonlyMap<string, ReadonlyMap<string, ReviewSample>>,
): number {
  let total = 0;
  for (const events of chats.values()) {
    total += events.size;
  }
  return total;
}

function byTime(left: ReviewSample, right: ReviewSample): number {
  const time = left.createdAt.localeCompare(right.createdAt);
  if (time !== 0) {
    return time;
  }
  return left.eventId.localeCompare(right.eventId);
}
