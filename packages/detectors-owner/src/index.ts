import { type Detector, defineDetector } from "@tasb/core";
import { z } from "zod";

export function createOwnerDetector(): Detector {
  return defineDetector({
    id: "owner_notice",
    version: "0.1.0",
    capabilities: ["message"],
    configSchema: z.strictObject({}),
    config: {},
    async detect(ctx) {
      const notice =
        ctx.event.kind === "message"
          ? ctx.event.message?.ownerNotice
          : undefined;
      if (notice !== "changed" && notice !== "left") {
        return null;
      }
      return {
        detectorId: "owner_notice",
        score: 1,
        reasons: ["owner_notice"],
        evidence: [{ kind: "feature", summary: `owner:${notice}` }],
      };
    },
  });
}
