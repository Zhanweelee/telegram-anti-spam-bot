import { type Detector, defineDetector } from "@tasb/core";
import { z } from "zod";

export function createJoinDetector(): Detector {
  return defineDetector({
    id: "join",
    version: "0.1.0",
    capabilities: ["membership"],
    configSchema: z.strictObject({}),
    config: {},
    async detect(ctx) {
      if (ctx.event.membership !== "join") {
        return null;
      }
      return {
        detectorId: "join",
        score: 1,
        reasons: ["member_joined"],
        evidence: [{ kind: "feature", summary: "membership:join" }],
      };
    },
  });
}
