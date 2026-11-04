import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Event, parseEvent } from "@tasb/core";
import { describe, expect, it } from "vitest";
import { createFolderDetector } from "./index.js";

const fixtures = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../fixtures/folder.json"),
    "utf8",
  ),
) as {
  name: string;
  kind: "message" | "chat_member";
  folderInvite?: true;
  expect: "hit" | "miss";
}[];

const link = "https://t.me/addlist/SecretFolder";

function eventFor(fixture: (typeof fixtures)[number]): Event {
  return parseEvent({
    id: "evt_folder",
    tenantId: "tenant_demo",
    chatId: "chat_demo",
    kind: fixture.kind,
    occurredAt: "2026-11-01T00:00:00.000Z",
    actor: { id: "user_1", isAdmin: false },
    ...(fixture.folderInvite ? { folderInvite: true } : {}),
    ...(fixture.kind === "message"
      ? {
          message: {
            id: "msg_1",
            text: "今天站会",
            textSha256: "c".repeat(64),
          },
        }
      : {}),
  });
}

describe("folder detector", () => {
  const detector = createFolderDetector();

  it("matches a folder invite and ignores a normal join", async () => {
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
        detectorId: "folder",
        score: 1,
        reasons: ["folder_joined"],
        evidence: [{ kind: "feature", summary: "folder:invite" }],
      });
      expect(JSON.stringify(hit), fixture.name).not.toContain(link);
      expect(JSON.stringify(hit), fixture.name).not.toContain("SecretFolder");
    }
  });
});
