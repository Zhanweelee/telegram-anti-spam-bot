import { type Event, parseEvent } from "@tasb/core";
import { describe, expect, it } from "vitest";
import { createGiveawayNoticeDetector } from "./index.js";

const title = "抽奖广告正文";

function eventFor(input: {
  kind?: "message" | "chat_member";
  giveawayNotice?: "created" | "completed";
}): Event {
  const kind = input.kind ?? "message";
  return parseEvent({
    id: "evt_giveaway_notice",
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
            ...(input.giveawayNotice
              ? { giveawayNotice: input.giveawayNotice }
              : {}),
          },
        }
      : {}),
  });
}

describe("giveaway notice detector", () => {
  const detector = createGiveawayNoticeDetector();

  it("scores a creation and a private completion", async () => {
    for (const giveawayNotice of ["created", "completed"] as const) {
      const hit = await detector.detect({
        event: eventFor({ giveawayNotice }),
        logger: { info() {}, warn() {}, error() {} },
        signal: { aborted: false },
      });
      expect(hit).toEqual({
        detectorId: "giveaway_notice",
        score: 1,
        reasons: ["giveaway_notice"],
        evidence: [{ kind: "feature", summary: `giveaway:${giveawayNotice}` }],
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
        event: eventFor({ kind: "chat_member", giveawayNotice: "created" }),
        logger: { info() {}, warn() {}, error() {} },
        signal: { aborted: false },
      }),
    ).toBeNull();
  });
});
