import { type Event, parseEvent } from "@tasb/core";
import { describe, expect, it } from "vitest";
import { createStickerEmojiDetector } from "./index.js";

function eventFor(input: {
  kind?: "message" | "chat_member";
  asStickerEmoji?: true;
  asCustomEmoji?: true;
}): Event {
  const kind = input.kind ?? "message";
  return parseEvent({
    id: "evt_sticker_emoji",
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
            ...(input.asStickerEmoji ? { asStickerEmoji: true as const } : {}),
            ...(input.asCustomEmoji ? { asCustomEmoji: true as const } : {}),
          },
        }
      : {}),
  });
}

describe("sticker emoji detector", () => {
  const detector = createStickerEmojiDetector();
  const logger = { info() {}, warn() {}, error() {} };

  it("scores a sticker emoji and leaves the id out of the hit", async () => {
    const hit = await detector.detect({
      event: eventFor({ asStickerEmoji: true }),
      logger,
      signal: { aborted: false },
    });
    expect(hit).toEqual({
      detectorId: "sticker_emoji",
      score: 1,
      reasons: ["sticker_emoji"],
      evidence: [{ kind: "feature", summary: "sticker:sticker_emoji" }],
    });
    expect(JSON.stringify(hit)).not.toContain("90276");
    expect(
      await detector.detect({
        event: eventFor({}),
        logger,
        signal: { aborted: false },
      }),
    ).toBeNull();
    expect(
      await detector.detect({
        event: eventFor({ kind: "chat_member", asStickerEmoji: true }),
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
