import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type DeleteTarget, type Event, parseEvent } from "@tasb/core";
import { describe, expect, it } from "vitest";
import { createDeleteAction } from "./index.js";

const fixtures = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../fixtures/delete.json"),
    "utf8",
  ),
) as {
  name: string;
  dryRun: boolean;
  hasMessage: boolean;
  status: string;
  detail?: string;
}[];

function messageEvent(): Event {
  return parseEvent({
    id: "evt_1",
    tenantId: "tenant_demo",
    chatId: "chat_demo",
    kind: "message",
    occurredAt: "2026-11-01T00:00:00Z",
    actor: { id: "user_1", isAdmin: false },
    message: { id: "msg_1", text: "spam", textSha256: "c".repeat(64) },
  });
}

describe("delete action", () => {
  it("follows fixtures", async () => {
    const action = createDeleteAction();
    for (const fixture of fixtures) {
      const deleted: DeleteTarget[] = [];
      const event = messageEvent();
      const result = await action.execute({
        event: fixture.hasMessage ? event : { ...event, message: undefined },
        decision: {
          action: "delete",
          ruleIds: ["spam_keywords"],
          score: 1,
          reasons: [],
          evidence: [],
        },
        dryRun: fixture.dryRun,
        moderator: {
          async deleteMessage(target) {
            deleted.push(target);
          },
        },
        logger: { info() {}, warn() {}, error() {} },
        signal: new AbortController().signal,
      });
      expect(result.status, fixture.name).toBe(fixture.status);
      expect(result.detail).toBe(fixture.detail);
      expect(deleted).toHaveLength(fixture.status === "executed" ? 1 : 0);
    }
  });
});
