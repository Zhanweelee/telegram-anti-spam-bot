import { type Detector, defineDetector } from "@tasb/core";
import { z } from "zod";

export function createCreatedDetector(): Detector {
  return defineDetector({
    id: "group_created",
    version: "0.1.0",
    capabilities: ["message"],
    configSchema: z.strictObject({}),
    config: {},
    async detect(ctx) {
      if (
        ctx.event.kind !== "message" ||
        ctx.event.message?.asGroupCreated !== true
      ) {
        return null;
      }
      return {
        detectorId: "group_created",
        score: 1,
        reasons: ["group_created"],
        evidence: [{ kind: "feature", summary: "group:created" }],
      };
    },
  });
}
