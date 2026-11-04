import { type Event, parseEvent } from "@tasb/core";
import { describe, expect, it } from "vitest";
import { createCallDetector } from "./index.js";

const duration = "90177";

function eventFor(input: {
  kind?: "message" | "chat_member";
  call?: "started" | "ended" | "scheduled";
}): Event {
  const kind = input.kind ?? "message";
  return parseEvent({
    id: "evt_call",
    tenantId: "tenant_demo",
    chatId: "chat_demo",
    kind,
    occurredAt: "2026-11-01T00:00:00.000Z",
    actor: { id: "user_1", isAdmin: false },
    ...(kind === "message"
      ? {
          message: {
            id: "msg_1",
            text: duration,
            textSha256: "b".repeat(64),
            ...(input.call ? { call: input.call } : {}),
          },
        }
      : {}),
  });
}

describe("video-chat notice detector", () => {
  const detector = createCallDetector();

  it("scores a start, an end, and a schedule", async () => {
    for (const call of ["started", "ended", "scheduled"] as const) {
      const hit = await detector.detect({
        event: eventFor({ call }),
        logger: { info() {}, warn() {}, error() {} },
        signal: { aborted: false },
      });
      expect(hit).toEqual({
        detectorId: "call_notice",
        score: 1,
        reasons: ["call_notice"],
        evidence: [{ kind: "feature", summary: `call:${call}` }],
      });
      expect(JSON.stringify(hit)).not.toContain(duration);
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
        event: eventFor({ kind: "chat_member", call: "started" }),
        logger: { info() {}, warn() {}, error() {} },
        signal: { aborted: false },
      }),
    ).toBeNull();
  });
});
