import { type Detector, defineDetector } from "@tasb/core";
import { z } from "zod";

export function createGiveawayNoticeDetector(): Detector {
  return defineDetector({
    id: "giveaway_notice",
    version: "0.1.0",
    capabilities: ["message"],
    configSchema: z.strictObject({}),
    config: {},
    async detect(ctx) {
      const notice =
        ctx.event.kind === "message"
          ? ctx.event.message?.giveawayNotice
          : undefined;
      if (notice !== "created" && notice !== "completed") {
        return null;
      }
      return {
        detectorId: "giveaway_notice",
        score: 1,
        reasons: ["giveaway_notice"],
        evidence: [{ kind: "feature", summary: `giveaway:${notice}` }],
      };
    },
  });
}
