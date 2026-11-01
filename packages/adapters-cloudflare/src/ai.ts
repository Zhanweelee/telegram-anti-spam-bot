import type { LlmClassifier, LlmVerdict } from "@tasb/core";

/**
 * Text classification model that the Workers Free plan still serves.
 * Checked 2026-11-01 against the model catalog and the 2026-07-28 changelog.
 * Sentiment labels, not a spam-trained model. See ADR 0015.
 */
export const FREE_PLAN_TEXT_MODEL = "@cf/huggingface/distilbert-sst-2-int8";

/** Models the free plan rejects with HTTP 403 / internal 5035, as of 2026-11-01. */
export const PAID_PLAN_MODELS = [
  "@cf/moonshotai/kimi-k2.6",
  "@cf/moonshotai/kimi-k2.7-code",
  "@cf/zai-org/glm-5.2",
  "@cf/zai-org/glm-5.3",
  "@cf/zai-org/glm-5.3-flash",
  "@cf/deepseek-ai/deepseek-v4-flash-0731",
  "@cf/deepseek-ai/deepseek-v4-pro-0813",
] as const;

const textLimit = 512;

export class LlmUnavailableError extends Error {
  constructor() {
    super("llm_unavailable");
    this.name = "LlmUnavailableError";
  }
}

/** Narrow Workers AI surface. The worker binding satisfies it. */
export interface WorkersAiBinding {
  run(model: string, input: { readonly text: string }): Promise<unknown>;
}

export function createWorkersAiClassifier(
  ai: WorkersAiBinding,
  options?: { readonly model?: string },
): LlmClassifier {
  const model = options?.model ?? FREE_PLAN_TEXT_MODEL;
  return {
    async classify(text) {
      const clipped = text.slice(0, textLimit);
      if (clipped.length === 0 || isPaidModel(model)) {
        throw new LlmUnavailableError();
      }
      let raw: unknown;
      try {
        raw = await ai.run(model, { text: clipped });
      } catch {
        throw new LlmUnavailableError();
      }
      return topVerdict(raw);
    },
  };
}

function isPaidModel(model: string): boolean {
  return (PAID_PLAN_MODELS as readonly string[]).includes(model);
}

function topVerdict(value: unknown): LlmVerdict {
  const rows = readRows(value);
  const first = rows[0];
  if (!first) {
    throw new LlmUnavailableError();
  }
  let best = first;
  for (const row of rows) {
    if (row.score > best.score) {
      best = row;
    }
  }
  return best;
}

function readRows(value: unknown): LlmVerdict[] {
  const list = Array.isArray(value) ? value : readResult(value);
  const rows: LlmVerdict[] = [];
  for (const item of list) {
    const row = readRow(item);
    if (row) {
      rows.push(row);
    }
  }
  return rows;
}

function readResult(value: unknown): readonly unknown[] {
  if (!isRecord(value)) {
    return [];
  }
  const result = value.result;
  return Array.isArray(result) ? result : [];
}

function readRow(value: unknown): LlmVerdict | null {
  if (!isRecord(value)) {
    return null;
  }
  const label = value.label;
  const score = value.score;
  if (typeof label !== "string" || label.length === 0 || label.length > 64) {
    return null;
  }
  if (typeof score !== "number" || !Number.isFinite(score)) {
    return null;
  }
  if (score < 0 || score > 1) {
    return null;
  }
  return { label, score };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
