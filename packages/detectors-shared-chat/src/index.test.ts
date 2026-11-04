import { type Event, parseEvent } from "@tasb/core";
import { describe, expect, it } from "vitest";
import { createSharedChatDetector } from "./index.js";

const title = "分享广告标题";

function eventFor(input: {
  kind?: "message" | "chat_member";
  asSharedChat?: true;
}): Event {
  const kind = input.kind ?? "message";
  return parseEvent({
    id: "evt_shared_chat",
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
            ...(input.asSharedChat ? { asSharedChat: true as const } : {}),
          },
        }
      : {}),
  });
}

describe("shared chat detector", () => {
  const detector = createSharedChatDetector();

  it("scores a shared chat and ignores other messages", async () => {
    const hit = await detector.detect({
      event: eventFor({ asSharedChat: true }),
      logger: { info() {}, warn() {}, error() {} },
      signal: { aborted: false },
    });
    expect(hit).toEqual({
      detectorId: "shared_chat",
      score: 1,
      reasons: ["shared_chat"],
      evidence: [{ kind: "feature", summary: "chat:shared" }],
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
        event: eventFor({ kind: "chat_member", asSharedChat: true }),
        logger: { info() {}, warn() {}, error() {} },
        signal: { aborted: false },
      }),
    ).toBeNull();
  });
});
