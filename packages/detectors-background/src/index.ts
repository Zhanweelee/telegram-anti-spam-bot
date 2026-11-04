import { type Detector, defineDetector } from "@tasb/core";
import { z } from "zod";

export function createBackgroundDetector(): Detector {
  return defineDetector({
    id: "chat_background",
    version: "0.1.0",
    capabilities: ["message"],
    configSchema: z.strictObject({}),
    config: {},
    async detect(ctx) {
      const background =
        ctx.event.kind === "message"
          ? ctx.event.message?.background
          : undefined;
      if (
        background !== "wallpaper" &&
        background !== "pattern" &&
        background !== "fill" &&
        background !== "theme"
      ) {
        return null;
      }
      return {
        detectorId: "chat_background",
        score: 1,
        reasons: ["chat_background"],
        evidence: [{ kind: "feature", summary: `background:${background}` }],
      };
    },
  });
}
