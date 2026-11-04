import { type Detector, defineDetector } from "@tasb/core";
import { z } from "zod";

export function createGiveawayDetector(): Detector {
  return defineDetector({
    id: "giveaway_card",
    version: "0.1.0",
    capabilities: ["message"],
    configSchema: z.strictObject({}),
    config: {},
    async detect(ctx) {
      if (
        ctx.event.kind !== "message" ||
        ctx.event.message?.asGiveaway !== true
      ) {
        return null;
      }
      return {
        detectorId: "giveaway_card",
        score: 1,
        reasons: ["giveaway_card"],
        evidence: [{ kind: "feature", summary: "giveaway:card" }],
      };
    },
  });
}
