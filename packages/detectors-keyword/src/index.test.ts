import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Event, type Logger, parseEvent } from "@tasb/core";
import { describe, expect, it } from "vitest";
import { createKeywordDetector } from "./index.js";

const fixtures = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../fixtures/messages.json"),
    "utf8",
  ),
) as { text: string; expect: "hit" | "miss" }[];

const logger: Logger = { info() {}, warn() {}, error() {} };
const signal = new AbortController().signal;
const HASH = "b".repeat(64);

function messageEvent(text: string): Event {
  return parseEvent({
    id: "evt_1",
    tenantId: "tenant_demo",
    chatId: "chat_demo",
    kind: "message",
    occurredAt: "2026-11-01T00:00:00Z",
    actor: { id: "user_1", isAdmin: false },
    message: { id: "msg_1", text, textSha256: HASH },
  });
}

describe("keyword detector", () => {
  const detector = createKeywordDetector({ keywords: ["免费领取", "加微信"] });

  it("matches fixtures", async () => {
    for (const fixture of fixtures) {
      const hit = await detector.detect({
        event: messageEvent(fixture.text),
        logger,
        signal,
      });
      expect(hit === null ? "miss" : "hit").toBe(fixture.expect);
    }
  });

  it("can be case sensitive and ignores events without text", async () => {
    const sensitive = createKeywordDetector({
      keywords: ["Spam"],
      caseSensitive: true,
    });
    expect(
      await sensitive.detect({ event: messageEvent("spam"), logger, signal }),
    ).toBeNull();
    expect(
      (await sensitive.detect({ event: messageEvent("Spam"), logger, signal }))
        ?.evidence[0]?.summary,
    ).toBe("keyword:Spam");
    const member = parseEvent({
      id: "evt_1",
      tenantId: "tenant_demo",
      chatId: "chat_demo",
      kind: "chat_member",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
    });
    expect(await detector.detect({ event: member, logger, signal })).toBeNull();
  });

  it("matches a join profile without copying the whole name", async () => {
    const name = "广告员免费领取礼品";
    const hit = await detector.detect({
      event: parseEvent({
        id: "evt_1",
        tenantId: "tenant_demo",
        chatId: "chat_demo",
        kind: "chat_member",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        membership: "join",
        profile: { text: name, textSha256: HASH },
      }),
      logger,
      signal,
    });
    expect(hit?.reasons).toEqual(["keyword_match"]);
    expect(hit?.evidence).toEqual([
      { kind: "keyword", summary: "keyword:免费领取" },
    ]);
    expect(JSON.stringify(hit)).not.toContain(name);
  });

  it("rejects an empty keyword list", () => {
    expect(() => createKeywordDetector({ keywords: [] })).toThrow();
  });
});
