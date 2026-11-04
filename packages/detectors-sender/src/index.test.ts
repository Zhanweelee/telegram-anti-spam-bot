import { type Event, parseEvent } from "@tasb/core";
import { describe, expect, it } from "vitest";
import { createSenderDetector } from "./index.js";

const title = "机密频道代发";

function eventFor(input: {
  kind?: "message" | "chat_member";
  asChannel?: true;
}): Event {
  const kind = input.kind ?? "message";
  return parseEvent({
    id: "evt_sender",
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
            textSha256: "c".repeat(64),
            ...(input.asChannel ? { asChannel: true as const } : {}),
          },
        }
      : {}),
  });
}

describe("channel sender detector", () => {
  const detector = createSenderDetector();

  it("scores only a message sent as another channel", async () => {
    const hit = await detector.detect({
      event: eventFor({ asChannel: true }),
      logger: { info() {}, warn() {}, error() {} },
      signal: { aborted: false },
    });
    expect(hit).toEqual({
      detectorId: "channel_sender",
      score: 1,
      reasons: ["channel_sender"],
      evidence: [{ kind: "feature", summary: "sender:channel" }],
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
        event: eventFor({ kind: "chat_member", asChannel: true }),
        logger: { info() {}, warn() {}, error() {} },
        signal: { aborted: false },
      }),
    ).toBeNull();
  });
});
