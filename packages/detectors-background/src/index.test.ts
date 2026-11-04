import { type Event, parseEvent } from "@tasb/core";
import { describe, expect, it } from "vitest";
import { createBackgroundDetector } from "./index.js";

const filename = "壁纸广告文件名";

function eventFor(input: {
  kind?: "message" | "chat_member";
  background?: "wallpaper" | "pattern" | "fill" | "theme";
}): Event {
  const kind = input.kind ?? "message";
  return parseEvent({
    id: "evt_chat_background",
    tenantId: "tenant_demo",
    chatId: "chat_demo",
    kind,
    occurredAt: "2026-11-01T00:00:00.000Z",
    actor: { id: "user_1", isAdmin: false },
    ...(kind === "message"
      ? {
          message: {
            id: "msg_1",
            text: filename,
            textSha256: "b".repeat(64),
            ...(input.background ? { background: input.background } : {}),
          },
        }
      : {}),
  });
}

describe("chat background detector", () => {
  const detector = createBackgroundDetector();

  it("scores wallpaper, pattern, fill, and theme", async () => {
    for (const background of [
      "wallpaper",
      "pattern",
      "fill",
      "theme",
    ] as const) {
      const hit = await detector.detect({
        event: eventFor({ background }),
        logger: { info() {}, warn() {}, error() {} },
        signal: { aborted: false },
      });
      expect(hit).toEqual({
        detectorId: "chat_background",
        score: 1,
        reasons: ["chat_background"],
        evidence: [{ kind: "feature", summary: `background:${background}` }],
      });
      expect(JSON.stringify(hit)).not.toContain(filename);
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
        event: eventFor({ kind: "chat_member", background: "wallpaper" }),
        logger: { info() {}, warn() {}, error() {} },
        signal: { aborted: false },
      }),
    ).toBeNull();
  });
});
