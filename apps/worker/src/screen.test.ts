import { createMemoryLogger, parseEvent } from "@tasb/core";
import { sha256Hex } from "@tasb/platform-telegram";
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

  it("exempts admins before the keyword detector", async () => {
    const result = await screenTelegramEvent(await event("免费领取", true));
    expect(result.outcome).toBe("exempt");
    expect(result.decision.action).toBe("allow");
  });
});
