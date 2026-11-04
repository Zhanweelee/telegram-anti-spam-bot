import { type Event, parseEvent } from "@tasb/core";
import { describe, expect, it } from "vitest";
import { createTitleDetector } from "./index.js";

const title = "改名广告标题";

function eventFor(input: {
  kind?: "message" | "chat_member";
  asTitle?: true;
}): Event {
  const kind = input.kind ?? "message";
  return parseEvent({
    id: "evt_title",
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
            ...(input.asTitle ? { asTitle: true as const } : {}),
          },
        }
      : {}),
  });
}

describe("renamed chat detector", () => {
  const detector = createTitleDetector();

  it("scores a rename and ignores other messages", async () => {
    const hit = await detector.detect({
      event: eventFor({ asTitle: true }),
      logger: { info() {}, warn() {}, error() {} },
      signal: { aborted: false },
    });
    expect(hit).toEqual({
      detectorId: "chat_title",
      score: 1,
      reasons: ["chat_title"],
      evidence: [{ kind: "feature", summary: "title:rename" }],
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
        event: eventFor({ kind: "chat_member", asTitle: true }),
        logger: { info() {}, warn() {}, error() {} },
        signal: { aborted: false },
      }),
    ).toBeNull();
  });
});
