import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Event,
  type ForwardKind,
  type Logger,
  parseEvent,
} from "@tasb/core";
import { describe, expect, it } from "vitest";
import { createForwardDetector, defaultForwardKinds } from "./index.js";

const fixtures = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../fixtures/messages.json"),
    "utf8",
  ),
) as { text: string; forward?: ForwardKind; expect: "hit" | "miss" }[];

const logger: Logger = { info() {}, warn() {}, error() {} };
const signal = new AbortController().signal;
const HASH = "b".repeat(64);
const title = "机密频道名";

function messageEvent(text: string, forward?: ForwardKind): Event {
  return parseEvent({
    id: "evt_1",
    tenantId: "tenant_demo",
    chatId: "chat_demo",
    kind: "message",
    occurredAt: "2026-11-01T00:00:00Z",
    actor: { id: "user_1", isAdmin: false },
    message: {
      id: "msg_1",
      text,
      textSha256: HASH,
      ...(forward ? { forward } : {}),
    },
  });
}

describe("forward detector", () => {
  const detector = createForwardDetector({
    kinds: [...defaultForwardKinds],
  });

  it("matches fixtures without copying a title", async () => {
    for (const fixture of fixtures) {
      const hit = await detector.detect({
        event: messageEvent(fixture.text, fixture.forward),
        logger,
        signal,
      });
      expect(hit === null ? "miss" : "hit").toBe(fixture.expect);
      const encoded = JSON.stringify(hit);
      expect(encoded).not.toContain(title);
      if (fixture.expect === "hit") {
        expect(hit?.evidence).toEqual([
          { kind: "feature", summary: "forward:channel" },
        ]);
        expect(hit?.reasons).toEqual(["forward_channel"]);
      }
    }
  });

  it("ignores events without a message and empty kind lists", async () => {
    const member = parseEvent({
      id: "evt_1",
      tenantId: "tenant_demo",
      chatId: "chat_demo",
      kind: "chat_member",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
    });
    expect(await detector.detect({ event: member, logger, signal })).toBeNull();
    expect(() => createForwardDetector({ kinds: [] })).toThrow();
  });

  it("can score one forward kind under its own id", async () => {
    const hidden = createForwardDetector(
      { kinds: ["hidden"] },
      "forward_hidden",
    );
    const hit = await hidden.detect({
      event: messageEvent(title, "hidden"),
      logger,
      signal,
    });
    expect(hit).toEqual({
      detectorId: "forward_hidden",
      score: 1,
      reasons: ["forward_hidden"],
      evidence: [{ kind: "feature", summary: "forward:hidden" }],
    });
    expect(JSON.stringify(hit)).not.toContain(title);
    expect(
      await hidden.detect({
        event: messageEvent(title, "channel"),
        logger,
        signal,
      }),
    ).toBeNull();
    expect(
      await hidden.detect({
        event: messageEvent(title, "user"),
        logger,
        signal,
      }),
    ).toBeNull();
  });
});
