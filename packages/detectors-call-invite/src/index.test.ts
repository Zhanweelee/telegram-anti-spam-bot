import { type Event, parseEvent } from "@tasb/core";
import { describe, expect, it } from "vitest";
import { createCallInviteDetector } from "./index.js";

const name = "视频邀请广告名";

function eventFor(input: {
  kind?: "message" | "chat_member";
  asCallInvite?: true;
}): Event {
  const kind = input.kind ?? "message";
  return parseEvent({
    id: "evt_call_invite",
    tenantId: "tenant_demo",
    chatId: "chat_demo",
    kind,
    occurredAt: "2026-11-01T00:00:00.000Z",
    actor: { id: "user_1", isAdmin: false },
    ...(kind === "message"
      ? {
          message: {
            id: "msg_1",
            text: name,
            textSha256: "b".repeat(64),
            ...(input.asCallInvite ? { asCallInvite: true as const } : {}),
          },
        }
      : {}),
  });
}

describe("video-chat invite detector", () => {
  const detector = createCallInviteDetector();

  it("scores an invite and leaves the name out of the hit", async () => {
    const hit = await detector.detect({
      event: eventFor({ asCallInvite: true }),
      logger: { info() {}, warn() {}, error() {} },
      signal: { aborted: false },
    });
    expect(hit).toEqual({
      detectorId: "call_invite",
      score: 1,
      reasons: ["call_invite"],
      evidence: [{ kind: "feature", summary: "invite:video" }],
    });
    expect(JSON.stringify(hit)).not.toContain(name);
    expect(
      await detector.detect({
        event: eventFor({}),
        logger: { info() {}, warn() {}, error() {} },
        signal: { aborted: false },
      }),
    ).toBeNull();
    expect(
      await detector.detect({
        event: eventFor({ kind: "chat_member", asCallInvite: true }),
        logger: { info() {}, warn() {}, error() {} },
        signal: { aborted: false },
      }),
    ).toBeNull();
  });
});
