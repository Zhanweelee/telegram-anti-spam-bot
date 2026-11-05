import { type Event, parseEvent } from "@tasb/core";
import { describe, expect, it } from "vitest";
import { createEffectDetector } from "./index.js";

function eventFor(input: {
  kind?: "message" | "chat_member";
  asEffect?: true;
}): Event {
  const kind = input.kind ?? "message";
  return parseEvent({
    id: "evt_message_effect",
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
            ...(input.asEffect ? { asEffect: true as const } : {}),
          },
        }
      : {}),
  });
}

describe("message effect detector", () => {
  const detector = createEffectDetector();

  it("scores an effect and leaves the id out of the hit", async () => {
    const hit = await detector.detect({
      event: eventFor({ asEffect: true }),
      logger: { info() {}, warn() {}, error() {} },
      signal: { aborted: false },
    });
    expect(hit).toEqual({
      detectorId: "message_effect",
      score: 1,
      reasons: ["message_effect"],
      evidence: [{ kind: "feature", summary: "effect:message" }],
    });
    expect(JSON.stringify(hit)).not.toContain("fx5982secret");
    expect(
      await detector.detect({
        event: eventFor({}),
        logger: { info() {}, warn() {}, error() {} },
        signal: { aborted: false },
      }),
    ).toBeNull();
    expect(
      await detector.detect({
        event: eventFor({ kind: "chat_member", asEffect: true }),
        logger: { info() {}, warn() {}, error() {} },
        signal: { aborted: false },
      }),
    ).toBeNull();
  });
});
