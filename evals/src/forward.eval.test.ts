import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ForwardKind, type Logger, parseEvent } from "@tasb/core";
import {
  createForwardDetector,
  defaultForwardKinds,
} from "@tasb/detector-forward";
import { describe, expect, it } from "vitest";

interface Case {
  readonly id: string;
  readonly text: string;
  readonly label: "spam" | "ham";
  readonly forward?: ForwardKind;
}

interface Baseline {
  readonly detector: string;
  readonly precision: number;
  readonly recall: number;
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cases = JSON.parse(
  readFileSync(join(root, "cases/forward.json"), "utf8"),
) as Case[];
const baseline = JSON.parse(
  readFileSync(join(root, "baselines/forward.json"), "utf8"),
) as Baseline;
const logger: Logger = { info() {}, warn() {}, error() {} };
const allowedKeys = new Set(["id", "text", "label", "forward"]);

function eventFor(item: Case) {
  return parseEvent({
    id: "evt_eval",
    tenantId: "tenant_eval",
    chatId: "chat_eval",
    kind: "message",
    occurredAt: "2026-11-01T00:00:00Z",
    actor: { id: "user_eval", isAdmin: false },
    message: {
      id: "msg_eval",
      text: item.text,
      textSha256: "e".repeat(64),
      ...(item.forward ? { forward: item.forward } : {}),
    },
  });
}

export async function evaluateForward(): Promise<{
  precision: number;
  recall: number;
  tp: number;
  fp: number;
  fn: number;
}> {
  const detector = createForwardDetector({
    kinds: [...defaultForwardKinds],
  });
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (const item of cases) {
    const hit = await detector.detect({
      event: eventFor(item),
      logger,
      signal: new AbortController().signal,
    });
    const predicted = hit === null ? "ham" : "spam";
    if (predicted === "spam" && item.label === "spam") tp += 1;
    else if (predicted === "spam" && item.label === "ham") fp += 1;
    else if (predicted === "ham" && item.label === "spam") fn += 1;
  }
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  return { precision, recall, tp, fp, fn };
}

describe("forward eval", () => {
  it("does not regress precision or recall", async () => {
    expect(cases).toHaveLength(8);
    for (const item of cases) {
      for (const key of Object.keys(item)) {
        expect(allowedKeys.has(key)).toBe(true);
      }
    }
    const report = await evaluateForward();
    console.info(
      JSON.stringify({
        detector: "forward",
        cases: cases.length,
        precision: report.precision,
        recall: report.recall,
        baseline,
      }),
    );
    expect(report.precision).toBeGreaterThanOrEqual(baseline.precision);
    expect(report.recall).toBeGreaterThanOrEqual(baseline.recall);
  });
});
