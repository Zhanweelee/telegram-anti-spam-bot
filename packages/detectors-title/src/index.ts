import { type Detector, defineDetector } from "@tasb/core";
import { z } from "zod";

export function createTitleDetector(): Detector {
  return defineDetector({
    id: "chat_title",
    version: "0.1.0",
    capabilities: ["message"],
    configSchema: z.strictObject({}),
    config: {},
    async detect(ctx) {
      if (ctx.event.kind !== "message" || ctx.event.message?.asTitle !== true) {
        return null;
      }
      return {
        detectorId: "chat_title",
        score: 1,
        reasons: ["chat_title"],
        evidence: [{ kind: "feature", summary: "title:rename" }],
      };
    },
  });
}
