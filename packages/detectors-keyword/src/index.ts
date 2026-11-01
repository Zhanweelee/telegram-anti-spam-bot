import { type Detector, defineDetector } from "@tasb/core";
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
      const text = ctx.event.message?.text;
      if (text === undefined) {
        return null;
      }
      const caseSensitive = parsed.caseSensitive === true;
      const haystack = caseSensitive ? text : text.toLocaleLowerCase();
      const matched = parsed.keywords.filter((keyword) => {
        const needle = caseSensitive ? keyword : keyword.toLocaleLowerCase();
        return haystack.includes(needle);
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
          summary: `keyword:${keyword.slice(0, 80)}`,
        })),
      };
    },
  });
}
