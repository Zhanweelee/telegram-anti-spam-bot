import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Event, parseEvent } from "@tasb/core";
import { describe, expect, it } from "vitest";
import { createJoinDetector } from "./index.js";

const fixtures = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "../fixtures/membership.json",
    ),
    "utf8",
  ),
) as {
  name: string;
  kind: "message" | "chat_member";
  membership?: "join";
  expect: "hit" | "miss";
}[];

const HASH = "c".repeat(64);

function eventFor(fixture: (typeof fixtures)[number]): Event {
  return parseEvent({
    id: "evt_1",
    tenantId: "tenant_demo",
    chatId: "chat_demo",
    kind: fixture.kind,
    occurredAt: "2026-11-01T00:00:00.000Z",
    actor: { id: "user_1", isAdmin: false },
    ...(fixture.membership ? { membership: fixture.membership } : {}),
    ...(fixture.kind === "message"
      ? {
          message: {
            id: "msg_1",
            text: "hello",
            textSha256: HASH,
          },
        }
      : {}),
  });
}

describe("join detector", () => {
  const detector = createJoinDetector();

  it("matches fixtures", async () => {
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
        detectorId: "join",
        score: 1,
        reasons: ["member_joined"],
        evidence: [{ kind: "feature", summary: "membership:join" }],
      });
    }
  });
});
