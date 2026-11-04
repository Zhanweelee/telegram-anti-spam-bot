import { type Detector, defineDetector } from "@tasb/core";
import { z } from "zod";

export function createCallInviteDetector(): Detector {
  return defineDetector({
    id: "call_invite",
    version: "0.1.0",
    capabilities: ["message"],
    configSchema: z.strictObject({}),
    config: {},
    async detect(ctx) {
      const invited =
        ctx.event.kind === "message" &&
        ctx.event.message?.asCallInvite === true;
      if (!invited) {
        return null;
      }
      return {
        detectorId: "call_invite",
        score: 1,
        reasons: ["call_invite"],
        evidence: [{ kind: "feature", summary: "invite:video" }],
      };
    },
  });
}
