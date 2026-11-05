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

export const keywordConfigSchema = z.strictObject({
  keywords: z.array(z.string().min(1)).min(1),
  caseSensitive: z.boolean().optional(),
});

export type KeywordConfig = z.input<typeof keywordConfigSchema>;

export function createKeywordDetector(config: KeywordConfig): Detector {
  return defineDetector({
    id: "keyword",
    version: "0.1.0",
    capabilities: ["text"],
    configSchema: keywordConfigSchema,
    config,
    async detect(ctx, parsed) {
      const texts = [
        ctx.event.message?.text,
        ctx.event.message?.senderTag,
        ctx.event.message?.buttonText,
        ctx.event.message?.authorSignature,
        ctx.event.message?.mirrorSignature,
        ctx.event.message?.pollOption,
        ctx.event.message?.checklistTask,
        ctx.event.message?.mediaName,
        ctx.event.message?.performer,
        ctx.event.message?.gameText,
        ctx.event.message?.invoiceText,
        ctx.event.message?.venueAddress,
        ctx.event.message?.pollExplanation,
        ctx.event.message?.pollQuestion,
        ctx.event.message?.prizeText,
        ctx.event.message?.checklistTitle,
        ctx.event.message?.gameTitle,
        ctx.event.message?.invoiceTitle,
        ctx.event.message?.venueTitle,
        ctx.event.message?.webAppButtonText,
        ctx.event.message?.quoteText,
        ctx.event.message?.giftText,
        ctx.event.message?.giftLabel,
        ctx.event.message?.topicName,
        ctx.event.message?.declineComment,
        ctx.event.message?.addedText,
        ctx.event.message?.hiddenName,
        ctx.event.message?.memberName,
        ctx.event.message?.sharedName,
        ctx.event.message?.managedName,
        ctx.event.message?.accessName,
        ctx.event.message?.gameFile,
        ctx.event.message?.audioFile,
        ctx.event.message?.paidFile,
        ctx.event.message?.richName,
        ctx.event.message?.pollMedia,
        ctx.event.message?.pollDescription,
        ctx.event.profile?.text,
      ].filter(
        (text): text is string => typeof text === "string" && text.length > 0,
      );
      if (texts.length === 0) {
        return null;
      }
      const caseSensitive = parsed.caseSensitive === true;
      const matched = parsed.keywords.filter((keyword) => {
        const needle = foldInterpuncts(
          foldEncodedMiddleDot(
            foldMatchText(
              foldFullwidthLatin(
                foldCyrillicLookalikes(
                  caseSensitive ? keyword : keyword.toLocaleLowerCase(),
                ),
              ),
            ),
          ),
        );
        if (needle.length === 0) {
          return false;
        }
        return texts.some((text) => {
          const haystack = foldInterpuncts(
            foldEncodedMiddleDot(
              foldMatchText(
                foldFullwidthLatin(
                  foldCyrillicLookalikes(
                    caseSensitive ? text : text.toLocaleLowerCase(),
                  ),
                ),
              ),
            ),
          );
          return haystack.includes(needle);
        });
      });
      if (matched.length === 0) {
        return null;
      }
      return {
        detectorId: "keyword",
        score: 1,
        reasons: ["keyword_match"],
        evidence: matched.map((keyword) => ({
          kind: "keyword" as const,
          summary: `keyword:${foldInterpuncts(foldEncodedMiddleDot(foldMatchText(foldFullwidthLatin(foldCyrillicLookalikes(keyword))))).slice(0, 80)}`,
        })),
      };
    },
  });
}
