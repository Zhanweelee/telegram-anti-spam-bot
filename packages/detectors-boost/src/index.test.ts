import { type Event, parseEvent } from "@tasb/core";
import { describe, expect, it } from "vitest";
import { createBoostDetector } from "./index.js";

const title = "助推的人";

function eventFor(input: {
  kind?: "message" | "chat_member";
  asBoost?: true;
}): Event {
  const kind = input.kind ?? "message";
  return parseEvent({
    id: "evt_chat_boost",
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
            ...(input.asBoost ? { asBoost: true as const } : {}),
          },
        }
      : {}),
  });
}

describe("chat boost detector", () => {
  const detector = createBoostDetector();

  it("scores a boost service line and leaves the count out", async () => {
    const hit = await detector.detect({
      event: eventFor({ asBoost: true }),
      logger: { info() {}, warn() {}, error() {} },
      signal: { aborted: false },
    });
    expect(hit).toEqual({
      detectorId: "chat_boost",
      score: 1,
      reasons: ["chat_boost"],
      evidence: [{ kind: "feature", summary: "boost:added" }],
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
        event: eventFor({ kind: "chat_member", asBoost: true }),
        logger: { info() {}, warn() {}, error() {} },
        signal: { aborted: false },
      }),
    ).toBeNull();
  });
});
