import { type Detector, defineDetector } from "@tasb/core";
import { z } from "zod";

export function createPollDetector(): Detector {
  return defineDetector({
    id: "poll_notice",
    version: "0.1.0",
    capabilities: ["message"],
    configSchema: z.strictObject({}),
    config: {},
    async detect(ctx) {
      const notice =
        ctx.event.kind === "message"
          ? ctx.event.message?.pollNotice
          : undefined;
      if (notice !== "added" && notice !== "deleted") {
        return null;
      }
      return {
        detectorId: "poll_notice",
        score: 1,
        reasons: ["poll_notice"],
        evidence: [{ kind: "feature", summary: `poll:${notice}` }],
      };
    },
  });
}
