import { z } from "zod";

export const quotaPeriods = ["calendar_month", "rolling_30d"] as const;
export const quotaPeriodSchema = z.enum(quotaPeriods);
export type QuotaPeriod = z.output<typeof quotaPeriodSchema>;

const detectorIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);

export const quotaSnapshotSchema = z.strictObject({
  enabled: z.boolean(),
  used: z.number().int().nonnegative().max(1_000_000),
  limit: z.number().int().positive().max(1_000_000),
  period: quotaPeriodSchema,
  degraded: z.boolean(),
  basicDetectorIds: z.array(detectorIdSchema).max(32).optional(),
});

/** A rule stays when every detector is in the basic set. */
export function ruleSurvivesQuota(
  detectorIds: readonly string[],
  basicDetectorIds: readonly string[],
): boolean {
  const allowed = new Set(basicDetectorIds);
  return detectorIds.every((id) => allowed.has(id));
}

export type QuotaSnapshot = z.output<typeof quotaSnapshotSchema>;

/** Read-only view for private commands. Counting stays outside core. */
export interface QuotaReader {
  read(tenantId: string, chatId: string, atIso: string): Promise<unknown>;
}
