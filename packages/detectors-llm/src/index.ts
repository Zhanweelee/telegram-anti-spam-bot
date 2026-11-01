import {
  type Detector,
  type DetectorHit,
  defineDetector,
  type LlmClassifier,
  withTimeout,
} from "@tasb/core";
import { z } from "zod";

export const llmConfigSchema = z.strictObject({
  spamLabels: z.array(z.string().min(1).max(64)).min(1).max(8),
  threshold: z.number().min(0).max(1),
  timeoutMs: z.number().int().positive().max(1000),
});

export type LlmConfig = z.input<typeof llmConfigSchema>;

export interface LlmDetectorDeps {
  readonly classifier?: LlmClassifier;
  readonly spamLabels?: readonly string[];
  readonly threshold?: number;
  readonly timeoutMs?: number;
}

const textLimit = 512;

export function createLlmDetector(deps: LlmDetectorDeps = {}): Detector {
  return defineDetector({
    id: "llm",
    version: "0.1.0",
    capabilities: ["text"],
    configSchema: llmConfigSchema,
    config: {
      spamLabels: [...(deps.spamLabels ?? ["NEGATIVE"])],
      threshold: deps.threshold ?? 0.9,
      timeoutMs: deps.timeoutMs ?? 800,
    },
    async detect(ctx, parsed) {
      const text = ctx.event.message?.text?.slice(0, textLimit) ?? "";
      if (text.length === 0 || !deps.classifier) {
        return null;
      }
      try {
        const verdict = await withTimeout(
          deps.classifier.classify(text),
          parsed.timeoutMs,
        );
        if (
          verdict.score < parsed.threshold ||
          !parsed.spamLabels.includes(verdict.label)
        ) {
          return null;
        }
        return hit(verdict.label);
      } catch {
        ctx.logger.warn("llm_failed", {
          eventId: ctx.event.id,
          tenantId: ctx.event.tenantId,
          chatId: ctx.event.chatId,
          detectorId: "llm",
        });
        return null;
      }
    },
  });
}

function hit(label: string): DetectorHit {
  return {
    detectorId: "llm",
    score: 1,
    reasons: ["llm"],
    evidence: [{ kind: "feature", summary: `llm:${label}`.slice(0, 80) }],
  };
}
