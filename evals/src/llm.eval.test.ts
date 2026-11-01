import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type LlmClassifier,
  type LlmVerdict,
  type Logger,
  parseEvent,
} from "@tasb/core";
import { createLlmDetector } from "@tasb/detector-llm";
import { describe, expect, it } from "vitest";

interface LlmCase {
  readonly id: string;
  readonly text: string;
  readonly label: "spam" | "ham";
  readonly verdict?: { readonly label: string; readonly score: number };
  readonly source?: "timeout" | "throw" | "absent";
}

interface Baseline {
  readonly detector: string;
  readonly precision: number;
  readonly recall: number;
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cases = JSON.parse(
  readFileSync(join(root, "cases/llm.json"), "utf8"),
) as LlmCase[];
const baseline = JSON.parse(
  readFileSync(join(root, "baselines/llm.json"), "utf8"),
) as Baseline;
const logger: Logger = { info() {}, warn() {}, error() {} };
const signal = { aborted: false };

function classifierFor(item: LlmCase): LlmClassifier | undefined {
  if (item.source === "absent") {
    return undefined;
  }
  if (item.source === "timeout") {
    return { classify: () => new Promise<LlmVerdict>(() => {}) };
  }
  if (item.source === "throw") {
    return {
      async classify() {
        throw new Error("quota");
      },
    };
  }
  const verdict = item.verdict;
  if (!verdict) {
    return undefined;
  }
  return {
    async classify() {
      return verdict;
    },
  };
}

export async function evaluateLlm(): Promise<{
  precision: number;
  recall: number;
}> {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (const item of cases) {
    const classifier = classifierFor(item);
    const detector = createLlmDetector({
      ...(classifier === undefined ? {} : { classifier }),
      timeoutMs: 15,
    });
    const hit = await detector.detect({
      event: parseEvent({
        id: item.id,
        tenantId: "tenant_eval",
        chatId: "chat_eval",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00.000Z",
        actor: { id: "user_eval", isAdmin: false },
        message: {
          id: "1",
          text: item.text,
          textSha256: "e".repeat(64),
        },
      }),
      logger,
      signal,
    });
    const predicted = hit === null ? "ham" : "spam";
    if (predicted === "spam" && item.label === "spam") {
      tp += 1;
    } else if (predicted === "spam" && item.label === "ham") {
      fp += 1;
    } else if (predicted === "ham" && item.label === "spam") {
      fn += 1;
    }
  }
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  return { precision, recall };
}

describe("llm eval", () => {
  it("does not regress precision or recall", async () => {
    const report = await evaluateLlm();
    console.info(
      JSON.stringify({
        detector: "llm",
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
