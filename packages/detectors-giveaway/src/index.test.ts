import { type Event, parseEvent } from "@tasb/core";
import { describe, expect, it } from "vitest";
import { createGiveawayDetector } from "./index.js";

const title = "抽奖频道";

function eventFor(input: {
  kind?: "message" | "chat_member";
  asGiveaway?: true;
}): Event {
  const kind = input.kind ?? "message";
  return parseEvent({
    id: "evt_giveaway",
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
            textSha256: "a".repeat(64),
            ...(input.asGiveaway ? { asGiveaway: true as const } : {}),
          },
        }
      : {}),
  });
}

describe("giveaway card detector", () => {
  const detector = createGiveawayDetector();

  it("scores only a giveaway card", async () => {
    const hit = await detector.detect({
      event: eventFor({ asGiveaway: true }),
      logger: { info() {}, warn() {}, error() {} },
      signal: { aborted: false },
    });
    expect(hit).toEqual({
      detectorId: "giveaway_card",
      score: 1,
      reasons: ["giveaway_card"],
      evidence: [{ kind: "feature", summary: "giveaway:card" }],
    });
    expect(JSON.stringify(hit)).not.toContain(title);
    expect(
      await detector.detect({
        event: eventFor({}),
        logger: { info() {}, warn() {}, error() {} },
        signal: { aborted: false },
      }),
    ).toBeNull();
    expect(
      await detector.detect({
        event: eventFor({ kind: "chat_member", asGiveaway: true }),
        logger: { info() {}, warn() {}, error() {} },
        signal: { aborted: false },
      }),
    ).toBeNull();
  });
});
