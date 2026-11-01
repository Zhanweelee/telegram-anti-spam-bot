import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { feedbackCaseSchema } from "@tasb/core";
import { describe, expect, it } from "vitest";

interface FeedbackFileCase {
  readonly id: string;
  readonly label: "spam" | "ham";
}

interface Baseline {
  readonly kind: string;
  readonly cases: number;
  readonly spam: number;
  readonly ham: number;
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cases = JSON.parse(
  readFileSync(join(root, "cases/feedback.json"), "utf8"),
) as FeedbackFileCase[];
const baseline = JSON.parse(
  readFileSync(join(root, "baselines/feedback.json"), "utf8"),
) as Baseline;

describe("feedback eval cases", () => {
  it("keeps hash, features, and labels, and rejects message text", () => {
    let spam = 0;
    let ham = 0;
    for (const item of cases) {
      const parsed = feedbackCaseSchema.parse(item);
      expect(parsed).not.toHaveProperty("text");
      expect(JSON.stringify(parsed)).not.toContain('"text"');
      if (parsed.label === "spam") {
        spam += 1;
      } else {
        ham += 1;
      }
    }
    expect({
      kind: "feedback",
      cases: cases.length,
      spam,
      ham,
    }).toEqual(baseline);
    expect(() =>
      feedbackCaseSchema.parse({
        ...cases[0],
        text: "not-stored",
      }),
    ).toThrow();
  });
});
