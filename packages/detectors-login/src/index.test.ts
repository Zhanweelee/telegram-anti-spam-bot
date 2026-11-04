import { type Event, parseEvent } from "@tasb/core";
import { describe, expect, it } from "vitest";
import { createLoginForwardDetector } from "./index.js";

function eventFor(input: {
  kind?: "message" | "chat_member";
  asLoginForward?: true;
  asSwitchQuery?: true;
}): Event {
  const kind = input.kind ?? "message";
  return parseEvent({
    id: "evt_login_forward",
    tenantId: "tenant_demo",
    chatId: "chat_demo",
    kind,
    occurredAt: "2026-11-01T00:00:00.000Z",
    actor: { id: "user_1", isAdmin: false },
    ...(kind === "message"
      ? {
          message: {
            id: "msg_1",
            text: "登录广告",
            textSha256: "e".repeat(64),
            ...(input.asLoginForward ? { asLoginForward: true as const } : {}),
            ...(input.asSwitchQuery ? { asSwitchQuery: true as const } : {}),
          },
        }
      : {}),
  });
}

describe("login forward detector", () => {
  const detector = createLoginForwardDetector();
  const logger = { info() {}, warn() {}, error() {} };

  it("scores a login forward and leaves the sentence out of the hit", async () => {
    const hit = await detector.detect({
      event: eventFor({ asLoginForward: true }),
      logger,
      signal: { aborted: false },
    });
    expect(hit).toEqual({
      detectorId: "login_forward",
      score: 1,
      reasons: ["login_forward"],
      evidence: [{ kind: "feature", summary: "button:login_forward" }],
    });
    expect(JSON.stringify(hit)).not.toContain("90261");
    expect(
      await detector.detect({
        event: eventFor({}),
        logger,
        signal: { aborted: false },
      }),
    ).toBeNull();
    expect(
      await detector.detect({
        event: eventFor({ kind: "chat_member", asLoginForward: true }),
        logger,
        signal: { aborted: false },
      }),
    ).toBeNull();
    expect(
      await detector.detect({
        event: eventFor({ asSwitchQuery: true }),
        logger,
        signal: { aborted: false },
      }),
    ).toBeNull();
  });
});
