import { type Detector, defineDetector } from "@tasb/core";
import { z } from "zod";

export const richContacts = [
  "phone",
  "card",
  "email",
  "mention",
  "text_mention",
  "command",
  "hashtag",
  "cashtag",
  "anchor",
  "anchor_link",
  "reference",
  "reference_link",
] as const;
export type RichContact = (typeof richContacts)[number];

const richSpecs = {
  phone: { id: "rich_phone", summary: "rich:phone" },
  card: { id: "rich_card", summary: "rich:card" },
  email: { id: "rich_email", summary: "rich:email" },
  mention: { id: "rich_mention", summary: "rich:mention" },
  text_mention: { id: "rich_text_mention", summary: "rich:text_mention" },
  command: { id: "rich_command", summary: "rich:command" },
  hashtag: { id: "rich_hashtag", summary: "rich:hashtag" },
  cashtag: { id: "rich_cashtag", summary: "rich:cashtag" },
  anchor: { id: "rich_anchor", summary: "rich:anchor" },
  anchor_link: { id: "rich_anchor_link", summary: "rich:anchor_link" },
  reference: { id: "rich_reference", summary: "rich:reference" },
  reference_link: {
    id: "rich_reference_link",
    summary: "rich:reference_link",
  },
} as const;

const richMarks = {
  phone: "asRichPhone",
  card: "asRichCard",
  email: "asRichEmail",
  mention: "asRichMention",
  text_mention: "asRichTextMention",
  command: "asRichCommand",
  hashtag: "asRichHashtag",
  cashtag: "asRichCashtag",
  anchor: "asRichAnchor",
  anchor_link: "asRichAnchorLink",
  reference: "asRichReference",
  reference_link: "asRichReferenceLink",
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
      const marked = message?.[richMarks[kind]] === true;
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
