import { type Detector, defineDetector } from "@tasb/core";
import { z } from "zod";

export function createCustomEmojiDetector(): Detector {
  return defineDetector({
    id: "custom_emoji",
    version: "0.1.0",
    capabilities: ["message"],
    configSchema: z.strictObject({}),
    config: {},
    async detect(ctx) {
      if (
        ctx.event.kind !== "message" ||
        ctx.event.message?.asCustomEmoji !== true
      ) {
        return null;
      }
      return {
        detectorId: "custom_emoji",
        score: 1,
        reasons: ["custom_emoji"],
        evidence: [{ kind: "feature", summary: "entity:custom_emoji" }],
      };
    },
  });
}
