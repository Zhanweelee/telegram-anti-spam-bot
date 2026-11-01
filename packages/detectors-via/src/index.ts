import { type Detector, defineDetector } from "@tasb/core";
import { z } from "zod";

export function createViaDetector(): Detector {
  return defineDetector({
    id: "via",
    version: "0.1.0",
    capabilities: ["via"],
    configSchema: z.strictObject({}),
    config: {},
    async detect(ctx) {
      if (ctx.event.kind !== "message" || ctx.event.message?.via !== true) {
        return null;
      }
      return {
        detectorId: "via",
        score: 1,
        reasons: ["via_bot"],
        evidence: [{ kind: "feature", summary: "via:bot" }],
      };
    },
  });
}
