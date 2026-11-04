import { type Detector, defineDetector } from "@tasb/core";
import { z } from "zod";

export const richContacts = ["phone", "card", "email"] as const;
export type RichContact = (typeof richContacts)[number];

const richSpecs = {
  phone: { id: "rich_phone", summary: "rich:phone" },
  card: { id: "rich_card", summary: "rich:card" },
  email: { id: "rich_email", summary: "rich:email" },
} as const;

export function createRichDetector(kind: RichContact): Detector {
  const spec = richSpecs[kind];
  return defineDetector({
    id: spec.id,
    version: "0.1.0",
    capabilities: ["message"],
    configSchema: z.strictObject({}),
    config: {},
    async detect(ctx) {
      const message = ctx.event.message;
      const marked =
        kind === "phone"
          ? message?.asRichPhone === true
          : kind === "card"
            ? message?.asRichCard === true
            : message?.asRichEmail === true;
      if (ctx.event.kind !== "message" || !marked) {
        return null;
      }
      return {
        detectorId: spec.id,
        score: 1,
        reasons: [spec.id],
        evidence: [{ kind: "feature", summary: spec.summary }],
      };
    },
  });
}
