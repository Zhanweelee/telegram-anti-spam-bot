import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Event, type MediaKind, parseEvent } from "@tasb/core";
import { describe, expect, it } from "vitest";
import { createMediaDetector, type LockableMedia } from "./index.js";

const fixtures = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../fixtures/media.json"),
    "utf8",
  ),
) as {
  name: string;
  kind: "message" | "chat_member";
  media?: MediaKind;
  expect: "hit" | "miss";
}[];

const pack = "SecretPack";

function eventFor(fixture: (typeof fixtures)[number]): Event {
  return parseEvent({
    id: "evt_media",
    tenantId: "tenant_demo",
    chatId: "chat_demo",
    kind: fixture.kind,
    occurredAt: "2026-11-01T00:00:00.000Z",
    actor: { id: "user_1", isAdmin: false },
    ...(fixture.kind === "message"
      ? {
          message: {
            id: "msg_1",
            text: fixture.media === "dice" ? "" : pack,
            textSha256: "c".repeat(64),
            ...(fixture.media ? { media: fixture.media } : {}),
          },
        }
      : {}),
  });
}

describe("media detector", () => {
  const detector = createMediaDetector("sticker");

  it("matches only the locked kind", async () => {
    for (const fixture of fixtures) {
      const hit = await detector.detect({
        event: eventFor(fixture),
        logger: { info() {}, warn() {}, error() {} },
        signal: { aborted: false },
      });
      if (fixture.expect === "miss") {
        expect(hit, fixture.name).toBeNull();
        continue;
      }
      expect(hit, fixture.name).toEqual({
        detectorId: "media_sticker",
        score: 1,
        reasons: ["media_sticker"],
        evidence: [{ kind: "feature", summary: "media:sticker" }],
      });
      expect(JSON.stringify(hit), fixture.name).not.toContain(pack);
    }
  });

  it("gives each silent kind its own id", async () => {
    const kinds: readonly LockableMedia[] = [
      "animation",
      "voice",
      "video_note",
      "dice",
      "photo",
      "video",
      "document",
      "audio",
    ];
    for (const kind of kinds) {
      const hit = await createMediaDetector(kind).detect({
        event: eventFor({
          name: kind,
          kind: "message",
          media: kind,
          expect: "hit",
        }),
        logger: { info() {}, warn() {}, error() {} },
        signal: { aborted: false },
      });
      expect(hit?.detectorId, kind).toBe(`media_${kind}`);
      expect(hit?.evidence).toEqual([
        { kind: "feature", summary: `media:${kind}` },
      ]);
      expect(JSON.stringify(hit)).not.toContain(pack);
    }
  });
});
