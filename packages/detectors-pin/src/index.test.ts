import { type Event, parseEvent } from "@tasb/core";
import { describe, expect, it } from "vitest";
import { createPinDetector } from "./index.js";

const title = "置顶广告正文";

function eventFor(input: {
  kind?: "message" | "chat_member";
  asPin?: true;
}): Event {
  const kind = input.kind ?? "message";
  return parseEvent({
    id: "evt_pin_notice",
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
            ...(input.asPin ? { asPin: true as const } : {}),
          },
        }
      : {}),
  });
}

describe("pin notice detector", () => {
  const detector = createPinDetector();

  it("scores a pin service line and leaves the pinned text out", async () => {
    const hit = await detector.detect({
      event: eventFor({ asPin: true }),
      logger: { info() {}, warn() {}, error() {} },
      signal: { aborted: false },
    });
    expect(hit).toEqual({
      detectorId: "pin_notice",
      score: 1,
      reasons: ["pin_notice"],
      evidence: [{ kind: "feature", summary: "pin:notice" }],
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
        event: eventFor({ kind: "chat_member", asPin: true }),
        logger: { info() {}, warn() {}, error() {} },
        signal: { aborted: false },
      }),
    ).toBeNull();
  });
});
