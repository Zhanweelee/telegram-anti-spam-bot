import { type Detector, defineDetector } from "@tasb/core";
import { z } from "zod";

export function createButtonEmojiDetector(): Detector {
  return defineDetector({
    id: "button_emoji",
    version: "0.1.0",
    capabilities: ["message"],
    configSchema: z.strictObject({}),
    config: {},
    async detect(ctx) {
      if (
        ctx.event.kind !== "message" ||
        ctx.event.message?.asButtonEmoji !== true
      ) {
        return null;
      }
      return {
        detectorId: "button_emoji",
        score: 1,
        reasons: ["button_emoji"],
        evidence: [{ kind: "feature", summary: "button:button_emoji" }],
      };
    },
  });
}
