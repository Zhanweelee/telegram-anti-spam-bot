import { type Event, parseEvent } from "@tasb/core";
import { describe, expect, it } from "vitest";
import { createPendingDetector } from "./index.js";

function eventFor(input: {
  kind?: "message" | "chat_member";
  asPostPending?: true;
}): Event {
  const kind = input.kind ?? "message";
  return parseEvent({
    id: "evt_post_pending",
    tenantId: "tenant_demo",
    chatId: "chat_demo",
    kind,
    occurredAt: "2026-11-01T00:00:00.000Z",
    actor: { id: "user_1", isAdmin: false },
    ...(kind === "message"
      ? {
          message: {
            id: "msg_1",
            text: "",
            textSha256: "e".repeat(64),
            ...(input.asPostPending ? { asPostPending: true as const } : {}),
          },
        }
      : {}),
  });
}

describe("pending suggested post detector", () => {
  const detector = createPendingDetector();

  it("scores a pending suggested post and leaves the price out of the hit", async () => {
    const hit = await detector.detect({
      event: eventFor({ asPostPending: true }),
      logger: { info() {}, warn() {}, error() {} },
      signal: { aborted: false },
    });
    expect(hit).toEqual({
      detectorId: "post_pending",
      score: 1,
      reasons: ["post_pending"],
      evidence: [{ kind: "feature", summary: "post:pending" }],
    });
    expect(JSON.stringify(hit)).not.toContain("90208");
    expect(
      await detector.detect({
        event: eventFor({}),
        logger: { info() {}, warn() {}, error() {} },
        signal: { aborted: false },
      }),
    ).toBeNull();
    expect(
      await detector.detect({
        event: eventFor({ kind: "chat_member", asPostPending: true }),
        logger: { info() {}, warn() {}, error() {} },
        signal: { aborted: false },
      }),
    ).toBeNull();
  });
});
