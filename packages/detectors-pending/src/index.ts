import { type Detector, defineDetector } from "@tasb/core";
import { z } from "zod";

export function createPendingDetector(): Detector {
  return defineDetector({
    id: "post_pending",
    version: "0.1.0",
    capabilities: ["message"],
    configSchema: z.strictObject({}),
    config: {},
    async detect(ctx) {
      if (
        ctx.event.kind !== "message" ||
        ctx.event.message?.asPostPending !== true
      ) {
        return null;
      }
      return {
        detectorId: "post_pending",
        score: 1,
        reasons: ["post_pending"],
        evidence: [{ kind: "feature", summary: "post:pending" }],
      };
    },
  });
}
