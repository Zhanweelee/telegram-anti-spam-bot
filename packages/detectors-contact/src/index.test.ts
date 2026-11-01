import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Event, parseEvent } from "@tasb/core";
import { describe, expect, it } from "vitest";
import { createContactDetector } from "./index.js";

const fixtures = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../fixtures/contacts.json"),
    "utf8",
  ),
) as {
  name: string;
  kind: "message" | "chat_member";
  contact?: true;
  expect: "hit" | "miss";
}[];

const phone = "13800138000";

function eventFor(fixture: (typeof fixtures)[number]): Event {
  return parseEvent({
    id: "evt_contact",
    tenantId: "tenant_demo",
    chatId: "chat_demo",
    kind: fixture.kind,
    occurredAt: "2026-11-01T00:00:00.000Z",
    actor: { id: "user_1", isAdmin: false },
    ...(fixture.kind === "message"
      ? {
          message: {
            id: "msg_1",
            text: fixture.contact ? "" : "今天站会改到三点",
            textSha256: "c".repeat(64),
            ...(fixture.contact ? { contact: true } : {}),
          },
        }
      : {}),
  });
}

describe("contact detector", () => {
  const detector = createContactDetector();

  it("matches a shared card and ignores plain text", async () => {
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
        detectorId: "contact",
        score: 1,
        reasons: ["contact_shared"],
        evidence: [{ kind: "feature", summary: "contact:card" }],
      });
      expect(JSON.stringify(hit), fixture.name).not.toContain(phone);
    }
  });
});
