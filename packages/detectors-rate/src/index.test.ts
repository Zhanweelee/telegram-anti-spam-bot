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
  media?: "sticker";
  sameMedia?: boolean;
  mediaSha256?: string;
  expect: "hit" | "miss";
}[];

function messageEvent(input: {
  readonly id: string;
  readonly actorId: string;
  readonly text: string;
  readonly textSha256: string;
  readonly occurredAt: string;
  readonly chatId?: string;
  readonly media?: "sticker";
  readonly mediaSha256?: string;
  readonly albumId?: string;
  readonly edited?: true;
  readonly offline?: true;
}): Event {
  return parseEvent({
    id: input.id,
    tenantId: "tenant_demo",
    chatId: input.chatId ?? "chat_demo",
    kind: "message",
    occurredAt: input.occurredAt,
    actor: { id: input.actorId, isAdmin: false },
    ...(input.edited ? { edited: true } : {}),
    message: {
      id: input.id,
      text: input.text,
      textSha256: input.textSha256,
      ...(input.media ? { media: input.media } : {}),
      ...(input.mediaSha256 ? { mediaSha256: input.mediaSha256 } : {}),
      ...(input.albumId ? { albumId: input.albumId } : {}),
      ...(input.offline ? { offline: true as const } : {}),
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
  it("counts scheduled messages as a single flood sample", async () => {
    const phrase = "请免费领取礼品";
    const logger = createMemoryLogger();
    const detector = createFloodDetector({
      window: createMemoryRateWindow(),
      windowSeconds: 10,
      threshold: 5,
    });
    const scheduled = Array.from({ length: 8 }, (_, index) =>
      messageEvent({
        id: `offline_${index}`,
        actorId: "user_1",
        text: phrase,
        textSha256: HASH,
        occurredAt: isoAt(index * 10),
        offline: true,
      }),
    );
    expect(await lastHit(detector, scheduled, logger)).toBeNull();
    const under = Array.from({ length: 3 }, (_, index) =>
      messageEvent({
        id: `plain_${index}`,
        actorId: "user_1",
        text: "今天站会",
        textSha256: HASH,
        occurredAt: isoAt(1000 + index * 10),
      }),
    );
    expect(await lastHit(detector, under, logger)).toBeNull();
    const hit = await lastHit(
      detector,
      [
        messageEvent({
          id: "plain_3",
          actorId: "user_1",
          text: "今天站会",
          textSha256: HASH,
          occurredAt: isoAt(1500),
        }),
      ],
      logger,
    );
    expect(hit?.evidence[0]?.summary).toBe("flood:5");
    expect(JSON.stringify(hit)).not.toContain(phrase);
    expect(JSON.stringify(logger.entries)).not.toContain(phrase);

    const edited = createFloodDetector({
      window: createMemoryRateWindow(),
      windowSeconds: 10,
      threshold: 5,
    });
    const edits = Array.from({ length: 5 }, (_, index) =>
      messageEvent({
        id: `offline_edit_${index}`,
        actorId: "user_1",
        text: "今天站会",
        textSha256: HASH,
        occurredAt: isoAt(index * 10),
        offline: true,
        edited: true,
      }),
    );
    expect(
      (await lastHit(edited, edits, createMemoryLogger()))?.evidence[0]
        ?.summary,
    ).toBe("flood:5");

    const repeat = createRepeatDetector({
      window: createMemoryRateWindow(),
      windowSeconds: 60,
      threshold: 3,
    });
    const copies = Array.from({ length: 3 }, (_, index) =>
      messageEvent({
        id: `offline_copy_${index}`,
        actorId: "user_1",
        text: phrase,
        textSha256: HASH,
        occurredAt: isoAt(index * 10),
        offline: true,
      }),
    );
    const repeated = await lastHit(repeat, copies, createMemoryLogger());
    expect(repeated?.evidence[0]?.summary).toBe("repeat:3");
    expect(JSON.stringify(repeated)).not.toContain(phrase);
  });

  it("counts one album as a single flood sample", async () => {
    const albumId = "12532140322504850";
    const logger = createMemoryLogger();
    const detector = createFloodDetector({
      window: createMemoryRateWindow(),
      windowSeconds: 10,
      threshold: 5,
    });
    const album = Array.from({ length: 8 }, (_, index) =>
      messageEvent({
        id: `album_${index}`,
        actorId: "user_1",
        text: "",
        textSha256: HASH,
        occurredAt: isoAt(index * 10),
        albumId,
      }),
    );
    expect(await lastHit(detector, album, logger)).toBeNull();
    const under = Array.from({ length: 3 }, (_, index) =>
      messageEvent({
        id: `plain_${index}`,
        actorId: "user_1",
        text: "今天站会",
        textSha256: HASH,
        occurredAt: isoAt(1000 + index * 10),
      }),
    );
    expect(await lastHit(detector, under, logger)).toBeNull();
    const hit = await lastHit(
      detector,
      [
        messageEvent({
          id: "plain_3",
          actorId: "user_1",
          text: "今天站会",
          textSha256: HASH,
          occurredAt: isoAt(1500),
        }),
      ],
      logger,
    );
    expect(hit?.evidence[0]?.summary).toBe("flood:5");
    expect(JSON.stringify(hit)).not.toContain(albumId);
    expect(JSON.stringify(logger.entries)).not.toContain(albumId);
  });

  it("counts each edited album message and each distinct album", async () => {
    const albumId = "12532140322504850";
    const edited = createFloodDetector({
      window: createMemoryRateWindow(),
      windowSeconds: 10,
      threshold: 5,
    });
    const edits = Array.from({ length: 5 }, (_, index) =>
      messageEvent({
        id: `edit_${index}`,
        actorId: "user_1",
        text: "",
        textSha256: HASH,
        occurredAt: isoAt(index * 10),
        albumId,
        edited: true,
      }),
    );
    const editedHit = await lastHit(edited, edits, createMemoryLogger());
    expect(editedHit?.evidence[0]?.summary).toBe("flood:5");

    const separate = createFloodDetector({
      window: createMemoryRateWindow(),
      windowSeconds: 10,
      threshold: 5,
    });
    const albums = Array.from({ length: 5 }, (_, index) =>
      messageEvent({
        id: `group_${index}`,
        actorId: "user_1",
        text: "",
        textSha256: HASH,
        occurredAt: isoAt(index * 10),
        albumId: `${index + 1}`,
      }),
    );
    const separateHit = await lastHit(separate, albums, createMemoryLogger());
    expect(separateHit?.evidence[0]?.summary).toBe("flood:5");
  });

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
        const mediaSha256 =
          fixture.mediaSha256 === undefined
            ? undefined
            : fixture.sameMedia === false
              ? `${index}`.padStart(64, "d")
              : fixture.mediaSha256;
        return messageEvent({
          id: `r_${index}`,
          actorId: "user_1",
          text,
          textSha256: fixture.sameText ? HASH : `${index}`.padStart(64, "c"),
          occurredAt: isoAt(index * 1000),
          ...(fixture.media ? { media: fixture.media } : {}),
          ...(mediaSha256 ? { mediaSha256 } : {}),
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

  it("counts one event id once and still counts a missing id", async () => {
    const window = createMemoryRateWindow();
    const key = "f\ntenant_demo\nchat_demo\nuser_1";
    const longId = "x".repeat(129);
    expect(
      await window.observe({
        key,
        nowMs: 0,
        windowMs: 10_000,
        eventId: "tg_0",
      }),
    ).toBe(1);
    expect(
      await window.observe({
        key,
        nowMs: 1_000,
        windowMs: 10_000,
        eventId: "tg_0",
      }),
    ).toBe(1);
    expect(
      await window.observe({
        key,
        nowMs: 2_000,
        windowMs: 10_000,
        eventId: "tg_1",
      }),
    ).toBe(2);
    expect(
      await window.observe({
        key,
        nowMs: 2_100,
        windowMs: 10_000,
        eventId: longId,
      }),
    ).toBe(3);
    expect(
      await window.observe({
        key,
        nowMs: 2_200,
        windowMs: 10_000,
        eventId: longId,
      }),
    ).toBe(4);
    expect(await window.observe({ key, nowMs: 3_000, windowMs: 10_000 })).toBe(
      5,
    );
    expect(await window.observe({ key, nowMs: 3_100, windowMs: 10_000 })).toBe(
      6,
    );
    expect(
      await window.observe({
        key: "r\ntenant_demo\nchat_demo\nab",
        nowMs: 3_100,
        windowMs: 10_000,
        eventId: "tg_0",
      }),
    ).toBe(1);
  });

  it("counts an event id again after it leaves the recent samples", async () => {
    const window = createMemoryRateWindow({ maxSamples: 2 });
    const key = "f\ntenant_demo\nchat_demo\nuser_1";
    expect(
      await window.observe({
        key,
        nowMs: 0,
        windowMs: 10_000,
        eventId: "tg_0",
      }),
    ).toBe(1);
    expect(
      await window.observe({
        key,
        nowMs: 1_000,
        windowMs: 10_000,
        eventId: "tg_0",
      }),
    ).toBe(1);
    expect(
      await window.observe({
        key,
        nowMs: 2_000,
        windowMs: 10_000,
        eventId: "tg_1",
      }),
    ).toBe(2);
    expect(
      await window.observe({
        key,
        nowMs: 3_000,
        windowMs: 10_000,
        eventId: "tg_2",
      }),
    ).toBe(2);
    expect(
      await window.observe({
        key,
        nowMs: 9_000,
        windowMs: 10_000,
        eventId: "tg_0",
      }),
    ).toBe(2);
    expect(
      await window.observe({
        key,
        nowMs: 12_500,
        windowMs: 10_000,
        eventId: "tg_2",
      }),
    ).toBe(2);
  });

  it("does not put an expired retry back into the window", async () => {
    const window = createMemoryRateWindow();
    const key = "f\ntenant_demo\nchat_demo\nuser_1";
    expect(
      await window.observe({
        key,
        nowMs: 0,
        windowMs: 10_000,
        eventId: "tg_0",
      }),
    ).toBe(1);
    expect(
      await window.observe({
        key,
        nowMs: 20_000,
        windowMs: 10_000,
        eventId: "tg_0",
      }),
    ).toBe(0);
    expect(
      await window.observe({
        key,
        nowMs: 20_000,
        windowMs: 10_000,
        eventId: "tg_1",
      }),
    ).toBe(1);
  });

  it("does not let one retry trip flood or repeat", async () => {
    const window = createMemoryRateWindow();
    const logger = createMemoryLogger();
    const flood = createFloodDetector({
      window,
      windowSeconds: 10,
      threshold: 2,
    });
    const repeat = createRepeatDetector({
      window,
      windowSeconds: 60,
      threshold: 3,
    });
    const first = messageEvent({
      id: "tg_1",
      actorId: "user_1",
      text: phrase,
      textSha256: HASH,
      occurredAt: isoAt(0),
    });
    const second = messageEvent({
      id: "tg_2",
      actorId: "user_1",
      text: phrase,
      textSha256: HASH,
      occurredAt: isoAt(1_000),
    });
    const third = messageEvent({
      id: "tg_3",
      actorId: "user_1",
      text: phrase,
      textSha256: HASH,
      occurredAt: isoAt(2_000),
    });
    expect(await flood.detect({ event: first, logger, signal })).toBeNull();
    expect(await flood.detect({ event: first, logger, signal })).toBeNull();
    expect(await flood.detect({ event: second, logger, signal })).toMatchObject(
      { evidence: [{ summary: "flood:2" }] },
    );
    expect(await repeat.detect({ event: first, logger, signal })).toBeNull();
    expect(await repeat.detect({ event: first, logger, signal })).toBeNull();
    expect(await repeat.detect({ event: second, logger, signal })).toBeNull();
    expect(await repeat.detect({ event: third, logger, signal })).toMatchObject(
      { evidence: [{ summary: "repeat:3" }] },
    );
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
