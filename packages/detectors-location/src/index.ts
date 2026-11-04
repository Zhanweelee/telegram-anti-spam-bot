import { type Detector, defineDetector } from "@tasb/core";
import { z } from "zod";

export function createLocationDetector(): Detector {
  return defineDetector({
    id: "bare_location",
    version: "0.1.0",
    capabilities: ["message"],
    configSchema: z.strictObject({}),
    config: {},
    async detect(ctx) {
      if (
        ctx.event.kind !== "message" ||
        ctx.event.message?.asLocation !== true
      ) {
        return null;
      }
      return {
        detectorId: "bare_location",
        score: 1,
        reasons: ["bare_location"],
        evidence: [{ kind: "feature", summary: "location:pin" }],
      };
    },
  });
}
