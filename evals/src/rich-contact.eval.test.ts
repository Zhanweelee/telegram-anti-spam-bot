import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type EventKind, type Logger, parseEvent } from "@tasb/core";
import { createRichDetector, type RichContact } from "@tasb/detector-rich";
import { describe, expect, it } from "vitest";

interface RichContactCase {
  readonly id: string;
  readonly kind: EventKind;
  readonly label: "spam" | "ham";
  readonly asRichPhone?: true;
  readonly asRichCard?: true;
  readonly asRichEmail?: true;
  readonly asRichMention?: true;
  readonly asRichTextMention?: true;
  readonly asRichCommand?: true;
  readonly asRichHashtag?: true;
  readonly asRichCashtag?: true;
  readonly asRichAnchor?: true;
}

interface Baseline {
  readonly detector: string;
  readonly precision: number;
  readonly recall: number;
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const logger: Logger = { info() {}, warn() {}, error() {} };

async function evaluate(
  kind: RichContact,
  cases: readonly RichContactCase[],
): Promise<{ precision: number; recall: number }> {
  const detector = createRichDetector(kind);
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
                ...(item.asRichPhone ? { asRichPhone: true as const } : {}),
                ...(item.asRichCard ? { asRichCard: true as const } : {}),
                ...(item.asRichEmail ? { asRichEmail: true as const } : {}),
                ...(item.asRichMention ? { asRichMention: true as const } : {}),
                ...(item.asRichTextMention
                  ? { asRichTextMention: true as const }
                  : {}),
                ...(item.asRichCommand ? { asRichCommand: true as const } : {}),
                ...(item.asRichHashtag ? { asRichHashtag: true as const } : {}),
                ...(item.asRichCashtag ? { asRichCashtag: true as const } : {}),
                ...(item.asRichAnchor ? { asRichAnchor: true as const } : {}),
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
  return { precision, recall };
}

function load(name: string): RichContactCase[] {
  return JSON.parse(
    readFileSync(join(root, name), "utf8"),
  ) as RichContactCase[];
}

describe("rich contact eval", () => {
  it("does not regress phone precision or recall", async () => {
    const cases = load("cases/rich-phone.json");
    const baseline = JSON.parse(
      readFileSync(join(root, "baselines/rich-phone.json"), "utf8"),
    ) as Baseline;
    const report = await evaluate("phone", cases);
    console.info(
      JSON.stringify({
        detector: "rich_phone",
        cases: cases.length,
        precision: report.precision,
        recall: report.recall,
        baseline,
      }),
    );
    expect(report.precision).toBeGreaterThanOrEqual(baseline.precision);
    expect(report.recall).toBeGreaterThanOrEqual(baseline.recall);
  });

  it("does not regress card precision or recall", async () => {
    const cases = load("cases/rich-card.json");
    const baseline = JSON.parse(
      readFileSync(join(root, "baselines/rich-card.json"), "utf8"),
    ) as Baseline;
    const report = await evaluate("card", cases);
    console.info(
      JSON.stringify({
        detector: "rich_card",
        cases: cases.length,
        precision: report.precision,
        recall: report.recall,
        baseline,
      }),
    );
    expect(report.precision).toBeGreaterThanOrEqual(baseline.precision);
    expect(report.recall).toBeGreaterThanOrEqual(baseline.recall);
  });

  it("does not regress email precision or recall", async () => {
    const cases = load("cases/rich-email.json");
    const baseline = JSON.parse(
      readFileSync(join(root, "baselines/rich-email.json"), "utf8"),
    ) as Baseline;
    const report = await evaluate("email", cases);
    console.info(
      JSON.stringify({
        detector: "rich_email",
        cases: cases.length,
        precision: report.precision,
        recall: report.recall,
        baseline,
      }),
    );
    expect(report.precision).toBeGreaterThanOrEqual(baseline.precision);
    expect(report.recall).toBeGreaterThanOrEqual(baseline.recall);
  });

  it("does not regress mention precision or recall", async () => {
    const cases = load("cases/rich-mention.json");
    const baseline = JSON.parse(
      readFileSync(join(root, "baselines/rich-mention.json"), "utf8"),
    ) as Baseline;
    const report = await evaluate("mention", cases);
    console.info(
      JSON.stringify({
        detector: "rich_mention",
        cases: cases.length,
        precision: report.precision,
        recall: report.recall,
        baseline,
      }),
    );
    expect(report.precision).toBeGreaterThanOrEqual(baseline.precision);
    expect(report.recall).toBeGreaterThanOrEqual(baseline.recall);
  });

  it("does not regress text mention precision or recall", async () => {
    const cases = load("cases/rich-text-mention.json");
    const baseline = JSON.parse(
      readFileSync(join(root, "baselines/rich-text-mention.json"), "utf8"),
    ) as Baseline;
    const report = await evaluate("text_mention", cases);
    console.info(
      JSON.stringify({
        detector: "rich_text_mention",
        cases: cases.length,
        precision: report.precision,
        recall: report.recall,
        baseline,
      }),
    );
    expect(report.precision).toBeGreaterThanOrEqual(baseline.precision);
    expect(report.recall).toBeGreaterThanOrEqual(baseline.recall);
  });

  it("does not regress command precision or recall", async () => {
    const cases = load("cases/rich-command.json");
    const baseline = JSON.parse(
      readFileSync(join(root, "baselines/rich-command.json"), "utf8"),
    ) as Baseline;
    const report = await evaluate("command", cases);
    console.info(
      JSON.stringify({
        detector: "rich_command",
        cases: cases.length,
        precision: report.precision,
        recall: report.recall,
        baseline,
      }),
    );
    expect(report.precision).toBeGreaterThanOrEqual(baseline.precision);
    expect(report.recall).toBeGreaterThanOrEqual(baseline.recall);
  });

  it("does not regress hashtag precision or recall", async () => {
    const cases = load("cases/rich-hashtag.json");
    const baseline = JSON.parse(
      readFileSync(join(root, "baselines/rich-hashtag.json"), "utf8"),
    ) as Baseline;
    const report = await evaluate("hashtag", cases);
    console.info(
      JSON.stringify({
        detector: "rich_hashtag",
        cases: cases.length,
        precision: report.precision,
        recall: report.recall,
        baseline,
      }),
    );
    expect(report.precision).toBeGreaterThanOrEqual(baseline.precision);
    expect(report.recall).toBeGreaterThanOrEqual(baseline.recall);
  });

  it("does not regress cashtag precision or recall", async () => {
    const cases = load("cases/rich-cashtag.json");
    const baseline = JSON.parse(
      readFileSync(join(root, "baselines/rich-cashtag.json"), "utf8"),
    ) as Baseline;
    const report = await evaluate("cashtag", cases);
    console.info(
      JSON.stringify({
        detector: "rich_cashtag",
        cases: cases.length,
        precision: report.precision,
        recall: report.recall,
        baseline,
      }),
    );
    expect(report.precision).toBeGreaterThanOrEqual(baseline.precision);
    expect(report.recall).toBeGreaterThanOrEqual(baseline.recall);
  });

  it("does not regress anchor precision or recall", async () => {
    const cases = load("cases/rich-anchor.json");
    const baseline = JSON.parse(
      readFileSync(join(root, "baselines/rich-anchor.json"), "utf8"),
    ) as Baseline;
    const report = await evaluate("anchor", cases);
    console.info(
      JSON.stringify({
        detector: "rich_anchor",
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
