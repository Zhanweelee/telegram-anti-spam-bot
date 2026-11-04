import { type Event, parseEvent } from "@tasb/core";
import { describe, expect, it } from "vitest";
import { createGiftDetector } from "./index.js";

const title = "礼物广告标题";

function eventFor(input: {
  kind?: "message" | "chat_member";
  gift?: "card" | "unique" | "upgrade";
}): Event {
  const kind = input.kind ?? "message";
  return parseEvent({
    id: "evt_gift_card",
    tenantId: "tenant_demo",
    chatId: "chat_demo",
    kind,
    occurredAt: "2026-11-01T00:00:00.000Z",
    actor: { id: "user_1", isAdmin: false },
    ...(kind === "message"
      ? {
          message: {
            id: "msg_1",
            text: title,
            textSha256: "b".repeat(64),
            ...(input.gift ? { gift: input.gift } : {}),
          },
        }
      : {}),
  });
}

describe("gift card detector", () => {
  const detector = createGiftDetector();

  it("scores a card, a unique gift, and an upgrade", async () => {
    for (const gift of ["card", "unique", "upgrade"] as const) {
      const hit = await detector.detect({
        event: eventFor({ gift }),
        logger: { info() {}, warn() {}, error() {} },
        signal: { aborted: false },
      });
      expect(hit).toEqual({
        detectorId: "gift_card",
        score: 1,
        reasons: ["gift_card"],
        evidence: [{ kind: "feature", summary: `gift:${gift}` }],
      });
      expect(JSON.stringify(hit)).not.toContain(title);
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
        event: eventFor({ kind: "chat_member", gift: "card" }),
        logger: { info() {}, warn() {}, error() {} },
        signal: { aborted: false },
      }),
    ).toBeNull();
  });
});
