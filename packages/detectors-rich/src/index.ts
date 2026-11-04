import { type Detector, defineDetector } from "@tasb/core";
import { z } from "zod";

export const richContacts = ["phone", "card", "email", "mention"] as const;
export type RichContact = (typeof richContacts)[number];

const richSpecs = {
  phone: { id: "rich_phone", summary: "rich:phone" },
  card: { id: "rich_card", summary: "rich:card" },
  email: { id: "rich_email", summary: "rich:email" },
  mention: { id: "rich_mention", summary: "rich:mention" },
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
            : kind === "email"
              ? message?.asRichEmail === true
              : message?.asRichMention === true;
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
