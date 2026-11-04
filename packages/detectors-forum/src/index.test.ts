import { type Event, parseEvent } from "@tasb/core";
import { describe, expect, it } from "vitest";
import { createForumDetector } from "./index.js";

const title = "关掉广告名";

function eventFor(input: {
  kind?: "message" | "chat_member";
  forumNotice?: "closed" | "reopened" | "hidden" | "shown";
}): Event {
  const kind = input.kind ?? "message";
  return parseEvent({
    id: "evt_forum_notice",
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
            ...(input.forumNotice ? { forumNotice: input.forumNotice } : {}),
          },
        }
      : {}),
  });
}

describe("forum notice detector", () => {
  const detector = createForumDetector();

  it("scores a close, a reopen, a hide, and a show", async () => {
    for (const forumNotice of [
      "closed",
      "reopened",
      "hidden",
      "shown",
    ] as const) {
      const hit = await detector.detect({
        event: eventFor({ forumNotice }),
        logger: { info() {}, warn() {}, error() {} },
        signal: { aborted: false },
      });
      expect(hit).toEqual({
        detectorId: "forum_notice",
        score: 1,
        reasons: ["forum_notice"],
        evidence: [{ kind: "feature", summary: `forum:${forumNotice}` }],
      });
      expect(JSON.stringify(hit)).not.toContain(title);
    }
    expect(
      await detector.detect({
        event: eventFor({}),
        logger: { info() {}, warn() {}, error() {} },
        signal: { aborted: false },
      }),
    ).toBeNull();
    expect(
      await detector.detect({
        event: eventFor({ kind: "chat_member", forumNotice: "closed" }),
        logger: { info() {}, warn() {}, error() {} },
        signal: { aborted: false },
      }),
    ).toBeNull();
  });
});
