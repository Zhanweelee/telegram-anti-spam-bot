import { createMemoryRateWindow } from "@tasb/detector-rate";
import { describe, expect, it } from "vitest";
import { createWebhookBudget, WEBHOOK_BUDGET_LIMIT } from "./budget.js";

const now = Date.parse("2026-11-01T00:00:00.000Z");

describe("createWebhookBudget", () => {
  it("sheds one chat after the limit and keeps another chat open", async () => {
    const budget = createWebhookBudget(createMemoryRateWindow(), 2);
    const chat = { tenantId: "local", chatId: "-100580", nowMs: now };
    expect(await budget.allow(chat)).toBe("allow");
    expect(await budget.allow(chat)).toBe("allow");
    expect(await budget.allow(chat)).toBe("limited");
    expect(
      await budget.allow({
        tenantId: "local",
        chatId: "-100581",
        nowMs: now,
      }),
    ).toBe("allow");
  });

  it("opens the window again after it expires", async () => {
    const budget = createWebhookBudget(createMemoryRateWindow(), 1);
    const first = { tenantId: "local", chatId: "-100582", nowMs: now };
    expect(await budget.allow(first)).toBe("allow");
    expect(await budget.allow(first)).toBe("limited");
    expect(await budget.allow({ ...first, nowMs: now + 10_001 })).toBe("allow");
  });

  it("fails open when the window skips or throws", async () => {
    const skipped = createWebhookBudget({
      async observe() {
        return null;
      },
    });
    expect(
      await skipped.allow({
        tenantId: "local",
        chatId: "-100583",
        nowMs: now,
      }),
    ).toBe("skipped");
    const broken = createWebhookBudget({
      async observe() {
        throw new Error("加微x secret");
      },
    });
    expect(
      await broken.allow({
        tenantId: "local",
        chatId: "-100583",
        nowMs: Number.NaN,
      }),
    ).toBe("skipped");
    expect(
      await broken.allow({
        tenantId: "local",
        chatId: "-100583",
        nowMs: now,
      }),
    ).toBe("skipped");
    expect(WEBHOOK_BUDGET_LIMIT).toBe(30);
  });
});
