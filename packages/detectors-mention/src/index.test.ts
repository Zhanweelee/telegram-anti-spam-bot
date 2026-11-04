import { type Event, parseEvent } from "@tasb/core";
import { describe, expect, it } from "vitest";
import { createTextMentionDetector } from "./index.js";

function eventFor(input: {
  kind?: "message" | "chat_member";
  asTextMention?: true;
  asRichTextMention?: true;
}): Event {
  const kind = input.kind ?? "message";
  return parseEvent({
    id: "evt_text_mention",
    tenantId: "tenant_demo",
    chatId: "chat_demo",
    kind,
    occurredAt: "2026-11-01T00:00:00.000Z",
    actor: { id: "user_1", isAdmin: false },
    ...(kind === "message"
      ? {
          message: {
            id: "msg_1",
            text: "点名广告",
            textSha256: "e".repeat(64),
            ...(input.asTextMention ? { asTextMention: true as const } : {}),
            ...(input.asRichTextMention
              ? { asRichTextMention: true as const }
              : {}),
          },
        }
      : {}),
  });
}

describe("text mention detector", () => {
  const detector = createTextMentionDetector();
  const logger = { info() {}, warn() {}, error() {} };

  it("scores a text mention and leaves the user id out of the hit", async () => {
    const hit = await detector.detect({
      event: eventFor({ asTextMention: true }),
      logger,
      signal: { aborted: false },
    });
    expect(hit).toEqual({
      detectorId: "text_mention",
      score: 1,
      reasons: ["text_mention"],
      evidence: [{ kind: "feature", summary: "entity:text_mention" }],
    });
    expect(JSON.stringify(hit)).not.toContain("90238");
    expect(
      await detector.detect({
        event: eventFor({}),
        logger,
        signal: { aborted: false },
      }),
    ).toBeNull();
    expect(
      await detector.detect({
        event: eventFor({ kind: "chat_member", asTextMention: true }),
        logger,
        signal: { aborted: false },
      }),
    ).toBeNull();
    expect(
      await detector.detect({
        event: eventFor({ asRichTextMention: true }),
        logger,
        signal: { aborted: false },
      }),
    ).toBeNull();
  });
});
