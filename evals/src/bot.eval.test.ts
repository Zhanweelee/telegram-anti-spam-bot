import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type EventKind, type Logger, parseEvent } from "@tasb/core";
import { createBotDetector } from "@tasb/detector-bot";
import { describe, expect, it } from "vitest";

interface BotCase {
  readonly id: string;
  readonly kind: EventKind;
  readonly label: "spam" | "ham";
  readonly bot?: true;
}

interface Baseline {
  readonly detector: string;
  readonly precision: number;
  readonly recall: number;
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cases = JSON.parse(
  readFileSync(join(root, "cases/bot.json"), "utf8"),
) as BotCase[];
const baseline = JSON.parse(
  readFileSync(join(root, "baselines/bot.json"), "utf8"),
) as Baseline;
const logger: Logger = { info() {}, warn() {}, error() {} };

export async function evaluateBot(): Promise<{
  precision: number;
  recall: number;
}> {
  const detector = createBotDetector();
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (const item of cases) {
    const hit = await detector.detect({
      event: parseEvent({
        id: item.id,
        tenantId: "tenant_eval",
        chatId: "chat_eval",
        kind: item.kind,
        occurredAt: "2026-11-01T00:00:00.000Z",
        actor: {
          id: "user_eval",
          isAdmin: false,
          ...(item.bot ? { bot: true } : {}),
        },
      }),
      logger,
      signal: { aborted: false },
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

describe("bot eval", () => {
  it("does not regress precision or recall", async () => {
    const report = await evaluateBot();
    console.info(
      JSON.stringify({
        detector: "bot",
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
