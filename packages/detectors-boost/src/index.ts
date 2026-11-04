import { type Detector, defineDetector } from "@tasb/core";
import { z } from "zod";

export function createBoostDetector(): Detector {
  return defineDetector({
    id: "chat_boost",
    version: "0.1.0",
    capabilities: ["message"],
    configSchema: z.strictObject({}),
    config: {},
    async detect(ctx) {
      if (ctx.event.kind !== "message" || ctx.event.message?.asBoost !== true) {
        return null;
      }
      return {
        detectorId: "chat_boost",
        score: 1,
        reasons: ["chat_boost"],
        evidence: [{ kind: "feature", summary: "boost:added" }],
      };
    },
  });
}
