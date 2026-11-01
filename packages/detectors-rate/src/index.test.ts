import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createMemoryLogger,
  type Event,
  type Logger,
  parseEvent,
} from "@tasb/core";
import { describe, expect, it } from "vitest";
import {
  createFloodDetector,
  createMemoryRateWindow,
  createRepeatDetector,
  type RateWindow,
} from "./index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const phrase = "请免费领取礼品";
const HASH = "ab".repeat(32);
const signal = { aborted: false };

const floodFixtures = JSON.parse(
  readFileSync(join(root, "fixtures/flood.json"), "utf8"),
) as {
  name: string;
  messages: number;
  gapMs: number;
  rotateActor: boolean;
  expect: "hit" | "miss";
}[];

const repeatFixtures = JSON.parse(
  readFileSync(join(root, "fixtures/repeat.json"), "utf8"),
) as {
  name: string;
  messages: number;
  sameText: boolean;
  text: string;
  expect: "hit" | "miss";
}[];

function messageEvent(input: {
  readonly id: string;
  readonly actorId: string;
  readonly text: string;
  readonly textSha256: string;
  readonly occurredAt: string;
  readonly chatId?: string;
}): Event {
  return parseEvent({
    id: input.id,
    tenantId: "tenant_demo",
    chatId: input.chatId ?? "chat_demo",
    kind: "message",
    occurredAt: input.occurredAt,
    actor: { id: input.actorId, isAdmin: false },
    message: {
      id: input.id,
      text: input.text,
      textSha256: input.textSha256,
    },
  });
}

function isoAt(offsetMs: number): string {
  return new Date(
    Date.parse("2026-11-01T00:00:00.000Z") + offsetMs,
  ).toISOString();
}

async function lastHit(
  detector: ReturnType<typeof createFloodDetector>,
  events: readonly Event[],
  logger: Logger,
) {
  let hit: Awaited<ReturnType<typeof detector.detect>> = null;
  for (const event of events) {
    hit = await detector.detect({ event, logger, signal });
  }
  return hit;
}

describe("flood and repeat fixtures", () => {
  it("matches flood fixtures without storing text", async () => {
    for (const fixture of floodFixtures) {
      const logger = createMemoryLogger();
      const detector = createFloodDetector({
        window: createMemoryRateWindow(),
        windowSeconds: 10,
        threshold: 5,
      });
      const events = Array.from({ length: fixture.messages }, (_, index) =>
        messageEvent({
          id: `f_${index}`,
          actorId: fixture.rotateActor ? `user_${index}` : "user_1",
          text: phrase,
          textSha256: HASH,
          occurredAt: isoAt(index * fixture.gapMs),
        }),
      );
      const hit = await lastHit(detector, events, logger);
      if (fixture.expect === "miss") {
        expect(hit, fixture.name).toBeNull();
      } else {
        expect(hit, fixture.name).toMatchObject({
          detectorId: "flood",
          score: 1,
          reasons: ["flood"],
        });
        expect(hit?.evidence[0]?.summary.startsWith("flood:")).toBe(true);
      }
      expect(JSON.stringify(hit), fixture.name).not.toContain(phrase);
      expect(JSON.stringify(logger.entries), fixture.name).not.toContain(
        phrase,
      );
    }
  });

  it("matches repeat fixtures and ignores empty text", async () => {
    for (const fixture of repeatFixtures) {
      const logger = createMemoryLogger();
      const detector = createRepeatDetector({
        window: createMemoryRateWindow(),
        windowSeconds: 60,
        threshold: 3,
      });
      const events = Array.from({ length: fixture.messages }, (_, index) => {
        const text = fixture.sameText
          ? fixture.text
          : `${fixture.text}-${index}`;
        return messageEvent({
          id: `r_${index}`,
          actorId: "user_1",
          text,
          textSha256: fixture.sameText ? HASH : `${index}`.padStart(64, "c"),
          occurredAt: isoAt(index * 1000),
        });
      });
      const hit = await lastHit(detector, events, logger);
      if (fixture.expect === "miss") {
        expect(hit, fixture.name).toBeNull();
      } else {
        expect(hit, fixture.name).toMatchObject({
          detectorId: "repeat",
          reasons: ["repeat"],
        });
      }
      expect(JSON.stringify(hit), fixture.name).not.toContain(phrase);
    }
  });
});

describe("rate window budget", () => {
  it("skips a new key when the window is full and does not throw", async () => {
    const window = createMemoryRateWindow({ maxKeys: 1 });
    const logger = createMemoryLogger();
    const detector = createFloodDetector({
      window,
      windowSeconds: 10,
      threshold: 2,
    });
    const first = messageEvent({
      id: "a",
      actorId: "user_1",
      text: phrase,
      textSha256: HASH,
      occurredAt: isoAt(0),
    });
    const second = messageEvent({
      id: "b",
      actorId: "user_2",
      text: phrase,
      textSha256: HASH,
      occurredAt: isoAt(1000),
    });
    expect(await detector.detect({ event: first, logger, signal })).toBeNull();
    expect(await detector.detect({ event: second, logger, signal })).toBeNull();
    expect(
      logger.entries.some((entry) => entry.message === "rate_window_skipped"),
    ).toBe(true);
    expect(JSON.stringify(logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(logger.entries)).not.toContain(HASH);
  });

  it("reuses a slot after the previous key expires", async () => {
    const window = createMemoryRateWindow({ maxKeys: 1 });
    expect(await window.observe({ key: "a", nowMs: 0, windowMs: 10_000 })).toBe(
      1,
    );
    expect(
      await window.observe({ key: "b", nowMs: 1_000, windowMs: 10_000 }),
    ).toBeNull();
    expect(
      await window.observe({ key: "b", nowMs: 11_000, windowMs: 10_000 }),
    ).toBe(1);
  });

  it("returns null when the window throws", async () => {
    const window: RateWindow = {
      async observe() {
        throw new Error(phrase);
      },
    };
    const logger = createMemoryLogger();
    const detector = createRepeatDetector({
      window,
      windowSeconds: 60,
      threshold: 3,
    });
    const event = messageEvent({
      id: "x",
      actorId: "user_1",
      text: phrase,
      textSha256: HASH,
      occurredAt: isoAt(0),
    });
    expect(await detector.detect({ event, logger, signal })).toBeNull();
    expect(
      logger.entries.some((entry) => entry.message === "rate_window_failed"),
    ).toBe(true);
    expect(JSON.stringify(logger.entries)).not.toContain(phrase);
  });

  it("does not count a join", async () => {
    const detector = createFloodDetector({
      window: createMemoryRateWindow(),
      windowSeconds: 10,
      threshold: 2,
    });
    const event = parseEvent({
      id: "join",
      tenantId: "tenant_demo",
      chatId: "chat_demo",
      kind: "chat_member",
      occurredAt: isoAt(0),
      actor: { id: "user_1", isAdmin: false },
      membership: "join",
    });
    expect(
      await detector.detect({
        event,
        logger: createMemoryLogger(),
        signal,
      }),
    ).toBeNull();
  });
});
