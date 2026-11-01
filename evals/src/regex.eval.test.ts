import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Logger, parseEvent } from "@tasb/core";
import {
  createRegexDetector,
  defaultRegexPatterns,
} from "@tasb/detector-regex";
import { describe, expect, it } from "vitest";

interface Case {
  readonly id: string;
  readonly text: string;
  readonly label: "spam" | "ham";
}

interface Baseline {
  readonly detector: string;
  readonly precision: number;
  readonly recall: number;
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cases = JSON.parse(
  readFileSync(join(root, "cases/regex.json"), "utf8"),
) as Case[];
const baseline = JSON.parse(
  readFileSync(join(root, "baselines/regex.json"), "utf8"),
) as Baseline;
const logger: Logger = { info() {}, warn() {}, error() {} };

function eventFor(text: string) {
  return parseEvent({
    id: "evt_eval",
    tenantId: "tenant_eval",
    chatId: "chat_eval",
    kind: "message",
    occurredAt: "2026-11-01T00:00:00Z",
    actor: { id: "user_eval", isAdmin: false },
    message: { id: "msg_eval", text, textSha256: "e".repeat(64) },
  });
}

export async function evaluateRegex(): Promise<{
  precision: number;
  recall: number;
  tp: number;
  fp: number;
  fn: number;
}> {
  const detector = createRegexDetector({
    patterns: [...defaultRegexPatterns],
  });
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (const item of cases) {
    const hit = await detector.detect({
      event: eventFor(item.text),
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

describe("regex eval", () => {
  it("does not regress precision or recall", async () => {
    expect(cases).toHaveLength(16);
    for (const item of cases) {
      expect(Object.keys(item).sort()).toEqual(["id", "label", "text"]);
    }
    const report = await evaluateRegex();
    console.info(
      JSON.stringify({
        detector: "regex",
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
