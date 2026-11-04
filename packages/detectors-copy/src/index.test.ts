import { type Event, parseEvent } from "@tasb/core";
import { describe, expect, it } from "vitest";
import { createCopyTextDetector } from "./index.js";

function eventFor(input: {
  kind?: "message" | "chat_member";
  asCopyText?: true;
  asCustomEmoji?: true;
}): Event {
  const kind = input.kind ?? "message";
  return parseEvent({
    id: "evt_copy_text",
    tenantId: "tenant_demo",
    chatId: "chat_demo",
    kind,
    occurredAt: "2026-11-01T00:00:00.000Z",
    actor: { id: "user_1", isAdmin: false },
    ...(kind === "message"
      ? {
          message: {
            id: "msg_1",
            text: "复制广告",
            textSha256: "e".repeat(64),
            ...(input.asCopyText ? { asCopyText: true as const } : {}),
            ...(input.asCustomEmoji ? { asCustomEmoji: true as const } : {}),
          },
        }
      : {}),
  });
}

describe("copy text detector", () => {
  const detector = createCopyTextDetector();
  const logger = { info() {}, warn() {}, error() {} };

  it("scores a copy button and leaves the sentence out of the hit", async () => {
    const hit = await detector.detect({
      event: eventFor({ asCopyText: true }),
      logger,
      signal: { aborted: false },
    });
    expect(hit).toEqual({
      detectorId: "copy_text",
      score: 1,
      reasons: ["copy_text"],
      evidence: [{ kind: "feature", summary: "button:copy_text" }],
    });
    expect(JSON.stringify(hit)).not.toContain("90251");
    expect(
      await detector.detect({
        event: eventFor({}),
        logger,
        signal: { aborted: false },
      }),
    ).toBeNull();
    expect(
      await detector.detect({
        event: eventFor({ kind: "chat_member", asCopyText: true }),
        logger,
        signal: { aborted: false },
      }),
    ).toBeNull();
    expect(
      await detector.detect({
        event: eventFor({ asCustomEmoji: true }),
        logger,
        signal: { aborted: false },
      }),
    ).toBeNull();
  });
});
