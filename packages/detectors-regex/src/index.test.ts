import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Event, type Logger, parseEvent } from "@tasb/core";
import { describe, expect, it } from "vitest";
import { createRegexDetector, defaultRegexPatterns } from "./index.js";

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

describe("regex detector", () => {
  const detector = createRegexDetector({
    patterns: [...defaultRegexPatterns],
  });

  it("matches fixtures without copying the text", async () => {
    for (const fixture of fixtures) {
      const hit = await detector.detect({
        event: messageEvent(fixture.text),
        logger,
        signal,
      });
      expect(hit === null ? "miss" : "hit").toBe(fixture.expect);
      if (fixture.expect === "hit" && fixture.text.length > 0) {
        expect(JSON.stringify(hit)).not.toContain(fixture.text);
        expect(hit?.evidence).toEqual([
          { kind: "feature", summary: "regex:hit" },
        ]);
        expect(hit?.reasons).toEqual(["regex_match"]);
      }
    }
  });

  it("ignores events without text", async () => {
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

  it("accepts a short unquantified subset and rejects the rest", () => {
    expect(() =>
      createRegexDetector({
        patterns: ["https?://", "t\\.me/\\+", "加微[信xX]", "(a|b)"],
      }),
    ).not.toThrow();
    const unsafe = [
      "(a+)+",
      "(a*)*",
      "(?=a)",
      "\\1",
      "(",
      "a".repeat(65),
      "++",
      "a{2}",
    ];
    for (const pattern of unsafe) {
      expect(() => createRegexDetector({ patterns: [pattern] })).toThrow();
    }
    expect(() => createRegexDetector({ patterns: [] })).toThrow();
    expect(() =>
      createRegexDetector({
        patterns: Array.from({ length: 9 }, () => "a"),
      }),
    ).toThrow();
  });

  it("fails open when matching throws and does not log the text", async () => {
    const single = createRegexDetector({ patterns: ["a"] });
    const event = messageEvent("aaaa");
    const original = RegExp.prototype.test;
    const leak = "加微x secret";
    RegExp.prototype.test = () => {
      throw new Error(leak);
    };
    const warnings: { message: string; fields?: unknown }[] = [];
    try {
      const hit = await single.detect({
        event,
        logger: {
          info() {},
          error() {},
          warn(message, fields) {
            warnings.push({ message, fields });
          },
        },
        signal,
      });
      expect(hit).toBeNull();
    } finally {
      RegExp.prototype.test = original;
    }
    expect(warnings).toEqual([
      {
        message: "regex_failed",
        fields: {
          detectorId: "regex",
          eventId: "evt_1",
          chatId: "chat_demo",
          tenantId: "tenant_demo",
        },
      },
    ]);
    expect(JSON.stringify(warnings)).not.toContain(leak);
  });
});
