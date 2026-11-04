import { type Detector, defineDetector } from "@tasb/core";
import { z } from "zod";

export function createCallDetector(): Detector {
  return defineDetector({
    id: "call_notice",
    version: "0.1.0",
    capabilities: ["message"],
    configSchema: z.strictObject({}),
    config: {},
    async detect(ctx) {
      const call =
        ctx.event.kind === "message" ? ctx.event.message?.call : undefined;
      if (call !== "started" && call !== "ended" && call !== "scheduled") {
        return null;
      }
      return {
        detectorId: "call_notice",
        score: 1,
        reasons: ["call_notice"],
        evidence: [{ kind: "feature", summary: `call:${call}` }],
      };
    },
  });
}
