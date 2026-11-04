import { type Detector, defineDetector } from "@tasb/core";
import { z } from "zod";

export const richContacts = ["phone", "card"] as const;
export type RichContact = (typeof richContacts)[number];

export function createRichDetector(kind: RichContact): Detector {
  const id = kind === "phone" ? "rich_phone" : "rich_card";
  const summary = kind === "phone" ? "rich:phone" : "rich:card";
  return defineDetector({
    id,
    version: "0.1.0",
    capabilities: ["message"],
    configSchema: z.strictObject({}),
    config: {},
    async detect(ctx) {
      const marked =
        kind === "phone"
          ? ctx.event.message?.asRichPhone === true
          : ctx.event.message?.asRichCard === true;
      if (ctx.event.kind !== "message" || !marked) {
        return null;
      }
      return {
        detectorId: id,
        score: 1,
        reasons: [id],
        evidence: [{ kind: "feature", summary }],
      };
    },
  });
}
