import { type Detector, defineDetector } from "@tasb/core";
import { z } from "zod";

export function createSwitchQueryDetector(): Detector {
  return defineDetector({
    id: "switch_query",
    version: "0.1.0",
    capabilities: ["message"],
    configSchema: z.strictObject({}),
    config: {},
    async detect(ctx) {
      if (
        ctx.event.kind !== "message" ||
        ctx.event.message?.asSwitchQuery !== true
      ) {
        return null;
      }
      return {
        detectorId: "switch_query",
        score: 1,
        reasons: ["switch_query"],
        evidence: [{ kind: "feature", summary: "button:switch_query" }],
      };
    },
  });
}
