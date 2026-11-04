import { type Event, parseEvent } from "@tasb/core";
import { describe, expect, it } from "vitest";
import { createSwitchQueryDetector } from "./index.js";

function eventFor(input: {
  kind?: "message" | "chat_member";
  asSwitchQuery?: true;
  asCopyText?: true;
}): Event {
  const kind = input.kind ?? "message";
  return parseEvent({
    id: "evt_switch_query",
    tenantId: "tenant_demo",
    chatId: "chat_demo",
    kind,
    occurredAt: "2026-11-01T00:00:00.000Z",
    actor: { id: "user_1", isAdmin: false },
    ...(kind === "message"
      ? {
          message: {
            id: "msg_1",
            text: "查询广告",
            textSha256: "e".repeat(64),
            ...(input.asSwitchQuery ? { asSwitchQuery: true as const } : {}),
            ...(input.asCopyText ? { asCopyText: true as const } : {}),
          },
        }
      : {}),
  });
}

describe("switch query detector", () => {
  const detector = createSwitchQueryDetector();
  const logger = { info() {}, warn() {}, error() {} };

  it("scores a switch query and leaves the sentence out of the hit", async () => {
    const hit = await detector.detect({
      event: eventFor({ asSwitchQuery: true }),
      logger,
      signal: { aborted: false },
    });
    expect(hit).toEqual({
      detectorId: "switch_query",
      score: 1,
      reasons: ["switch_query"],
      evidence: [{ kind: "feature", summary: "button:switch_query" }],
    });
    expect(JSON.stringify(hit)).not.toContain("90255");
    expect(
      await detector.detect({
        event: eventFor({}),
        logger,
        signal: { aborted: false },
      }),
    ).toBeNull();
    expect(
      await detector.detect({
        event: eventFor({ kind: "chat_member", asSwitchQuery: true }),
        logger,
        signal: { aborted: false },
      }),
    ).toBeNull();
    expect(
      await detector.detect({
        event: eventFor({ asCopyText: true }),
        logger,
        signal: { aborted: false },
      }),
    ).toBeNull();
  });
});
