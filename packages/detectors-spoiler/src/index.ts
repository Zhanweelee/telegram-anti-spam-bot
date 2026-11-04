import { type Detector, defineDetector } from "@tasb/core";
import { z } from "zod";

export function createSpoilerDetector(): Detector {
  return defineDetector({
    id: "media_spoiler",
    version: "0.1.0",
    capabilities: ["message"],
    configSchema: z.strictObject({}),
    config: {},
    async detect(ctx) {
      if (
        ctx.event.kind !== "message" ||
        ctx.event.message?.asSpoiler !== true
      ) {
        return null;
      }
      return {
        detectorId: "media_spoiler",
        score: 1,
        reasons: ["media_spoiler"],
        evidence: [{ kind: "feature", summary: "media:spoiler" }],
      };
    },
  });
}
