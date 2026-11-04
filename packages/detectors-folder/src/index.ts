import { type Detector, defineDetector } from "@tasb/core";
import { z } from "zod";

export function createFolderDetector(): Detector {
  return defineDetector({
    id: "folder",
    version: "0.1.0",
    capabilities: ["membership"],
    configSchema: z.strictObject({}),
    config: {},
    async detect(ctx) {
      if (ctx.event.kind !== "chat_member" || ctx.event.folderInvite !== true) {
        return null;
      }
      return {
        detectorId: "folder",
        score: 1,
        reasons: ["folder_joined"],
        evidence: [{ kind: "feature", summary: "folder:invite" }],
      };
    },
  });
}
