import { type Detector, defineDetector } from "@tasb/core";
import { z } from "zod";

export function createPriceDetector(): Detector {
  return defineDetector({
    id: "price_notice",
    version: "0.1.0",
    capabilities: ["message"],
    configSchema: z.strictObject({}),
    config: {},
    async detect(ctx) {
      const notice =
        ctx.event.kind === "message"
          ? ctx.event.message?.priceNotice
          : undefined;
      if (notice !== "paid" && notice !== "direct") {
        return null;
      }
      return {
        detectorId: "price_notice",
        score: 1,
        reasons: ["price_notice"],
        evidence: [{ kind: "feature", summary: `price:${notice}` }],
      };
    },
  });
}
