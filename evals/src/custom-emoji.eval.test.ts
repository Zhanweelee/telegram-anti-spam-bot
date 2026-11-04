import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type EventKind, type Logger, parseEvent } from "@tasb/core";
import { createCustomEmojiDetector } from "@tasb/detector-emoji";
import { describe, expect, it } from "vitest";

interface CustomEmojiCase {
  readonly id: string;
  readonly kind: EventKind;
  readonly label: "spam" | "ham";
  readonly asCustomEmoji?: true;
}

interface Baseline {
  readonly detector: string;
  readonly precision: number;
  readonly recall: number;
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cases = JSON.parse(
  readFileSync(join(root, "cases/custom-emoji.json"), "utf8"),
) as CustomEmojiCase[];
const baseline = JSON.parse(
  readFileSync(join(root, "baselines/custom-emoji.json"), "utf8"),
) as Baseline;
const logger: Logger = { info() {}, warn() {}, error() {} };

describe("custom emoji eval", () => {
  it("does not regress precision or recall", async () => {
    const detector = createCustomEmojiDetector();
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
                  ...(item.asCustomEmoji
                    ? { asCustomEmoji: true as const }
                    : {}),
                },
              }
            : {}),
        }),
        logger,
        signal: { aborted: false },
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
    console.info(
      JSON.stringify({
        detector: "custom_emoji",
        cases: cases.length,
        precision,
        recall,
        baseline,
      }),
    );
    expect(precision).toBeGreaterThanOrEqual(baseline.precision);
    expect(recall).toBeGreaterThanOrEqual(baseline.recall);
  });
});
