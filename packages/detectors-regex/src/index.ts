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

function folded(text: string): string {
  return foldInterpuncts(
    foldEncodedMiddleDot(
      foldMatchText(foldFullwidthLatin(foldCyrillicLookalikes(text))),
    ),
  );
}

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
      const texts = [
        ctx.event.message?.text,
        ctx.event.message?.senderTag,
        ctx.event.message?.buttonText,
        ctx.event.profile?.text,
      ].filter(
        (text): text is string => typeof text === "string" && text.length > 0,
      );
      if (texts.length === 0) {
        return null;
      }
      for (const expression of compiled) {
        for (const text of texts) {
          let matched = false;
          try {
            matched = expression.test(folded(text));
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
      }
      return null;
    },
  });
}
