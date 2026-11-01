import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Event, parseEvent } from "@tasb/core";
import { describe, expect, it } from "vitest";
import { createViaDetector } from "./index.js";

const fixtures = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../fixtures/via.json"),
    "utf8",
  ),
) as {
  name: string;
  kind: "message" | "chat_member";
  via?: true;
  expect: "hit" | "miss";
}[];

const name = "机密代发";

function eventFor(fixture: (typeof fixtures)[number]): Event {
  return parseEvent({
    id: "evt_via",
    tenantId: "tenant_demo",
    chatId: "chat_demo",
    kind: fixture.kind,
    occurredAt: "2026-11-01T00:00:00.000Z",
    actor: { id: "user_1", isAdmin: false },
    ...(fixture.kind === "message"
      ? {
          message: {
            id: "msg_1",
            text: "今天站会",
            textSha256: "c".repeat(64),
            ...(fixture.via ? { via: true } : {}),
          },
        }
      : {}),
  });
}

describe("via detector", () => {
  const detector = createViaDetector();

  it("matches an inline bot and ignores plain text", async () => {
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
        detectorId: "via",
        score: 1,
        reasons: ["via_bot"],
        evidence: [{ kind: "feature", summary: "via:bot" }],
      });
      expect(JSON.stringify(hit), fixture.name).not.toContain(name);
    }
  });
});
