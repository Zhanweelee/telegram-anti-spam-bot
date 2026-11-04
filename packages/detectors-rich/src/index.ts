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
