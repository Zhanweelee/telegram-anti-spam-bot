import { type Event, parseEvent } from "@tasb/core";
import { describe, expect, it } from "vitest";
import { createCustomEmojiDetector } from "./index.js";

function eventFor(input: {
  kind?: "message" | "chat_member";
  asCustomEmoji?: true;
  asTextMention?: true;
}): Event {
  const kind = input.kind ?? "message";
  return parseEvent({
    id: "evt_custom_emoji",
    tenantId: "tenant_demo",
    chatId: "chat_demo",
    kind,
    occurredAt: "2026-11-01T00:00:00.000Z",
    actor: { id: "user_1", isAdmin: false },
    ...(kind === "message"
      ? {
          message: {
            id: "msg_1",
            text: "表情广告",
            textSha256: "e".repeat(64),
            ...(input.asCustomEmoji ? { asCustomEmoji: true as const } : {}),
            ...(input.asTextMention ? { asTextMention: true as const } : {}),
          },
        }
      : {}),
  });
}

describe("custom emoji detector", () => {
  const detector = createCustomEmojiDetector();
  const logger = { info() {}, warn() {}, error() {} };

  it("scores a custom emoji and leaves the id out of the hit", async () => {
    const hit = await detector.detect({
      event: eventFor({ asCustomEmoji: true }),
      logger,
      signal: { aborted: false },
    });
    expect(hit).toEqual({
      detectorId: "custom_emoji",
      score: 1,
      reasons: ["custom_emoji"],
      evidence: [{ kind: "feature", summary: "entity:custom_emoji" }],
    });
    expect(JSON.stringify(hit)).not.toContain("90246");
    expect(
      await detector.detect({
        event: eventFor({}),
        logger,
        signal: { aborted: false },
      }),
    ).toBeNull();
    expect(
      await detector.detect({
        event: eventFor({ kind: "chat_member", asCustomEmoji: true }),
        logger,
        signal: { aborted: false },
      }),
    ).toBeNull();
    expect(
      await detector.detect({
        event: eventFor({ asTextMention: true }),
        logger,
        signal: { aborted: false },
      }),
    ).toBeNull();
  });
});
