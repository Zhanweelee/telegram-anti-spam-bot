import { type Detector, defineDetector } from "@tasb/core";
import { z } from "zod";

export function createPinDetector(): Detector {
  return defineDetector({
    id: "pin_notice",
    version: "0.1.0",
    capabilities: ["message"],
    configSchema: z.strictObject({}),
    config: {},
    async detect(ctx) {
      if (ctx.event.kind !== "message" || ctx.event.message?.asPin !== true) {
        return null;
      }
      return {
        detectorId: "pin_notice",
        score: 1,
        reasons: ["pin_notice"],
        evidence: [{ kind: "feature", summary: "pin:notice" }],
      };
    },
  });
}
