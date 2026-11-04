import { type Detector, defineDetector } from "@tasb/core";
import { z } from "zod";

export function createProximityDetector(): Detector {
  return defineDetector({
    id: "proximity_notice",
    version: "0.1.0",
    capabilities: ["message"],
    configSchema: z.strictObject({}),
    config: {},
    async detect(ctx) {
      const near =
        ctx.event.kind === "message" && ctx.event.message?.asProximity === true;
      if (!near) {
        return null;
      }
      return {
        detectorId: "proximity_notice",
        score: 1,
        reasons: ["proximity_notice"],
        evidence: [{ kind: "feature", summary: "proximity:near" }],
      };
    },
  });
}
