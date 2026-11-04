import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Event, parseEvent } from "@tasb/core";
import { describe, expect, it } from "vitest";
import { createNoticeDetector } from "./index.js";

const fixtures = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../fixtures/notice.json"),
    "utf8",
  ),
) as {
  name: string;
  kind: "message" | "chat_member";
  notice?: "join" | "leave";
  expect: "hit" | "miss";
}[];

const phrase = "请免费领取礼品";

function eventFor(fixture: (typeof fixtures)[number]): Event {
  return parseEvent({
    id: "evt_notice",
    tenantId: "tenant_demo",
    chatId: "chat_demo",
    kind: fixture.kind,
    occurredAt: "2026-11-01T00:00:00.000Z",
    actor: { id: "user_1", isAdmin: false },
    ...(fixture.kind === "message"
      ? {
          message: {
            id: "msg_1",
            text: fixture.notice === "leave" ? "" : phrase,
            textSha256: "c".repeat(64),
            ...(fixture.notice ? { notice: fixture.notice } : {}),
          },
        }
      : {}),
  });
}

describe("notice detector", () => {
  const detector = createNoticeDetector();

  it("matches join and leave service lines and ignores the rest", async () => {
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
        detectorId: "notice",
        score: 1,
        reasons: ["service_notice"],
        evidence: [{ kind: "feature", summary: `notice:${fixture.notice}` }],
      });
      expect(JSON.stringify(hit), fixture.name).not.toContain(phrase);
    }
  });
});
