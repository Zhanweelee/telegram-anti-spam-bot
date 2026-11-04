import { type Detector, defineDetector } from "@tasb/core";
import { z } from "zod";

export function createMapDetector(): Detector {
  return defineDetector({
    id: "rich_map",
    version: "0.1.0",
    capabilities: ["message"],
    configSchema: z.strictObject({}),
    config: {},
    async detect(ctx) {
      if (
        ctx.event.kind !== "message" ||
        ctx.event.message?.asRichMap !== true
      ) {
        return null;
      }
      return {
        detectorId: "rich_map",
        score: 1,
        reasons: ["rich_map"],
        evidence: [{ kind: "feature", summary: "map:rich" }],
      };
    },
  });
}

export function createLocationDetector(): Detector {
  return defineDetector({
    id: "bare_location",
    version: "0.1.0",
    capabilities: ["message"],
    configSchema: z.strictObject({}),
    config: {},
    async detect(ctx) {
      if (
        ctx.event.kind !== "message" ||
        ctx.event.message?.asLocation !== true
      ) {
        return null;
      }
      return {
        detectorId: "bare_location",
        score: 1,
        reasons: ["bare_location"],
        evidence: [{ kind: "feature", summary: "location:pin" }],
      };
    },
  });
}
