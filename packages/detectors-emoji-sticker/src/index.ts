import { type Detector, defineDetector } from "@tasb/core";
import { z } from "zod";

export function createStickerEmojiDetector(): Detector {
  return defineDetector({
    id: "sticker_emoji",
    version: "0.1.0",
    capabilities: ["message"],
    configSchema: z.strictObject({}),
    config: {},
    async detect(ctx) {
      if (
        ctx.event.kind !== "message" ||
        ctx.event.message?.asStickerEmoji !== true
      ) {
        return null;
      }
      return {
        detectorId: "sticker_emoji",
        score: 1,
        reasons: ["sticker_emoji"],
        evidence: [{ kind: "feature", summary: "sticker:sticker_emoji" }],
      };
    },
  });
}
