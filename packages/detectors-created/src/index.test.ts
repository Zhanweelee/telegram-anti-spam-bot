import { type Event, parseEvent } from "@tasb/core";
import { describe, expect, it } from "vitest";
import { createCreatedDetector } from "./index.js";

function eventFor(input: {
  kind?: "message" | "chat_member";
  asGroupCreated?: true;
}): Event {
  const kind = input.kind ?? "message";
  return parseEvent({
    id: "evt_group_created",
    tenantId: "tenant_demo",
    chatId: "chat_demo",
    kind,
    occurredAt: "2026-11-01T00:00:00.000Z",
    actor: { id: "user_1", isAdmin: false },
    ...(kind === "message"
      ? {
          message: {
            id: "msg_1",
            text: "",
            textSha256: "e".repeat(64),
            ...(input.asGroupCreated ? { asGroupCreated: true as const } : {}),
          },
        }
      : {}),
  });
}

describe("created group detector", () => {
  const detector = createCreatedDetector();

  it("scores a created group and leaves the sender out of the hit", async () => {
    const hit = await detector.detect({
      event: eventFor({ asGroupCreated: true }),
      logger: { info() {}, warn() {}, error() {} },
      signal: { aborted: false },
    });
    expect(hit).toEqual({
      detectorId: "group_created",
      score: 1,
      reasons: ["group_created"],
      evidence: [{ kind: "feature", summary: "group:created" }],
    });
    expect(JSON.stringify(hit)).not.toContain("user_1");
    expect(
      await detector.detect({
        event: eventFor({}),
        logger: { info() {}, warn() {}, error() {} },
        signal: { aborted: false },
      }),
    ).toBeNull();
    expect(
      await detector.detect({
        event: eventFor({ kind: "chat_member", asGroupCreated: true }),
        logger: { info() {}, warn() {}, error() {} },
        signal: { aborted: false },
      }),
    ).toBeNull();
  });
});
