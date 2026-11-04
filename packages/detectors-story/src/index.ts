import { type Detector, defineDetector } from "@tasb/core";
import { z } from "zod";

export function createStoryDetector(): Detector {
  return defineDetector({
    id: "shared_story",
    version: "0.1.0",
    capabilities: ["message"],
    configSchema: z.strictObject({}),
    config: {},
    async detect(ctx) {
      if (ctx.event.kind !== "message" || ctx.event.message?.asStory !== true) {
        return null;
      }
      return {
        detectorId: "shared_story",
        score: 1,
        reasons: ["shared_story"],
        evidence: [{ kind: "feature", summary: "story:card" }],
      };
    },
  });
}
