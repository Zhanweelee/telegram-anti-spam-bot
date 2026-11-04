import { type Event, parseEvent } from "@tasb/core";
import { describe, expect, it } from "vitest";
import { createSpoilerDetector } from "./index.js";

function eventFor(input: {
  kind?: "message" | "chat_member";
  asSpoiler?: true;
}): Event {
  const kind = input.kind ?? "message";
  return parseEvent({
    id: "evt_media_spoiler",
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
            ...(input.asSpoiler ? { asSpoiler: true as const } : {}),
          },
        }
      : {}),
  });
}

describe("spoiler media detector", () => {
  const detector = createSpoilerDetector();

  it("scores spoiler media and leaves the file id out of the hit", async () => {
    const hit = await detector.detect({
      event: eventFor({ asSpoiler: true }),
      logger: { info() {}, warn() {}, error() {} },
      signal: { aborted: false },
    });
    expect(hit).toEqual({
      detectorId: "media_spoiler",
      score: 1,
      reasons: ["media_spoiler"],
      evidence: [{ kind: "feature", summary: "media:spoiler" }],
    });
    expect(JSON.stringify(hit)).not.toContain("90209");
    expect(
      await detector.detect({
        event: eventFor({}),
        logger: { info() {}, warn() {}, error() {} },
        signal: { aborted: false },
      }),
    ).toBeNull();
    expect(
      await detector.detect({
        event: eventFor({ kind: "chat_member", asSpoiler: true }),
        logger: { info() {}, warn() {}, error() {} },
        signal: { aborted: false },
      }),
    ).toBeNull();
  });
});
