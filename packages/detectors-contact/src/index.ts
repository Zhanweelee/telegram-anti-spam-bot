import { type Detector, defineDetector } from "@tasb/core";
import { z } from "zod";

export function createContactDetector(): Detector {
  return defineDetector({
    id: "contact",
    version: "0.1.0",
    capabilities: ["contact"],
    configSchema: z.strictObject({}),
    config: {},
    async detect(ctx) {
      if (ctx.event.kind !== "message" || ctx.event.message?.contact !== true) {
        return null;
      }
      return {
        detectorId: "contact",
        score: 1,
        reasons: ["contact_shared"],
        evidence: [{ kind: "feature", summary: "contact:card" }],
      };
    },
  });
}
