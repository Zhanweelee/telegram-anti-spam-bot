import { type Event, parseEvent } from "@tasb/core";
import { describe, expect, it } from "vitest";
import { createLocationDetector, createMapDetector } from "./index.js";

const latitude = "23.1291";

function eventFor(input: {
  kind?: "message" | "chat_member";
  asLocation?: true;
  asRichMap?: true;
}): Event {
  const kind = input.kind ?? "message";
  return parseEvent({
    id: "evt_location",
    tenantId: "tenant_demo",
    chatId: "chat_demo",
    kind,
    occurredAt: "2026-11-01T00:00:00.000Z",
    actor: { id: "user_1", isAdmin: false },
    ...(kind === "message"
      ? {
          message: {
            id: "msg_1",
            text: latitude,
            textSha256: "f".repeat(64),
            ...(input.asLocation ? { asLocation: true as const } : {}),
            ...(input.asRichMap ? { asRichMap: true as const } : {}),
          },
        }
      : {}),
  });
}

describe("bare location detector", () => {
  const detector = createLocationDetector();

  it("scores only a bare location pin", async () => {
    const hit = await detector.detect({
      event: eventFor({ asLocation: true }),
      logger: { info() {}, warn() {}, error() {} },
      signal: { aborted: false },
    });
    expect(hit).toEqual({
      detectorId: "bare_location",
      score: 1,
      reasons: ["bare_location"],
      evidence: [{ kind: "feature", summary: "location:pin" }],
    });
    expect(JSON.stringify(hit)).not.toContain(latitude);
    expect(
      await detector.detect({
        event: eventFor({}),
        logger: { info() {}, warn() {}, error() {} },
        signal: { aborted: false },
      }),
    ).toBeNull();
    expect(
      await detector.detect({
        event: eventFor({ kind: "chat_member", asLocation: true }),
        logger: { info() {}, warn() {}, error() {} },
        signal: { aborted: false },
      }),
    ).toBeNull();
  });
});

describe("rich map detector", () => {
  const detector = createMapDetector();
  const pin = createLocationDetector();
  const logger = { info() {}, warn() {}, error() {} };
  const signal = { aborted: false };

  it("scores a rich map and leaves the coordinates out of the hit", async () => {
    const hit = await detector.detect({
      event: eventFor({ asRichMap: true }),
      logger,
      signal,
    });
    expect(hit).toEqual({
      detectorId: "rich_map",
      score: 1,
      reasons: ["rich_map"],
      evidence: [{ kind: "feature", summary: "map:rich" }],
    });
    expect(JSON.stringify(hit)).not.toContain("90217");
    expect(
      await detector.detect({ event: eventFor({}), logger, signal }),
    ).toBeNull();
    expect(
      await detector.detect({
        event: eventFor({ kind: "chat_member", asRichMap: true }),
        logger,
        signal,
      }),
    ).toBeNull();
    expect(
      await detector.detect({
        event: eventFor({ asLocation: true }),
        logger,
        signal,
      }),
    ).toBeNull();
    expect(
      await pin.detect({
        event: eventFor({ asRichMap: true }),
        logger,
        signal,
      }),
    ).toBeNull();
  });
});
