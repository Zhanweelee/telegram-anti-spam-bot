import { type Event, parseEvent } from "@tasb/core";
import { describe, expect, it } from "vitest";
import { createPollDetector } from "./index.js";

const option = "投票广告选项";

function eventFor(input: {
  kind?: "message" | "chat_member";
  pollNotice?: "added" | "deleted";
}): Event {
  const kind = input.kind ?? "message";
  return parseEvent({
    id: "evt_poll_notice",
    tenantId: "tenant_demo",
    chatId: "chat_demo",
    kind,
    occurredAt: "2026-11-01T00:00:00.000Z",
    actor: { id: "user_1", isAdmin: false },
    ...(kind === "message"
      ? {
          message: {
            id: "msg_1",
            text: option,
            textSha256: "b".repeat(64),
            ...(input.pollNotice ? { pollNotice: input.pollNotice } : {}),
          },
        }
      : {}),
  });
}

describe("poll option detector", () => {
  const detector = createPollDetector();

  it("scores an added option and leaves the text out of the hit", async () => {
    const hit = await detector.detect({
      event: eventFor({ pollNotice: "added" }),
      logger: { info() {}, warn() {}, error() {} },
      signal: { aborted: false },
    });
    expect(hit).toEqual({
      detectorId: "poll_notice",
      score: 1,
      reasons: ["poll_notice"],
      evidence: [{ kind: "feature", summary: "poll:added" }],
    });
    expect(JSON.stringify(hit)).not.toContain(option);
    expect(
      (
        await detector.detect({
          event: eventFor({ pollNotice: "deleted" }),
          logger: { info() {}, warn() {}, error() {} },
          signal: { aborted: false },
        })
      )?.evidence,
    ).toEqual([{ kind: "feature", summary: "poll:deleted" }]);
    expect(
      await detector.detect({
        event: eventFor({}),
        logger: { info() {}, warn() {}, error() {} },
        signal: { aborted: false },
      }),
    ).toBeNull();
    expect(
      await detector.detect({
        event: eventFor({ kind: "chat_member", pollNotice: "added" }),
        logger: { info() {}, warn() {}, error() {} },
        signal: { aborted: false },
      }),
    ).toBeNull();
  });
});
