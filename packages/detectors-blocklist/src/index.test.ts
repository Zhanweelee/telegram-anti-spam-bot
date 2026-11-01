import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type BlocklistStore,
  createMemoryBlocklistStore,
  createMemoryLogger,
  type Event,
  parseEvent,
} from "@tasb/core";
import { describe, expect, it } from "vitest";
import { createBlocklistDetector } from "./index.js";

const fixtures = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../fixtures/blocklist.json"),
    "utf8",
  ),
) as {
  name: string;
  optIn: boolean;
  toggled?: boolean;
  chatId?: string;
  enabledChats?: string[];
  actorId: string;
  text: string;
  hash?: string;
  reject?: boolean;
  entries: { kind: "actor" | "hash"; value: string }[];
  expect: "hit" | "miss";
  reason?: string;
  readsShared?: boolean;
}[];

const phrase = "请免费领取礼品";
const signal = { aborted: false };
const fallbackHash = "e".repeat(64);

function eventFor(input: {
  actorId: string;
  text: string;
  hash?: string;
  chatId?: string;
}): Event {
  return parseEvent({
    id: "evt_block",
    tenantId: "tenant_demo",
    chatId: input.chatId ?? "chat_demo",
    kind: "message",
    occurredAt: "2026-11-01T00:00:00.000Z",
    actor: { id: input.actorId, isAdmin: false },
    message: {
      id: "msg_1",
      text: input.text,
      textSha256: input.hash ?? fallbackHash,
    },
  });
}

function countingStore(): {
  store: BlocklistStore;
  reads: () => number;
  inner: ReturnType<typeof createMemoryBlocklistStore>;
} {
  const inner = createMemoryBlocklistStore();
  let reads = 0;
  const store: BlocklistStore = {
    isEnabled: (tenantId, chatId) => inner.isEnabled(tenantId, chatId),
    setEnabled: (tenantId, chatId, enabled) =>
      inner.setEnabled(tenantId, chatId, enabled),
    add: (tenantId, entry) => inner.add(tenantId, entry),
    async has(tenantId, entry) {
      reads += 1;
      return inner.has(tenantId, entry);
    },
  };
  return { store, reads: () => reads, inner };
}

describe("blocklist fixtures", () => {
  it("shares ids only while the chat is opted in", async () => {
    for (const fixture of fixtures) {
      const logger = createMemoryLogger();
      const box = countingStore();
      for (const entry of fixture.entries) {
        await box.store.add("tenant_demo", entry);
      }
      for (const chatId of fixture.enabledChats ?? []) {
        await box.store.setEnabled("tenant_demo", chatId, true);
      }
      const chatId = fixture.chatId ?? "chat_demo";
      if (fixture.toggled || fixture.optIn) {
        await box.store.setEnabled("tenant_demo", chatId, true);
      }
      if (!fixture.optIn) {
        await box.store.setEnabled("tenant_demo", chatId, false);
      }
      if (fixture.reject) {
        await expect(
          box.store.add("tenant_demo", { kind: "actor", value: phrase }),
        ).rejects.toThrow();
        await expect(
          box.store.add("tenant_demo", { kind: "hash", value: phrase }),
        ).rejects.toThrow();
        expect(JSON.stringify(box.inner.snapshot())).not.toContain(phrase);
        expect(JSON.stringify(box.inner.snapshot())).not.toContain('"text"');
      }
      const before = box.reads();
      const detector = createBlocklistDetector({ store: box.store });
      const hit = await detector.detect({
        event: eventFor(fixture),
        logger,
        signal,
      });
      if (fixture.expect === "miss") {
        expect(hit, fixture.name).toBeNull();
      } else {
        expect(hit?.reasons, fixture.name).toEqual([fixture.reason]);
        expect(hit?.score, fixture.name).toBe(1);
        expect(hit?.evidence[0]?.summary.length ?? 0).toBeLessThanOrEqual(120);
      }
      if (fixture.readsShared === false) {
        expect(box.reads(), fixture.name).toBe(before);
      }
      const dumped = JSON.stringify({ hit, logs: logger.entries });
      expect(dumped, fixture.name).not.toContain(phrase);
      if (fixture.hash) {
        expect(dumped, fixture.name).not.toContain(fixture.hash);
        expect(dumped, fixture.name).toContain(fixture.hash.slice(0, 8));
      }
    }
  });

  it("fail-opens when the store throws and does not read after opt-out", async () => {
    const logger = createMemoryLogger();
    let reads = 0;
    const closed: BlocklistStore = {
      async isEnabled() {
        throw new Error(phrase);
      },
      async setEnabled() {
        return undefined;
      },
      async has() {
        reads += 1;
        throw new Error(phrase);
      },
      async add() {
        return undefined;
      },
    };
    const detector = createBlocklistDetector({ store: closed });
    const missed = await detector.detect({
      event: eventFor({ actorId: "99", text: phrase }),
      logger,
      signal,
    });
    expect(missed).toBeNull();
    expect(reads).toBe(0);
    expect(JSON.stringify(logger.entries)).not.toContain(phrase);
    expect(
      logger.entries.some((entry) => entry.message === "blocklist_failed"),
    ).toBe(true);

    const openLogger = createMemoryLogger();
    const open: BlocklistStore = {
      async isEnabled() {
        return true;
      },
      async setEnabled() {
        return undefined;
      },
      async has() {
        throw new Error(phrase);
      },
      async add() {
        return undefined;
      },
    };
    const failed = await createBlocklistDetector({ store: open }).detect({
      event: eventFor({ actorId: "99", text: phrase }),
      logger: openLogger,
      signal,
    });
    expect(failed).toBeNull();
    expect(JSON.stringify(openLogger.entries)).not.toContain(phrase);
    expect(
      openLogger.entries.some((entry) => entry.message === "blocklist_failed"),
    ).toBe(true);
  });

  it("skips an actor id that is not an identifier and still checks the hash", async () => {
    const box = countingStore();
    const hash = "ab".repeat(32);
    await box.store.setEnabled("tenant_demo", "chat_demo", true);
    await box.store.add("tenant_demo", { kind: "hash", value: hash });
    const hit = await createBlocklistDetector({ store: box.store }).detect({
      event: eventFor({ actorId: phrase, text: "hello", hash }),
      logger: createMemoryLogger(),
      signal,
    });
    expect(hit?.reasons).toEqual(["shared_hash"]);
    expect(JSON.stringify(hit)).not.toContain(phrase);
    expect(JSON.stringify(hit)).not.toContain(hash);
  });

  it("truncates a long actor id in the evidence summary", async () => {
    const box = countingStore();
    const actorId = "a".repeat(128);
    await box.store.setEnabled("tenant_demo", "chat_demo", true);
    await box.store.add("tenant_demo", { kind: "actor", value: actorId });
    const hit = await createBlocklistDetector({ store: box.store }).detect({
      event: eventFor({ actorId, text: "hello" }),
      logger: createMemoryLogger(),
      signal,
    });
    expect(hit?.evidence[0]?.summary.startsWith("actor:")).toBe(true);
    expect(hit?.evidence[0]?.summary.length).toBeLessThanOrEqual(120);
    expect(hit?.evidence[0]?.summary).not.toContain(actorId);
  });
});
