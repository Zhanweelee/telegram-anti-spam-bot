import { type Event, parseEvent } from "@tasb/core";
import { describe, expect, it } from "vitest";
import { createChecklistDetector } from "./index.js";

const title = "勾完的广告事项";

function eventFor(input: {
  kind?: "message" | "chat_member";
  checklistNotice?: "done" | "undone";
}): Event {
  const kind = input.kind ?? "message";
  return parseEvent({
    id: "evt_checklist_notice",
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
            ...(input.checklistNotice
              ? { checklistNotice: input.checklistNotice }
              : {}),
          },
        }
      : {}),
  });
}

describe("checklist notice detector", () => {
  const detector = createChecklistDetector();

  it("scores tasks marked done and tasks marked not done", async () => {
    for (const checklistNotice of ["done", "undone"] as const) {
      const hit = await detector.detect({
        event: eventFor({ checklistNotice }),
        logger: { info() {}, warn() {}, error() {} },
        signal: { aborted: false },
      });
      expect(hit).toEqual({
        detectorId: "checklist_notice",
        score: 1,
        reasons: ["checklist_notice"],
        evidence: [
          { kind: "feature", summary: `checklist:${checklistNotice}` },
        ],
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
        event: eventFor({ kind: "chat_member", checklistNotice: "done" }),
        logger: { info() {}, warn() {}, error() {} },
        signal: { aborted: false },
      }),
    ).toBeNull();
  });
});
