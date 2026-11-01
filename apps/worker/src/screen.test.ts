import { createMemoryLogger, parseEvent } from "@tasb/core";
import { createKeywordDetector } from "@tasb/detector-keyword";
import { normalizeUpdate, sha256Hex } from "@tasb/platform-telegram";
import { describe, expect, it } from "vitest";
import { screenTelegramEvent } from "./screen.js";

async function event(text: string, isAdmin = false) {
  return parseEvent({
    id: "tg_1",
    tenantId: "local",
    chatId: "-100",
    kind: "message",
    occurredAt: "2026-11-01T00:00:00.000Z",
    actor: { id: "5", isAdmin },
    message: { id: "9", text, textSha256: await sha256Hex(text) },
  });
}

describe("screenTelegramEvent", () => {
  it("decides delete for a keyword without keeping the raw text in logs", async () => {
    const text = "请免费领取礼品";
    const logger = createMemoryLogger();
    const result = await screenTelegramEvent(await event(text), logger);
    expect(result.decision.action).toBe("delete");
    expect(result.actionResults[0]?.status).toBe("executed");
    const logged = JSON.stringify(logger.entries);
    expect(logged).not.toContain(text);
    expect(logged).not.toContain('"text"');
  });

  it("allows ordinary text and empty text", async () => {
    const hello = await screenTelegramEvent(await event("hello"));
    expect(hello.decision.action).toBe("allow");
    expect(hello.actionResults).toEqual([]);

    const empty = await screenTelegramEvent(await event(""));
    expect(empty.decision.action).toBe("allow");
  });

  it("lets a join with no text through the pipeline", async () => {
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2001,
        chat_member: {
          chat: { id: -100123 },
          from: { id: 1, first_name: "Admin" },
          date: 1761955200,
          new_chat_member: {
            user: { id: 77, first_name: "Newbie" },
            status: "member",
          },
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    const detector = createKeywordDetector({ keywords: ["免费领取"] });
    const logger = createMemoryLogger();
    expect(
      await detector.detect({
        event: outcome.event,
        logger,
        signal: { aborted: false },
      }),
    ).toBeNull();
    const result = await screenTelegramEvent(outcome.event, logger);
    expect(result.decision.action).toBe("allow");
    expect(result.detectorErrors).toEqual([]);
    expect(JSON.stringify(logger.entries)).not.toContain("Newbie");
  });

  it("exempts admins before the keyword detector", async () => {
    const result = await screenTelegramEvent(await event("免费领取", true));
    expect(result.outcome).toBe("exempt");
    expect(result.decision.action).toBe("allow");
  });
});
