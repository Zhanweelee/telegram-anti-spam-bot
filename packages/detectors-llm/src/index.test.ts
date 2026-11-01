import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createMemoryLogger,
  type Event,
  type LlmClassifier,
  type LlmVerdict,
  parseEvent,
} from "@tasb/core";
import { describe, expect, it } from "vitest";
import { createLlmDetector } from "./index.js";

const phrase = "请免费领取礼品";
const signal = { aborted: false };
const hash = "ab".repeat(32);

const fixtures = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../fixtures/llm.json"),
    "utf8",
  ),
) as {
  name: string;
  text: string;
  expect: "hit" | "miss";
  verdict?: { label: string; score: number };
  source?: "timeout" | "throw" | "absent";
}[];

function eventFor(text: string): Event {
  return parseEvent({
    id: "evt_llm",
    tenantId: "tenant_demo",
    chatId: "chat_demo",
    kind: "message",
    occurredAt: "2026-11-01T00:00:00.000Z",
    actor: { id: "user_1", isAdmin: false },
    message: { id: "msg_1", text, textSha256: hash },
  });
}

function classifierFor(
  fixture: (typeof fixtures)[number],
): LlmClassifier | undefined {
  if (fixture.source === "absent") {
    return undefined;
  }
  if (fixture.source === "timeout") {
    return { classify: () => new Promise<LlmVerdict>(() => {}) };
  }
  if (fixture.source === "throw") {
    return {
      async classify() {
        throw new Error(phrase);
      },
    };
  }
  const verdict = fixture.verdict;
  if (!verdict) {
    return undefined;
  }
  return {
    async classify() {
      return verdict;
    },
  };
}

describe("llm fixtures", () => {
  it("hits only a high negative label and skips failures", async () => {
    expect(fixtures.map((item) => item.source ?? item.expect)).toEqual([
      "hit",
      "miss",
      "miss",
      "timeout",
      "throw",
      "absent",
    ]);
    for (const fixture of fixtures) {
      const logger = createMemoryLogger();
      const classifier = classifierFor(fixture);
      const detector = createLlmDetector({
        ...(classifier === undefined ? {} : { classifier }),
        timeoutMs: 15,
      });
      const hit = await detector.detect({
        event: eventFor(fixture.text),
        logger,
        signal,
      });
      if (fixture.expect === "hit") {
        expect(hit?.reasons).toEqual(["llm"]);
        expect(hit?.evidence[0]?.summary).toBe("llm:NEGATIVE");
      } else {
        expect(hit).toBeNull();
      }
      const logs = JSON.stringify(logger.entries);
      expect(logs).not.toContain(fixture.text);
      expect(logs).not.toContain(phrase);
    }
  });
});
