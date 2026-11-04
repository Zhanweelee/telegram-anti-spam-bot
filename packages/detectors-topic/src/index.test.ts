import { type Event, parseEvent } from "@tasb/core";
import { describe, expect, it } from "vitest";
import { createTopicDetector } from "./index.js";

const name = "新建话题广告名";

function eventFor(input: {
  kind?: "message" | "chat_member";
  topicNotice?: "created" | "edited";
}): Event {
  const kind = input.kind ?? "message";
  return parseEvent({
    id: "evt_topic_notice",
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
            ...(input.topicNotice ? { topicNotice: input.topicNotice } : {}),
          },
        }
      : {}),
  });
}

describe("topic rename detector", () => {
  const detector = createTopicDetector();

  it("scores a created topic and leaves the name out of the hit", async () => {
    const hit = await detector.detect({
      event: eventFor({ topicNotice: "created" }),
      logger: { info() {}, warn() {}, error() {} },
      signal: { aborted: false },
    });
    expect(hit).toEqual({
      detectorId: "topic_notice",
      score: 1,
      reasons: ["topic_notice"],
      evidence: [{ kind: "feature", summary: "topic:created" }],
    });
    expect(JSON.stringify(hit)).not.toContain(name);
    expect(
      (
        await detector.detect({
          event: eventFor({ topicNotice: "edited" }),
          logger: { info() {}, warn() {}, error() {} },
          signal: { aborted: false },
        })
      )?.evidence,
    ).toEqual([{ kind: "feature", summary: "topic:edited" }]);
    expect(
      await detector.detect({
        event: eventFor({}),
        logger: { info() {}, warn() {}, error() {} },
        signal: { aborted: false },
      }),
    ).toBeNull();
    expect(
      await detector.detect({
        event: eventFor({ kind: "chat_member", topicNotice: "created" }),
        logger: { info() {}, warn() {}, error() {} },
        signal: { aborted: false },
      }),
    ).toBeNull();
  });
});
