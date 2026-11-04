import { type Detector, defineDetector } from "@tasb/core";
import { z } from "zod";

export function createTopicDetector(): Detector {
  return defineDetector({
    id: "topic_notice",
    version: "0.1.0",
    capabilities: ["message"],
    configSchema: z.strictObject({}),
    config: {},
    async detect(ctx) {
      const notice =
        ctx.event.kind === "message"
          ? ctx.event.message?.topicNotice
          : undefined;
      if (notice !== "created" && notice !== "edited") {
        return null;
      }
      return {
        detectorId: "topic_notice",
        score: 1,
        reasons: ["topic_notice"],
        evidence: [{ kind: "feature", summary: `topic:${notice}` }],
      };
    },
  });
}
