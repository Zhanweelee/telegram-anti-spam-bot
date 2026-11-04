import { type Detector, defineDetector } from "@tasb/core";
import { z } from "zod";

export function createPostDetector(): Detector {
  return defineDetector({
    id: "post_notice",
    version: "0.1.0",
    capabilities: ["message"],
    configSchema: z.strictObject({}),
    config: {},
    async detect(ctx) {
      const notice =
        ctx.event.kind === "message"
          ? ctx.event.message?.postNotice
          : undefined;
      if (
        notice !== "approved" &&
        notice !== "failed" &&
        notice !== "paid" &&
        notice !== "refunded"
      ) {
        return null;
      }
      return {
        detectorId: "post_notice",
        score: 1,
        reasons: ["post_notice"],
        evidence: [{ kind: "feature", summary: `post:${notice}` }],
      };
    },
  });
}
