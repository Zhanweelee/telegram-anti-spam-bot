import { type Detector, defineDetector } from "@tasb/core";
import { z } from "zod";

export function createAutoDeleteDetector(): Detector {
  return defineDetector({
    id: "autodelete_notice",
    version: "0.1.0",
    capabilities: ["message"],
    configSchema: z.strictObject({}),
    config: {},
    async detect(ctx) {
      if (
        ctx.event.kind !== "message" ||
        ctx.event.message?.asAutoDelete !== true
      ) {
        return null;
      }
      return {
        detectorId: "autodelete_notice",
        score: 1,
        reasons: ["autodelete_notice"],
        evidence: [{ kind: "feature", summary: "autodelete:changed" }],
      };
    },
  });
}
