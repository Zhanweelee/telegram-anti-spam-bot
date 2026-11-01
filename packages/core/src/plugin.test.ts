import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseEvent } from "./event.js";
import { createMemoryLogger } from "./logger.js";
import { defineAction, defineDetector } from "./plugin.js";

const event = parseEvent({
  id: "evt_1",
  tenantId: "tenant_1",
  chatId: "chat_1",
  kind: "command",
  occurredAt: "2026-11-01T00:00:00Z",
  actor: { id: "user_1", isAdmin: false },
});

describe("plugins", () => {
  it("parses config and rejects a bad version", async () => {
    const detector = defineDetector({
      id: "keyword",
      version: "0.1.0",
      capabilities: ["text"],
      configSchema: z.strictObject({ keywords: z.array(z.string()).min(1) }),
      config: { keywords: ["a"] },
      async detect(_ctx, config) {
        return {
          detectorId: "keyword",
          score: 1,
          reasons: config.keywords,
          evidence: [],
        };
      },
    });
    const hit = await detector.detect({
      event,
      logger: createMemoryLogger(),
      signal: { aborted: false },
    });
    expect(hit?.reasons).toEqual(["a"]);
    expect(() =>
      defineDetector({
        id: "keyword",
        version: "next",
        capabilities: [],
        configSchema: z.strictObject({}),
        config: {},
        async detect() {
          return null;
        },
      }),
    ).toThrow();
    expect(() =>
      defineAction({
        id: "Delete",
        version: "0.1.0",
        capabilities: [],
        configSchema: z.strictObject({}),
        config: {},
        async execute() {
          return { actionId: "Delete", status: "executed" };
        },
      }),
    ).toThrow();
  });
});
