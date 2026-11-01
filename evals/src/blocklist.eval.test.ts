import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type BlocklistStore,
  createMemoryBlocklistStore,
  type Logger,
  parseEvent,
} from "@tasb/core";
import { createBlocklistDetector } from "@tasb/detector-blocklist";
import { describe, expect, it } from "vitest";

interface BlocklistCase {
  readonly id: string;
  readonly text: string;
  readonly label: "spam" | "ham";
  readonly optIn: boolean;
  readonly toggled?: boolean;
  readonly chatId?: string;
  readonly enabledChats?: readonly string[];
  readonly actorId: string;
  readonly hash?: string;
  readonly reject?: boolean;
  readonly entries: readonly {
    readonly kind: "actor" | "hash";
    readonly value: string;
    readonly tenantId?: string;
  }[];
  readonly readsShared?: boolean;
}

interface Baseline {
  readonly detector: string;
  readonly precision: number;
  readonly recall: number;
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cases = JSON.parse(
  readFileSync(join(root, "cases/blocklist.json"), "utf8"),
) as BlocklistCase[];
const baseline = JSON.parse(
  readFileSync(join(root, "baselines/blocklist.json"), "utf8"),
) as Baseline;
const logger: Logger = { info() {}, warn() {}, error() {} };
const signal = { aborted: false };
const phrase = "请免费领取礼品";

function countingStore(): { store: BlocklistStore; reads: () => number } {
  const inner = createMemoryBlocklistStore();
  let reads = 0;
  const store: BlocklistStore = {
    isEnabled: (tenantId, chatId) => inner.isEnabled(tenantId, chatId),
    setEnabled: (tenantId, chatId, enabled) =>
      inner.setEnabled(tenantId, chatId, enabled),
    add: (tenantId, entry) => inner.add(tenantId, entry),
    remove: (tenantId, entry) => inner.remove(tenantId, entry),
    size: (tenantId) => inner.size(tenantId),
    async has(tenantId, entry) {
      reads += 1;
      return inner.has(tenantId, entry);
    },
  };
  return { store, reads: () => reads };
}

export async function evaluateBlocklist(): Promise<{
  precision: number;
  recall: number;
  sharedReadsWhenOff: number;
}> {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let sharedReadsWhenOff = 0;
  for (const item of cases) {
    const box = countingStore();
    for (const entry of item.entries) {
      await box.store.add(entry.tenantId ?? "tenant_eval", {
        kind: entry.kind,
        value: entry.value,
      });
    }
    const chatId = item.chatId ?? "chat_eval";
    for (const enabledChat of item.enabledChats ?? []) {
      await box.store.setEnabled("tenant_eval", enabledChat, true);
    }
    if (item.toggled || item.optIn) {
      await box.store.setEnabled("tenant_eval", chatId, true);
    }
    if (!item.optIn) {
      await box.store.setEnabled("tenant_eval", chatId, false);
    }
    if (item.reject) {
      await expect(
        box.store.add("tenant_eval", { kind: "actor", value: item.text }),
      ).rejects.toThrow();
    }
    const before = box.reads();
    const detector = createBlocklistDetector({ store: box.store });
    const hit = await detector.detect({
      event: parseEvent({
        id: item.id,
        tenantId: "tenant_eval",
        chatId,
        kind: "message",
        occurredAt: "2026-11-01T00:00:00.000Z",
        actor: { id: item.actorId, isAdmin: false },
        message: {
          id: "1",
          text: item.text,
          textSha256: item.hash ?? "e".repeat(64),
        },
      }),
      logger,
      signal,
    });
    if (item.readsShared === false && box.reads() !== before) {
      sharedReadsWhenOff += 1;
    }
    if (hit) {
      expect(JSON.stringify(hit)).not.toContain(phrase);
    }
    const predicted = hit === null ? "ham" : "spam";
    if (predicted === "spam" && item.label === "spam") tp += 1;
    else if (predicted === "spam" && item.label === "ham") fp += 1;
    else if (predicted === "ham" && item.label === "spam") fn += 1;
  }
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  return { precision, recall, sharedReadsWhenOff };
}

describe("blocklist eval", () => {
  it("does not regress precision or recall", async () => {
    const report = await evaluateBlocklist();
    console.info(
      JSON.stringify({
        detector: "blocklist",
        cases: cases.length,
        precision: report.precision,
        recall: report.recall,
        baseline,
      }),
    );
    expect(report.precision).toBeGreaterThanOrEqual(baseline.precision);
    expect(report.recall).toBeGreaterThanOrEqual(baseline.recall);
    expect(report.sharedReadsWhenOff).toBe(0);
  });
});
