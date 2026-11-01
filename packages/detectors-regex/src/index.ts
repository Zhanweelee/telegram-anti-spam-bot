import {
  type Detector,
  defineDetector,
  foldCyrillicLookalikes,
  foldEncodedMiddleDot,
  foldFullwidthLatin,
  foldInterpuncts,
  foldMatchText,
} from "@tasb/core";
import { z } from "zod";

export const defaultRegexPatterns = ["t\\.me/\\+", "加微[信xX]"] as const;

function isSafeRegex(source: string): boolean {
  if (source.length < 1 || source.length > 64) {
    return false;
  }
  if (/[+*]{2,}/.test(source)) {
    return false;
  }
  if (/\\[1-9pP]|\(\?/.test(source)) {
    return false;
  }
  if (/\([^)]*\)[+*?]/.test(source)) {
    return false;
  }
  if (/\([^)]*[+*{][^)]*\)/.test(source)) {
    return false;
  }
  return !source.includes("{");
}

function compiles(source: string): boolean {
  try {
    new RegExp(source, "u");
    return true;
  } catch {
    return false;
  }
}

const patternSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(isSafeRegex)
  .refine(compiles);

export const regexConfigSchema = z.strictObject({
  patterns: z.array(patternSchema).min(1).max(8),
});

export type RegexConfig = z.input<typeof regexConfigSchema>;

export function createRegexDetector(config: RegexConfig): Detector {
  const parsed = regexConfigSchema.parse(config);
  const compiled = parsed.patterns.map((source) => new RegExp(source, "u"));
  return defineDetector({
    id: "regex",
    version: "0.1.0",
    capabilities: ["text"],
    configSchema: regexConfigSchema,
    config: parsed,
    async detect(ctx) {
      const text = ctx.event.message?.text;
      if (text === undefined) {
        return null;
      }
      for (const expression of compiled) {
        let matched = false;
        try {
          matched = expression.test(
            foldInterpuncts(
              foldEncodedMiddleDot(
                foldMatchText(foldFullwidthLatin(foldCyrillicLookalikes(text))),
              ),
            ),
          );
        } catch {
          ctx.logger.warn("regex_failed", {
            detectorId: "regex",
            eventId: ctx.event.id,
            chatId: ctx.event.chatId,
            tenantId: ctx.event.tenantId,
          });
          return null;
        }
        if (!matched) {
          continue;
        }
        return {
          detectorId: "regex",
          score: 1,
          reasons: ["regex_match"],
          evidence: [{ kind: "feature" as const, summary: "regex:hit" }],
        };
      }
      return null;
    },
  });
}
