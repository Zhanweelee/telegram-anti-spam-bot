import { type Detector, defineDetector, type MediaKind } from "@tasb/core";
import { z } from "zod";

export const lockableMedia = [
  "sticker",
  "animation",
  "voice",
  "video_note",
  "dice",
] as const satisfies readonly MediaKind[];

export type LockableMedia = (typeof lockableMedia)[number];

export function createMediaDetector(kind: LockableMedia): Detector {
  const id = `media_${kind}`;
  return defineDetector({
    id,
    version: "0.1.0",
    capabilities: ["message"],
    configSchema: z.strictObject({}),
    config: {},
    async detect(ctx) {
      if (ctx.event.kind !== "message" || ctx.event.message?.media !== kind) {
        return null;
      }
      return {
        detectorId: id,
        score: 1,
        reasons: [id],
        evidence: [{ kind: "feature", summary: `media:${kind}` }],
      };
    },
  });
}
