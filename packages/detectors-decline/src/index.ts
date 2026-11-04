import { type Detector, defineDetector } from "@tasb/core";
import { z } from "zod";

export function createDeclineDetector(): Detector {
  return defineDetector({
    id: "post_declined",
    version: "0.1.0",
    capabilities: ["message"],
    configSchema: z.strictObject({}),
    config: {},
    async detect(ctx) {
      if (
        ctx.event.kind !== "message" ||
        ctx.event.message?.asPostDeclined !== true
      ) {
        return null;
      }
      return {
        detectorId: "post_declined",
        score: 1,
        reasons: ["post_declined"],
        evidence: [{ kind: "feature", summary: "decline:post" }],
      };
    },
  });
}
