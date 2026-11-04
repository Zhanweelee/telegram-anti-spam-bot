import { type Detector, defineDetector } from "@tasb/core";
import { z } from "zod";

export function createTextMentionDetector(): Detector {
  return defineDetector({
    id: "text_mention",
    version: "0.1.0",
    capabilities: ["message"],
    configSchema: z.strictObject({}),
    config: {},
    async detect(ctx) {
      if (
        ctx.event.kind !== "message" ||
        ctx.event.message?.asTextMention !== true
      ) {
        return null;
      }
      return {
        detectorId: "text_mention",
        score: 1,
        reasons: ["text_mention"],
        evidence: [{ kind: "feature", summary: "entity:text_mention" }],
      };
    },
  });
}
