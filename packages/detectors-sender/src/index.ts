import { type Detector, defineDetector } from "@tasb/core";
import { z } from "zod";

export function createSenderDetector(): Detector {
  return defineDetector({
    id: "channel_sender",
    version: "0.1.0",
    capabilities: ["message"],
    configSchema: z.strictObject({}),
    config: {},
    async detect(ctx) {
      if (
        ctx.event.kind !== "message" ||
        ctx.event.message?.asChannel !== true
      ) {
        return null;
      }
      return {
        detectorId: "channel_sender",
        score: 1,
        reasons: ["channel_sender"],
        evidence: [{ kind: "feature", summary: "sender:channel" }],
      };
    },
  });
}
