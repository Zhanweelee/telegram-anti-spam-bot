import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Logger, parseEvent } from "@tasb/core";
import {
  createFloodDetector,
  createMemoryRateWindow,
  createRepeatDetector,
} from "@tasb/detector-rate";
import { describe, expect, it } from "vitest";

interface RateCase {
  readonly id: string;
  readonly detector: "flood" | "repeat";
  readonly label: "spam" | "ham";
  readonly messages: number;
  readonly gapMs: number;
  readonly sameActor: boolean;
  readonly sameText: boolean;
  readonly text?: string;
  readonly maxKeys?: number;
  readonly media?: "sticker";
  readonly sameMedia?: boolean;
  readonly albumId?: string;
  readonly edited?: boolean;
}

interface Baseline {
  readonly detector: string;
  readonly precision: number;
  readonly recall: number;
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cases = JSON.parse(
  readFileSync(join(root, "cases/rate.json"), "utf8"),
) as RateCase[];
const baseline = JSON.parse(
  readFileSync(join(root, "baselines/rate.json"), "utf8"),
) as Baseline;
const logger: Logger = { info() {}, warn() {}, error() {} };
const signal = { aborted: false };
const start = Date.parse("2026-11-01T00:00:00.000Z");

function eventFor(item: RateCase, index: number) {
  const text = item.sameText ? (item.text ?? "hello") : `hello-${index}`;
  return parseEvent({
    id: `${item.id}_${index}`,
    tenantId: "tenant_eval",
    chatId: `chat_${item.id}`,
    kind: "message",
    occurredAt: new Date(start + index * item.gapMs).toISOString(),
    actor: {
      id: item.sameActor ? "user_eval" : `user_${index}`,
      isAdmin: false,
    },
    ...(item.edited ? { edited: true } : {}),
    message: {
      id: `${index}`,
      text,
      textSha256: item.sameText ? "e".repeat(64) : `${index}`.padStart(64, "a"),
      ...(item.albumId ? { albumId: item.albumId } : {}),
      ...(item.media
        ? {
            media: item.media,
            mediaSha256:
              item.sameMedia === false
                ? `${index}`.padStart(64, "b")
                : "f".repeat(64),
          }
        : {}),
    },
  });
}

export async function evaluateRate(): Promise<{
  precision: number;
  recall: number;
}> {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (const item of cases) {
    const window = createMemoryRateWindow(
      item.maxKeys === undefined ? {} : { maxKeys: item.maxKeys },
    );
    const detector =
      item.detector === "flood"
        ? createFloodDetector({
            window,
            windowSeconds: 10,
            threshold: 5,
          })
        : createRepeatDetector({
            window,
            windowSeconds: 60,
            threshold: 3,
          });
    let hit: Awaited<ReturnType<typeof detector.detect>> = null;
    for (let index = 0; index < item.messages; index += 1) {
      hit = await detector.detect({
        event: eventFor(item, index),
        logger,
        signal,
      });
    }
    const predicted = hit === null ? "ham" : "spam";
    if (predicted === "spam" && item.label === "spam") tp += 1;
    else if (predicted === "spam" && item.label === "ham") fp += 1;
    else if (predicted === "ham" && item.label === "spam") fn += 1;
  }
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  return { precision, recall };
}

describe("rate eval", () => {
  it("does not regress precision or recall", async () => {
    const report = await evaluateRate();
    console.info(
      JSON.stringify({
        detector: "rate",
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
