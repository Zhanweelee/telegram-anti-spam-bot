import { type Detector, defineDetector } from "@tasb/core";
import { z } from "zod";

export function createForumDetector(): Detector {
  return defineDetector({
    id: "forum_notice",
    version: "0.1.0",
    capabilities: ["message"],
    configSchema: z.strictObject({}),
    config: {},
    async detect(ctx) {
      const notice =
        ctx.event.kind === "message"
          ? ctx.event.message?.forumNotice
          : undefined;
      if (
        notice !== "closed" &&
        notice !== "reopened" &&
        notice !== "hidden" &&
        notice !== "shown"
      ) {
        return null;
      }
      return {
        detectorId: "forum_notice",
        score: 1,
        reasons: ["forum_notice"],
        evidence: [{ kind: "feature", summary: `forum:${notice}` }],
      };
    },
  });
}
