import { type Event, parseEvent } from "@tasb/core";
import { describe, expect, it } from "vitest";
import { createOwnerDetector } from "./index.js";

const name = "新群主广告名";

function eventFor(input: {
  kind?: "message" | "chat_member";
  ownerNotice?: "changed" | "left";
}): Event {
  const kind = input.kind ?? "message";
  return parseEvent({
    id: "evt_owner_notice",
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
            ...(input.ownerNotice ? { ownerNotice: input.ownerNotice } : {}),
          },
        }
      : {}),
  });
}

describe("owner notice detector", () => {
  const detector = createOwnerDetector();

  it("scores a change and leaves the name out of the hit", async () => {
    const hit = await detector.detect({
      event: eventFor({ ownerNotice: "changed" }),
      logger: { info() {}, warn() {}, error() {} },
      signal: { aborted: false },
    });
    expect(hit).toEqual({
      detectorId: "owner_notice",
      score: 1,
      reasons: ["owner_notice"],
      evidence: [{ kind: "feature", summary: "owner:changed" }],
    });
    expect(JSON.stringify(hit)).not.toContain(name);
    expect(
      (
        await detector.detect({
          event: eventFor({ ownerNotice: "left" }),
          logger: { info() {}, warn() {}, error() {} },
          signal: { aborted: false },
        })
      )?.evidence,
    ).toEqual([{ kind: "feature", summary: "owner:left" }]);
    expect(
      await detector.detect({
        event: eventFor({}),
        logger: { info() {}, warn() {}, error() {} },
        signal: { aborted: false },
      }),
    ).toBeNull();
    expect(
      await detector.detect({
        event: eventFor({ kind: "chat_member", ownerNotice: "changed" }),
        logger: { info() {}, warn() {}, error() {} },
        signal: { aborted: false },
      }),
    ).toBeNull();
  });
});
