import { type Event, parseEvent } from "@tasb/core";
import { describe, expect, it } from "vitest";
import { createTaskDetector } from "./index.js";

const task = "新加的广告事项";

function eventFor(input: {
  kind?: "message" | "chat_member";
  asChecklistAdded?: true;
}): Event {
  const kind = input.kind ?? "message";
  return parseEvent({
    id: "evt_checklist_added",
    tenantId: "tenant_demo",
    chatId: "chat_demo",
    kind,
    occurredAt: "2026-11-01T00:00:00.000Z",
    actor: { id: "user_1", isAdmin: false },
    ...(kind === "message"
      ? {
          message: {
            id: "msg_1",
            text: task,
            textSha256: "b".repeat(64),
            ...(input.asChecklistAdded
              ? { asChecklistAdded: true as const }
              : {}),
          },
        }
      : {}),
  });
}

describe("added checklist detector", () => {
  const detector = createTaskDetector();

  it("scores an added task and leaves the text out of the hit", async () => {
    const hit = await detector.detect({
      event: eventFor({ asChecklistAdded: true }),
      logger: { info() {}, warn() {}, error() {} },
      signal: { aborted: false },
    });
    expect(hit).toEqual({
      detectorId: "checklist_added",
      score: 1,
      reasons: ["checklist_added"],
      evidence: [{ kind: "feature", summary: "checklist:added" }],
    });
    expect(JSON.stringify(hit)).not.toContain(task);
    expect(
      await detector.detect({
        event: eventFor({}),
        logger: { info() {}, warn() {}, error() {} },
        signal: { aborted: false },
      }),
    ).toBeNull();
    expect(
      await detector.detect({
        event: eventFor({ kind: "chat_member", asChecklistAdded: true }),
        logger: { info() {}, warn() {}, error() {} },
        signal: { aborted: false },
      }),
    ).toBeNull();
  });
});
