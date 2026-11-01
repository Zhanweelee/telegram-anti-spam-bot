import { type Detector, defineDetector } from "@tasb/core";
import { z } from "zod";

export function createBotDetector(): Detector {
  return defineDetector({
    id: "bot",
    version: "0.1.0",
    capabilities: ["membership"],
    configSchema: z.strictObject({}),
    config: {},
    async detect(ctx) {
      if (ctx.event.kind !== "chat_member" || ctx.event.actor.bot !== true) {
        return null;
      }
      return {
        detectorId: "bot",
        score: 1,
        reasons: ["bot_joined"],
        evidence: [{ kind: "feature", summary: "bot:join" }],
      };
    },
  });
}
