import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type EventKind,
  type Logger,
  type MediaKind,
  parseEvent,
} from "@tasb/core";
import { createMediaDetector } from "@tasb/detector-media";
import { describe, expect, it } from "vitest";

interface MediaCase {
  readonly id: string;
  readonly kind: EventKind;
  readonly label: "spam" | "ham";
  readonly media?: MediaKind;
}

interface Baseline {
  readonly detector: string;
  readonly precision: number;
  readonly recall: number;
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cases = JSON.parse(
  readFileSync(join(root, "cases/media.json"), "utf8"),
) as MediaCase[];
const baseline = JSON.parse(
  readFileSync(join(root, "baselines/media.json"), "utf8"),
) as Baseline;
const logger: Logger = { info() {}, warn() {}, error() {} };

export async function evaluateMedia(): Promise<{
  precision: number;
  recall: number;
}> {
  const detector = createMediaDetector("sticker");
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
        actor: { id: "user_eval", isAdmin: false },
        ...(item.kind === "message"
          ? {
              message: {
                id: "msg_1",
                text: "",
                textSha256: "e".repeat(64),
                ...(item.media ? { media: item.media } : {}),
              },
            }
          : {}),
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

describe("media eval", () => {
  it("does not regress precision or recall", async () => {
    const report = await evaluateMedia();
    console.info(
      JSON.stringify({
        detector: "media_sticker",
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
