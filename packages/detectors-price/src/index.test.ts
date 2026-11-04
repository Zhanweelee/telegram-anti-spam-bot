import { type Event, parseEvent } from "@tasb/core";
import { describe, expect, it } from "vitest";
import { createPriceDetector } from "./index.js";

const actor = "改价的人";

function eventFor(input: {
  kind?: "message" | "chat_member";
  priceNotice?: "paid" | "direct";
}): Event {
  const kind = input.kind ?? "message";
  return parseEvent({
    id: "evt_price_notice",
    tenantId: "tenant_demo",
    chatId: "chat_demo",
    kind,
    occurredAt: "2026-11-01T00:00:00.000Z",
    actor: { id: "user_1", isAdmin: false },
    ...(kind === "message"
      ? {
          message: {
            id: "msg_1",
            text: actor,
            textSha256: "b".repeat(64),
            ...(input.priceNotice ? { priceNotice: input.priceNotice } : {}),
          },
        }
      : {}),
  });
}

describe("price notice detector", () => {
  const detector = createPriceDetector();

  it("scores a paid change and a direct change", async () => {
    for (const priceNotice of ["paid", "direct"] as const) {
      const hit = await detector.detect({
        event: eventFor({ priceNotice }),
        logger: { info() {}, warn() {}, error() {} },
        signal: { aborted: false },
      });
      expect(hit).toEqual({
        detectorId: "price_notice",
        score: 1,
        reasons: ["price_notice"],
        evidence: [{ kind: "feature", summary: `price:${priceNotice}` }],
      });
      expect(JSON.stringify(hit)).not.toContain(actor);
      expect(JSON.stringify(hit)).not.toContain("90188");
    }
    expect(
      await detector.detect({
        event: eventFor({}),
        logger: { info() {}, warn() {}, error() {} },
        signal: { aborted: false },
      }),
    ).toBeNull();
    expect(
      await detector.detect({
        event: eventFor({ kind: "chat_member", priceNotice: "paid" }),
        logger: { info() {}, warn() {}, error() {} },
        signal: { aborted: false },
      }),
    ).toBeNull();
  });
});
