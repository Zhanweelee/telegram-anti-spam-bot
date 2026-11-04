import { type Detector, defineDetector } from "@tasb/core";
import { z } from "zod";

export function createGiftDetector(): Detector {
  return defineDetector({
    id: "gift_card",
    version: "0.1.0",
    capabilities: ["message"],
    configSchema: z.strictObject({}),
    config: {},
    async detect(ctx) {
      const gift =
        ctx.event.kind === "message" ? ctx.event.message?.gift : undefined;
      if (gift !== "card" && gift !== "unique" && gift !== "upgrade") {
        return null;
      }
      return {
        detectorId: "gift_card",
        score: 1,
        reasons: ["gift_card"],
        evidence: [{ kind: "feature", summary: `gift:${gift}` }],
      };
    },
  });
}
