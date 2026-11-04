import { type Event, parseEvent } from "@tasb/core";
import { describe, expect, it } from "vitest";
import { createProximityDetector } from "./index.js";

const traveler = "靠近广告名";
const watcher = "守位置的人";

function eventFor(input: {
  kind?: "message" | "chat_member";
  asProximity?: true;
}): Event {
  const kind = input.kind ?? "message";
  return parseEvent({
    id: "evt_proximity_notice",
    tenantId: "tenant_demo",
    chatId: "chat_demo",
    kind,
    occurredAt: "2026-11-01T00:00:00.000Z",
    actor: { id: "user_1", isAdmin: false },
    ...(kind === "message"
      ? {
          message: {
            id: "msg_1",
            text: `${traveler} ${watcher}`,
            textSha256: "b".repeat(64),
            ...(input.asProximity ? { asProximity: true as const } : {}),
          },
        }
      : {}),
  });
}

describe("proximity alert detector", () => {
  const detector = createProximityDetector();

  it("scores an alert and leaves the names out of the hit", async () => {
    const hit = await detector.detect({
      event: eventFor({ asProximity: true }),
      logger: { info() {}, warn() {}, error() {} },
      signal: { aborted: false },
    });
    expect(hit).toEqual({
      detectorId: "proximity_notice",
      score: 1,
      reasons: ["proximity_notice"],
      evidence: [{ kind: "feature", summary: "proximity:near" }],
    });
    const dumped = JSON.stringify(hit);
    expect(dumped).not.toContain(traveler);
    expect(dumped).not.toContain(watcher);
    expect(
      await detector.detect({
        event: eventFor({}),
        logger: { info() {}, warn() {}, error() {} },
        signal: { aborted: false },
      }),
    ).toBeNull();
    expect(
      await detector.detect({
        event: eventFor({ kind: "chat_member", asProximity: true }),
        logger: { info() {}, warn() {}, error() {} },
        signal: { aborted: false },
      }),
    ).toBeNull();
  });
});
