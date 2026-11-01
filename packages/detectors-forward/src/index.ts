import {
  type Detector,
  defineDetector,
  type ForwardKind,
  forwardKinds,
} from "@tasb/core";
import { z } from "zod";

export const defaultForwardKinds = ["channel"] as const;

const kindSchema = z.enum(forwardKinds);

export const forwardConfigSchema = z.strictObject({
  kinds: z.array(kindSchema).min(1).max(forwardKinds.length),
});

export type ForwardConfig = z.input<typeof forwardConfigSchema>;

export function createForwardDetector(config: ForwardConfig): Detector {
  return defineDetector({
    id: "forward",
    version: "0.1.0",
    capabilities: ["forward"],
    configSchema: forwardConfigSchema,
    config,
    async detect(ctx, parsed) {
      const kind = ctx.event.message?.forward;
      if (kind === undefined || !parsed.kinds.includes(kind)) {
        return null;
      }
      return hit(kind);
    },
  });
}

function hit(kind: ForwardKind) {
  return {
    detectorId: "forward",
    score: 1,
    reasons: [`forward_${kind}`],
    evidence: [{ kind: "feature" as const, summary: `forward:${kind}` }],
  };
}
