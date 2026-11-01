import { createMemoryRateWindow, type RateWindow } from "@tasb/detector-rate";

/** Enough room for a few senders to trip flood detection, then shed. */
export const WEBHOOK_BUDGET_LIMIT = 30;
export const WEBHOOK_BUDGET_WINDOW_MS = 10_000;

export type WebhookBudgetDecision = "allow" | "limited" | "skipped";

export interface WebhookBudget {
  allow(input: {
    readonly tenantId: string;
    readonly chatId: string;
    readonly nowMs: number;
  }): Promise<WebhookBudgetDecision>;
}

export function createWebhookBudget(
  window: RateWindow,
  limit = WEBHOOK_BUDGET_LIMIT,
): WebhookBudget {
  return {
    async allow(input) {
      if (!Number.isFinite(input.nowMs)) {
        return "skipped";
      }
      try {
        const count = await window.observe({
          key: `w\n${input.tenantId}\n${input.chatId}`,
          nowMs: input.nowMs,
          windowMs: WEBHOOK_BUDGET_WINDOW_MS,
        });
        if (count === null) {
          return "skipped";
        }
        return count > limit ? "limited" : "allow";
      } catch {
        return "skipped";
      }
    },
  };
}

export const workerWebhookBudget = createWebhookBudget(
  createMemoryRateWindow(),
);
