import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Logger, parseEvent } from "@tasb/core";
import {
  createLinkDetector,
  type ReputationSource,
  type ReputationVerdict,
} from "@tasb/detector-link";
import { describe, expect, it } from "vitest";

interface LinkCase {
  readonly id: string;
  readonly text: string;
  readonly label: "spam" | "ham";
  readonly denylist?: readonly string[];
  readonly source?: "timeout" | "bad" | "throw";
}

interface Baseline {
  readonly detector: string;
  readonly precision: number;
  readonly recall: number;
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cases = JSON.parse(
  readFileSync(join(root, "cases/link.json"), "utf8"),
) as LinkCase[];
const baseline = JSON.parse(
  readFileSync(join(root, "baselines/link.json"), "utf8"),
) as Baseline;
const logger: Logger = { info() {}, warn() {}, error() {} };
const signal = { aborted: false };

function sourceFor(kind: LinkCase["source"]): ReputationSource | undefined {
  if (kind === "timeout") {
    return { lookup: () => new Promise<ReputationVerdict>(() => {}) };
  }
  if (kind === "bad") {
    return {
      async lookup() {
        return "bad";
      },
    };
  }
  if (kind === "throw") {
    return {
      async lookup() {
        throw new Error("reputation down");
      },
    };
  }
  return undefined;
}

export async function evaluateLink(): Promise<{
  precision: number;
  recall: number;
}> {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (const item of cases) {
    const source = sourceFor(item.source);
    const detector = createLinkDetector({
      ...(item.denylist === undefined ? {} : { denylist: [...item.denylist] }),
      ...(source === undefined ? {} : { source, sourceTimeoutMs: 15 }),
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
    if (predicted === "spam" && item.label === "spam") tp += 1;
    else if (predicted === "spam" && item.label === "ham") fp += 1;
    else if (predicted === "ham" && item.label === "spam") fn += 1;
  }
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  return { precision, recall };
}

describe("link eval", () => {
  it("does not regress precision or recall", async () => {
    const report = await evaluateLink();
    console.info(
      JSON.stringify({
        detector: "link",
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
