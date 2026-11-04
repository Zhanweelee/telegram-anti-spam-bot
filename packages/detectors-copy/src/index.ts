import { type Detector, defineDetector } from "@tasb/core";
import { z } from "zod";

export function createCopyTextDetector(): Detector {
  return defineDetector({
    id: "copy_text",
    version: "0.1.0",
    capabilities: ["message"],
    configSchema: z.strictObject({}),
    config: {},
    async detect(ctx) {
      if (
        ctx.event.kind !== "message" ||
        ctx.event.message?.asCopyText !== true
      ) {
        return null;
      }
      return {
        detectorId: "copy_text",
        score: 1,
        reasons: ["copy_text"],
        evidence: [{ kind: "feature", summary: "button:copy_text" }],
      };
    },
  });
}
