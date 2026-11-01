import { z } from "zod";
import type { Decision } from "./decision.js";
import type { Event } from "./event.js";
import { assertNoRawContent } from "./privacy.js";

const idSchema = z.string().min(1).max(128);
const tokenSchema = z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/);
const ruleIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);

export const reportNoticeSchema = z.strictObject({
  tenantId: idSchema,
  chatId: idSchema,
  eventId: idSchema,
  score: z.number().min(0).max(100),
  reasons: z.array(tokenSchema).max(8),
  ruleIds: z.array(ruleIdSchema).max(8),
});

export type ReportNotice = z.output<typeof reportNoticeSchema>;

export interface Notifier {
  notify(notice: ReportNotice): Promise<void>;
}

export function buildReportNotice(
  event: Event,
  decision: Decision,
): ReportNotice {
  const notice = reportNoticeSchema.parse({
    tenantId: event.tenantId,
    chatId: event.chatId,
    eventId: event.id,
    score: decision.score,
    reasons: decision.reasons
      .filter((reason) => tokenSchema.safeParse(reason).success)
      .slice(0, 8),
    ruleIds: decision.ruleIds
      .filter((ruleId) => ruleIdSchema.safeParse(ruleId).success)
      .slice(0, 8),
  });
  assertNoRawContent(notice, event.message?.text);
  return notice;
}

export function formatReportNotice(notice: ReportNotice): string {
  const parsed = reportNoticeSchema.parse(notice);
  const rules = parsed.ruleIds.join(",") || "none";
  const reasons = parsed.reasons.join(",") || "none";
  return `report ${parsed.chatId} ${parsed.eventId} score ${parsed.score} rules ${rules} reasons ${reasons}`;
}

export function createMemoryNotifier(): Notifier & {
  readonly notices: ReportNotice[];
} {
  const notices: ReportNotice[] = [];
  return {
    notices,
    async notify(notice) {
      notices.push(reportNoticeSchema.parse(notice));
    },
  };
}
