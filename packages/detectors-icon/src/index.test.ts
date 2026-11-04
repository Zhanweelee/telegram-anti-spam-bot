import { type Event, parseEvent } from "@tasb/core";
import { describe, expect, it } from "vitest";
import { createButtonEmojiDetector } from "./index.js";

function eventFor(input: {
  kind?: "message" | "chat_member";
  asButtonEmoji?: true;
  asCustomEmoji?: true;
}): Event {
  const kind = input.kind ?? "message";
  return parseEvent({
    id: "evt_button_emoji",
    tenantId: "tenant_demo",
    chatId: "chat_demo",
    kind,
    occurredAt: "2026-11-01T00:00:00.000Z",
    actor: { id: "user_1", isAdmin: false },
    ...(kind === "message"
      ? {
          message: {
            id: "msg_1",
            text: "图标广告",
            textSha256: "e".repeat(64),
            ...(input.asButtonEmoji ? { asButtonEmoji: true as const } : {}),
            ...(input.asCustomEmoji ? { asCustomEmoji: true as const } : {}),
          },
        }
      : {}),
  });
}

describe("button emoji detector", () => {
  const detector = createButtonEmojiDetector();
  const logger = { info() {}, warn() {}, error() {} };

  it("scores a button emoji and leaves the id out of the hit", async () => {
    const hit = await detector.detect({
      event: eventFor({ asButtonEmoji: true }),
      logger,
      signal: { aborted: false },
    });
    expect(hit).toEqual({
      detectorId: "button_emoji",
      score: 1,
      reasons: ["button_emoji"],
      evidence: [{ kind: "feature", summary: "button:button_emoji" }],
    });
    expect(JSON.stringify(hit)).not.toContain("90269");
    expect(
      await detector.detect({
        event: eventFor({}),
        logger,
        signal: { aborted: false },
      }),
    ).toBeNull();
    expect(
      await detector.detect({
        event: eventFor({ kind: "chat_member", asButtonEmoji: true }),
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
