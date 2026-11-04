import { type Detector, defineDetector } from "@tasb/core";
import { z } from "zod";

export function createPhotoDetector(): Detector {
  return defineDetector({
    id: "chat_photo",
    version: "0.1.0",
    capabilities: ["message"],
    configSchema: z.strictObject({}),
    config: {},
    async detect(ctx) {
      const photo =
        ctx.event.kind === "message" ? ctx.event.message?.photo : undefined;
      if (photo !== "set" && photo !== "cleared") {
        return null;
      }
      return {
        detectorId: "chat_photo",
        score: 1,
        reasons: ["chat_photo"],
        evidence: [{ kind: "feature", summary: `photo:${photo}` }],
      };
    },
  });
}
