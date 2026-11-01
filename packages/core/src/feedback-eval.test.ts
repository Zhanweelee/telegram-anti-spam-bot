import { describe, expect, it } from "vitest";
import {
  buildFeedbackCase,
  feedbackCaseSchema,
  feedbackEvalDocument,
  feedbackLabelFromReview,
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
});
