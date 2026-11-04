import { type Event, parseEvent } from "@tasb/core";
import { describe, expect, it } from "vitest";
import { createPhotoDetector } from "./index.js";

const fileId = "AgADphoto447";

function eventFor(input: {
  kind?: "message" | "chat_member";
  photo?: "set" | "cleared";
}): Event {
  const kind = input.kind ?? "message";
  return parseEvent({
    id: "evt_chat_photo",
    tenantId: "tenant_demo",
    chatId: "chat_demo",
    kind,
    occurredAt: "2026-11-01T00:00:00.000Z",
    actor: { id: "user_1", isAdmin: false },
    ...(kind === "message"
      ? {
          message: {
            id: "msg_1",
            text: fileId,
            textSha256: "b".repeat(64),
            ...(input.photo ? { photo: input.photo } : {}),
          },
        }
      : {}),
  });
}

describe("chat photo detector", () => {
  const detector = createPhotoDetector();

  it("scores a new photo and a removed photo", async () => {
    for (const photo of ["set", "cleared"] as const) {
      const hit = await detector.detect({
        event: eventFor({ photo }),
        logger: { info() {}, warn() {}, error() {} },
        signal: { aborted: false },
      });
      expect(hit).toEqual({
        detectorId: "chat_photo",
        score: 1,
        reasons: ["chat_photo"],
        evidence: [{ kind: "feature", summary: `photo:${photo}` }],
      });
      expect(JSON.stringify(hit)).not.toContain(fileId);
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
        event: eventFor({ kind: "chat_member", photo: "set" }),
        logger: { info() {}, warn() {}, error() {} },
        signal: { aborted: false },
      }),
    ).toBeNull();
  });
});
