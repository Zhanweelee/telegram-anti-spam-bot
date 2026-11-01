import { describe, expect, it } from "vitest";
import {
  createWorkersAiClassifier,
  FREE_PLAN_TEXT_MODEL,
  LlmUnavailableError,
  PAID_PLAN_MODELS,
} from "./ai.js";

const phrase = "请免费领取礼品";

describe("workers ai classifier", () => {
  it("uses the free text model and the highest score", async () => {
    const calls: string[] = [];
    const classifier = createWorkersAiClassifier({
      async run(model, input) {
        calls.push(`${model}:${input.text}`);
        return [
          { label: "POSITIVE", score: 0.2 },
          { label: "NEGATIVE", score: 0.8 },
        ];
      },
    });
    expect(await classifier.classify(phrase)).toEqual({
      label: "NEGATIVE",
      score: 0.8,
    });
    expect(calls).toEqual([`${FREE_PLAN_TEXT_MODEL}:${phrase}`]);
  });

  it("reads a wrapped result and drops the original error text", async () => {
    const classifier = createWorkersAiClassifier({
      async run() {
        return { result: [{ label: "NEGATIVE", score: 0.91 }] };
      },
    });
    expect(await classifier.classify("hello")).toEqual({
      label: "NEGATIVE",
      score: 0.91,
    });
    const failing = createWorkersAiClassifier({
      async run() {
        throw new Error(phrase);
      },
    });
    await expect(failing.classify("hello")).rejects.toBeInstanceOf(
      LlmUnavailableError,
    );
    await expect(failing.classify("hello")).rejects.toThrow("llm_unavailable");
  });

  it("does not call a model that requires a paid plan", async () => {
    let calls = 0;
    const classifier = createWorkersAiClassifier(
      {
        async run() {
          calls += 1;
          return [{ label: "NEGATIVE", score: 1 }];
        },
      },
      { model: PAID_PLAN_MODELS[0] },
    );
    await expect(classifier.classify(phrase)).rejects.toBeInstanceOf(
      LlmUnavailableError,
    );
    expect(calls).toBe(0);
  });

  it("rejects a payload that is not a label list", async () => {
    const classifier = createWorkersAiClassifier({
      async run() {
        return { text: phrase };
      },
    });
    await expect(classifier.classify("hello")).rejects.toBeInstanceOf(
      LlmUnavailableError,
    );
  });
});
