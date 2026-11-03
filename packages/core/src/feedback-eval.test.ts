import { describe, expect, it } from "vitest";
import {
  buildFeedbackCase,
  feedbackCaseSchema,
  feedbackEvalDocument,
  feedbackEvalDocumentSchema,
  feedbackLabelFromReview,
  fitFeedbackEvalDocument,
} from "./feedback-eval.js";
import type { ReviewSample } from "./review.js";

const phrase = "请免费领取礼品";
const hash = "ab".repeat(32);

function sample(overrides: Partial<ReviewSample> = {}): ReviewSample {
  return {
    tenantId: "local",
    chatId: "-100",
    eventId: "evt_1",
    label: "confirmed",
    action: "delete",
    score: 1,
    reasons: ["keyword_match"],
    ruleIds: ["spam_keywords"],
    createdAt: "2026-11-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("buildFeedbackCase", () => {
  it("maps confirmed to spam and false_positive to ham", () => {
    expect(feedbackLabelFromReview("confirmed")).toBe("spam");
    expect(feedbackLabelFromReview("false_positive")).toBe("ham");
    const spam = buildFeedbackCase(sample({ textSha256: hash }));
    expect(spam).toEqual({
      id: "evt_1",
      chatId: "-100",
      label: "spam",
      textSha256: hash,
      action: "delete",
      score: 1,
      reasons: ["keyword_match"],
      ruleIds: ["spam_keywords"],
    });
    const ham = buildFeedbackCase(
      sample({
        eventId: "evt_2",
        label: "false_positive",
        action: "allow",
        score: 0,
        reasons: ["keyword"],
        ruleIds: ["spam_keywords"],
      }),
    );
    expect(ham.label).toBe("ham");
    expect(ham).not.toHaveProperty("textSha256");
    expect(ham).not.toHaveProperty("text");
    expect(JSON.stringify(ham)).not.toContain(phrase);
  });

  it("rejects a text field and a sentence stored as a feature", () => {
    expect(() =>
      feedbackCaseSchema.parse({
        ...buildFeedbackCase(sample()),
        text: phrase,
      }),
    ).toThrow();
    expect(() =>
      buildFeedbackCase({ ...sample(), text: phrase } as ReviewSample),
    ).toThrow();
    expect(() =>
      buildFeedbackCase({
        ...sample(),
        content: phrase,
      } as ReviewSample),
    ).toThrow();
  });
});

describe("feedbackEvalDocument", () => {
  it("keeps chat id on each case and omits message text", () => {
    const json = feedbackEvalDocument({ tenantId: "local" }, [
      sample({ textSha256: hash }),
      sample({
        chatId: "-200",
        eventId: "evt_2",
        label: "false_positive",
        createdAt: "2026-11-01T00:00:01.000Z",
      }),
    ]);
    expect(JSON.parse(json)).toEqual({
      tenantId: "local",
      cases: [
        {
          id: "evt_1",
          chatId: "-100",
          label: "spam",
          textSha256: hash,
          action: "delete",
          score: 1,
          reasons: ["keyword_match"],
          ruleIds: ["spam_keywords"],
        },
        {
          id: "evt_2",
          chatId: "-200",
          label: "ham",
          action: "delete",
          score: 1,
          reasons: ["keyword_match"],
          ruleIds: ["spam_keywords"],
        },
      ],
    });
    expect(json).not.toContain(phrase);
    expect(json).not.toContain('"text"');
    const scoped = JSON.parse(
      feedbackEvalDocument({ tenantId: "local", chatId: "-100" }, [sample()]),
    ) as { chatId?: string };
    expect(scoped.chatId).toBe("-100");
  });

  it("rejects a document larger than the review cap", () => {
    const samples = Array.from({ length: 257 }, (_, index) =>
      sample({ eventId: `evt_${index}` }),
    );
    expect(() =>
      feedbackEvalDocument({ tenantId: "local" }, samples),
    ).toThrow();
  });

  it("leaves a fitting document unchanged", () => {
    const scope = { tenantId: "local" };
    const samples = [sample()];
    expect(fitFeedbackEvalDocument(scope, samples, 3500)).toBe(
      feedbackEvalDocument(scope, samples),
    );
    expect(fitFeedbackEvalDocument(scope, [], 3500)).toBe(
      feedbackEvalDocument(scope, []),
    );
    expect(JSON.parse(feedbackEvalDocument(scope, [], 0))).toEqual({
      tenantId: "local",
      cases: [],
    });
    expect(() =>
      feedbackEvalDocumentSchema.parse({
        tenantId: "local",
        omitted: 0,
        cases: [],
      }),
    ).toThrow();
  });

  it("returns the newest cases that fit and counts the rest", () => {
    const scope = { tenantId: "local", chatId: "-100" };
    const samples = Array.from({ length: 40 }, (_, index) =>
      sample({
        eventId: `evt_${index}`,
        createdAt: `2026-11-01T00:00:00.${String(index).padStart(3, "0")}Z`,
      }),
    );
    const json = fitFeedbackEvalDocument(scope, samples, 3500);
    expect(json).not.toBeNull();
    if (json === null) {
      return;
    }
    expect(json.length).toBeLessThanOrEqual(3500);
    const doc = JSON.parse(json) as {
      omitted: number;
      cases: { id: string }[];
    };
    expect(doc.cases.at(-1)?.id).toBe("evt_39");
    expect(doc.cases[0]?.id).not.toBe("evt_0");
    expect(doc.omitted + doc.cases.length).toBe(40);
    const larger = feedbackEvalDocument(
      scope,
      samples.slice(samples.length - (doc.cases.length + 1)),
      doc.omitted - 1,
    );
    expect(larger.length).toBeGreaterThan(3500);
    expect(fitFeedbackEvalDocument(scope, [sample()], 8)).toBeNull();
  });
});
