import { type Detector, defineDetector } from "@tasb/core";
import { z } from "zod";

export function createEffectDetector(): Detector {
  return defineDetector({
    id: "message_effect",
    version: "0.1.0",
    capabilities: ["message"],
    configSchema: z.strictObject({}),
    config: {},
    async detect(ctx) {
      if (
        ctx.event.kind !== "message" ||
        ctx.event.message?.asEffect !== true
      ) {
        return null;
      }
      return {
        detectorId: "message_effect",
        score: 1,
        reasons: ["message_effect"],
        evidence: [{ kind: "feature", summary: "effect:message" }],
      };
    },
  });
}
