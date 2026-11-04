import { type Detector, defineDetector } from "@tasb/core";
import { z } from "zod";

export function createChecklistDetector(): Detector {
  return defineDetector({
    id: "checklist_notice",
    version: "0.1.0",
    capabilities: ["message"],
    configSchema: z.strictObject({}),
    config: {},
    async detect(ctx) {
      const notice =
        ctx.event.kind === "message"
          ? ctx.event.message?.checklistNotice
          : undefined;
      if (notice !== "done" && notice !== "undone") {
        return null;
      }
      return {
        detectorId: "checklist_notice",
        score: 1,
        reasons: ["checklist_notice"],
        evidence: [{ kind: "feature", summary: `checklist:${notice}` }],
      };
    },
  });
}
