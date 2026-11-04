import { type Detector, defineDetector } from "@tasb/core";
import { z } from "zod";

export function createTaskDetector(): Detector {
  return defineDetector({
    id: "checklist_added",
    version: "0.1.0",
    capabilities: ["message"],
    configSchema: z.strictObject({}),
    config: {},
    async detect(ctx) {
      if (
        ctx.event.kind !== "message" ||
        ctx.event.message?.asChecklistAdded !== true
      ) {
        return null;
      }
      return {
        detectorId: "checklist_added",
        score: 1,
        reasons: ["checklist_added"],
        evidence: [{ kind: "feature", summary: "checklist:added" }],
      };
    },
  });
}
