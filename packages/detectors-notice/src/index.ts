import { type Detector, defineDetector } from "@tasb/core";
import { z } from "zod";

export function createNoticeDetector(): Detector {
  return defineDetector({
    id: "notice",
    version: "0.1.0",
    capabilities: ["message"],
    configSchema: z.strictObject({}),
    config: {},
    async detect(ctx) {
      const notice =
        ctx.event.kind === "message" ? ctx.event.message?.notice : undefined;
      if (notice !== "join" && notice !== "leave") {
        return null;
      }
      return {
        detectorId: "notice",
        score: 1,
        reasons: ["service_notice"],
        evidence: [{ kind: "feature", summary: `notice:${notice}` }],
      };
    },
  });
}
