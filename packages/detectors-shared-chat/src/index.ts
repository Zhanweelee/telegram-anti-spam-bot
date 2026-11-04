import { type Detector, defineDetector } from "@tasb/core";
import { z } from "zod";

export function createSharedChatDetector(): Detector {
  return defineDetector({
    id: "shared_chat",
    version: "0.1.0",
    capabilities: ["message"],
    configSchema: z.strictObject({}),
    config: {},
    async detect(ctx) {
      if (
        ctx.event.kind !== "message" ||
        ctx.event.message?.asSharedChat !== true
      ) {
        return null;
      }
      return {
        detectorId: "shared_chat",
        score: 1,
        reasons: ["shared_chat"],
        evidence: [{ kind: "feature", summary: "chat:shared" }],
      };
    },
  });
}
