import { type Event, parseEvent } from "@tasb/core";
import { describe, expect, it } from "vitest";
import { createAutoDeleteDetector } from "./index.js";

const actor = "改计时的人";

function eventFor(input: {
  kind?: "message" | "chat_member";
  asAutoDelete?: true;
}): Event {
  const kind = input.kind ?? "message";
  return parseEvent({
    id: "evt_autodelete_notice",
    tenantId: "tenant_demo",
    chatId: "chat_demo",
    kind,
    occurredAt: "2026-11-01T00:00:00.000Z",
    actor: { id: "user_1", isAdmin: false },
    ...(kind === "message"
      ? {
          message: {
            id: "msg_1",
            text: actor,
            textSha256: "b".repeat(64),
            ...(input.asAutoDelete ? { asAutoDelete: true as const } : {}),
          },
        }
      : {}),
  });
}

describe("auto-delete notice detector", () => {
  const detector = createAutoDeleteDetector();

  it("scores a timer change and leaves the seconds out", async () => {
    const hit = await detector.detect({
      event: eventFor({ asAutoDelete: true }),
      logger: { info() {}, warn() {}, error() {} },
      signal: { aborted: false },
    });
    expect(hit).toEqual({
      detectorId: "autodelete_notice",
      score: 1,
      reasons: ["autodelete_notice"],
      evidence: [{ kind: "feature", summary: "autodelete:changed" }],
    });
    expect(JSON.stringify(hit)).not.toContain(actor);
    expect(JSON.stringify(hit)).not.toContain("90186");
    expect(
      await detector.detect({
        event: eventFor({}),
        logger: { info() {}, warn() {}, error() {} },
        signal: { aborted: false },
      }),
    ).toBeNull();
    expect(
      await detector.detect({
        event: eventFor({ kind: "chat_member", asAutoDelete: true }),
        logger: { info() {}, warn() {}, error() {} },
        signal: { aborted: false },
      }),
    ).toBeNull();
  });
});
