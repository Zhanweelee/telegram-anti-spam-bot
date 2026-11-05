import {
  type Detector,
  defineDetector,
  foldCyrillicLookalikes,
  foldEncodedMiddleDot,
  foldFullwidthLatin,
  foldInterpuncts,
  foldMatchText,
  type TextPlace,
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
      const slots: readonly (readonly [TextPlace, string | undefined])[] = [
        ["message", ctx.event.message?.text],
        ["senderTag", ctx.event.message?.senderTag],
        ["buttonText", ctx.event.message?.buttonText],
        ["authorSignature", ctx.event.message?.authorSignature],
        ["mirrorSignature", ctx.event.message?.mirrorSignature],
        ["pollOption", ctx.event.message?.pollOption],
        ["checklistTask", ctx.event.message?.checklistTask],
        ["mediaName", ctx.event.message?.mediaName],
        ["performer", ctx.event.message?.performer],
        ["gameText", ctx.event.message?.gameText],
        ["invoiceText", ctx.event.message?.invoiceText],
        ["venueAddress", ctx.event.message?.venueAddress],
        ["pollExplanation", ctx.event.message?.pollExplanation],
        ["pollQuestion", ctx.event.message?.pollQuestion],
        ["prizeText", ctx.event.message?.prizeText],
        ["checklistTitle", ctx.event.message?.checklistTitle],
        ["gameTitle", ctx.event.message?.gameTitle],
        ["invoiceTitle", ctx.event.message?.invoiceTitle],
        ["venueTitle", ctx.event.message?.venueTitle],
        ["webAppButtonText", ctx.event.message?.webAppButtonText],
        ["quoteText", ctx.event.message?.quoteText],
        ["giftText", ctx.event.message?.giftText],
        ["profile", ctx.event.profile?.text],
      ];
      const places: TextPlace[] = [];
      let sawText = false;
      for (const expression of compiled) {
        for (const [place, text] of slots) {
          if (typeof text !== "string" || text.length === 0) {
            continue;
          }
          sawText = true;
          if (places.includes(place)) {
            continue;
          }
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
          if (matched) {
            places.push(place);
          }
        }
      }
      if (!sawText || places.length === 0) {
        return null;
      }
      return {
        detectorId: "regex",
        score: 1,
        reasons: ["regex_match"],
        evidence: [{ kind: "feature" as const, summary: "regex:hit" }],
        places,
      };
    },
  });
}
