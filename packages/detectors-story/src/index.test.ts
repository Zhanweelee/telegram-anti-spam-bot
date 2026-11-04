import { type Event, parseEvent } from "@tasb/core";
import { describe, expect, it } from "vitest";
import { createStoryDetector } from "./index.js";

const title = "故事频道";

function eventFor(input: {
  kind?: "message" | "chat_member";
  asStory?: true;
}): Event {
  const kind = input.kind ?? "message";
  return parseEvent({
    id: "evt_story",
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
            textSha256: "d".repeat(64),
            ...(input.asStory ? { asStory: true as const } : {}),
          },
        }
      : {}),
  });
}

describe("shared story detector", () => {
  const detector = createStoryDetector();

  it("scores only a shared story card", async () => {
    const hit = await detector.detect({
      event: eventFor({ asStory: true }),
      logger: { info() {}, warn() {}, error() {} },
      signal: { aborted: false },
    });
    expect(hit).toEqual({
      detectorId: "shared_story",
      score: 1,
      reasons: ["shared_story"],
      evidence: [{ kind: "feature", summary: "story:card" }],
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
        event: eventFor({ kind: "chat_member", asStory: true }),
        logger: { info() {}, warn() {}, error() {} },
        signal: { aborted: false },
      }),
    ).toBeNull();
  });
});
