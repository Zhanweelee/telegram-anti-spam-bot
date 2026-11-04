import { type Detector, defineDetector } from "@tasb/core";
import { z } from "zod";

export function createCommunityDetector(): Detector {
  return defineDetector({
    id: "community_notice",
    version: "0.1.0",
    capabilities: ["message"],
    configSchema: z.strictObject({}),
    config: {},
    async detect(ctx) {
      const community =
        ctx.event.kind === "message" ? ctx.event.message?.community : undefined;
      if (
        community !== "added" &&
        community !== "joined" &&
        community !== "removed"
      ) {
        return null;
      }
      return {
        detectorId: "community_notice",
        score: 1,
        reasons: ["community_notice"],
        evidence: [{ kind: "feature", summary: `community:${community}` }],
      };
    },
  });
}
