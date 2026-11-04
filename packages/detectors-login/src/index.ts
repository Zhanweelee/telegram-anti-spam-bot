import { type Detector, defineDetector } from "@tasb/core";
import { z } from "zod";

export function createLoginForwardDetector(): Detector {
  return defineDetector({
    id: "login_forward",
    version: "0.1.0",
    capabilities: ["message"],
    configSchema: z.strictObject({}),
    config: {},
    async detect(ctx) {
      if (
        ctx.event.kind !== "message" ||
        ctx.event.message?.asLoginForward !== true
      ) {
        return null;
      }
      return {
        detectorId: "login_forward",
        score: 1,
        reasons: ["login_forward"],
        evidence: [{ kind: "feature", summary: "button:login_forward" }],
      };
    },
  });
}
