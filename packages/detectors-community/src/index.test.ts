import { type Event, parseEvent } from "@tasb/core";
import { describe, expect, it } from "vitest";
import { createCommunityDetector } from "./index.js";

const name = "社区广告名字";

function eventFor(input: {
  kind?: "message" | "chat_member";
  community?: "added" | "joined" | "removed";
}): Event {
  const kind = input.kind ?? "message";
  return parseEvent({
    id: "evt_community",
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
            ...(input.community ? { community: input.community } : {}),
          },
        }
      : {}),
  });
}

describe("community notice detector", () => {
  const detector = createCommunityDetector();

  it("scores an add, a join, and a removal", async () => {
    for (const community of ["added", "joined", "removed"] as const) {
      const hit = await detector.detect({
        event: eventFor({ community }),
        logger: { info() {}, warn() {}, error() {} },
        signal: { aborted: false },
      });
      expect(hit).toEqual({
        detectorId: "community_notice",
        score: 1,
        reasons: ["community_notice"],
        evidence: [{ kind: "feature", summary: `community:${community}` }],
      });
      expect(JSON.stringify(hit)).not.toContain(name);
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
        event: eventFor({ kind: "chat_member", community: "added" }),
        logger: { info() {}, warn() {}, error() {} },
        signal: { aborted: false },
      }),
    ).toBeNull();
  });
});
