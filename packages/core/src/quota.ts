import { z } from "zod";

export const quotaPeriods = ["calendar_month", "rolling_30d"] as const;
export const quotaPeriodSchema = z.enum(quotaPeriods);
export type QuotaPeriod = z.output<typeof quotaPeriodSchema>;

export const quotaSnapshotSchema = z.strictObject({
  enabled: z.boolean(),
  used: z.number().int().nonnegative().max(1_000_000),
  limit: z.number().int().positive().max(1_000_000),
  period: quotaPeriodSchema,
  degraded: z.boolean(),
});

export type QuotaSnapshot = z.output<typeof quotaSnapshotSchema>;

/** Read-only view for private commands. Counting stays outside core. */
export interface QuotaReader {
  read(tenantId: string, chatId: string, atIso: string): Promise<unknown>;
}
