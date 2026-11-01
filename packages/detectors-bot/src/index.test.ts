import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Event, parseEvent } from "@tasb/core";
import { describe, expect, it } from "vitest";
import { createBotDetector } from "./index.js";

const fixtures = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../fixtures/bots.json"),
    "utf8",
  ),
) as {
  name: string;
  kind: "message" | "chat_member";
  bot?: true;
  expect: "hit" | "miss";
}[];

function eventFor(fixture: (typeof fixtures)[number]): Event {
  return parseEvent({
    id: "evt_bot",
    tenantId: "tenant_demo",
    chatId: "chat_demo",
    kind: fixture.kind,
    occurredAt: "2026-11-01T00:00:00.000Z",
    actor: {
      id: "user_1",
      isAdmin: false,
      ...(fixture.bot ? { bot: true } : {}),
    },
    ...(fixture.kind === "message"
      ? {
          message: {
            id: "msg_1",
            text: "hello",
            textSha256: "c".repeat(64),
          },
        }
      : {}),
  });
}

describe("bot detector", () => {
  const detector = createBotDetector();

  it("matches a joining bot and ignores everyone else", async () => {
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
        detectorId: "bot",
        score: 1,
        reasons: ["bot_joined"],
        evidence: [{ kind: "feature", summary: "bot:join" }],
      });
      expect(JSON.stringify(hit), fixture.name).not.toContain("广告机器人");
    }
  });
});
