import { type Event, parseEvent } from "@tasb/core";
import { describe, expect, it } from "vitest";
import { createRichDetector } from "./index.js";

function eventFor(input: {
  kind?: "message" | "chat_member";
  asRichPhone?: true;
  asRichCard?: true;
  asRichEmail?: true;
  asRichMention?: true;
  asRichTextMention?: true;
  asRichCommand?: true;
  asRichHashtag?: true;
  asRichCashtag?: true;
  asRichAnchor?: true;
  asRichAnchorLink?: true;
  asRichReference?: true;
}): Event {
  const kind = input.kind ?? "message";
  return parseEvent({
    id: "evt_rich_contact",
    tenantId: "tenant_demo",
    chatId: "chat_demo",
    kind,
    occurredAt: "2026-11-01T00:00:00.000Z",
    actor: { id: "user_1", isAdmin: false },
    ...(kind === "message"
      ? {
          message: {
            id: "msg_1",
            text: "",
            textSha256: "e".repeat(64),
            ...(input.asRichPhone ? { asRichPhone: true as const } : {}),
            ...(input.asRichCard ? { asRichCard: true as const } : {}),
            ...(input.asRichEmail ? { asRichEmail: true as const } : {}),
            ...(input.asRichMention ? { asRichMention: true as const } : {}),
            ...(input.asRichTextMention
              ? { asRichTextMention: true as const }
              : {}),
            ...(input.asRichCommand ? { asRichCommand: true as const } : {}),
            ...(input.asRichHashtag ? { asRichHashtag: true as const } : {}),
            ...(input.asRichCashtag ? { asRichCashtag: true as const } : {}),
            ...(input.asRichAnchor ? { asRichAnchor: true as const } : {}),
            ...(input.asRichAnchorLink
              ? { asRichAnchorLink: true as const }
              : {}),
            ...(input.asRichReference
              ? { asRichReference: true as const }
              : {}),
          },
        }
      : {}),
  });
}

describe("rich contact detector", () => {
  const phone = createRichDetector("phone");
  const card = createRichDetector("card");
  const logger = { info() {}, warn() {}, error() {} };
  const signal = { aborted: false };

  it("scores a rich phone and leaves the number out of the hit", async () => {
    const hit = await phone.detect({
      event: eventFor({ asRichPhone: true }),
      logger,
      signal,
    });
    expect(hit).toEqual({
      detectorId: "rich_phone",
      score: 1,
      reasons: ["rich_phone"],
      evidence: [{ kind: "feature", summary: "rich:phone" }],
    });
    expect(JSON.stringify(hit)).not.toContain("9021190011");
    expect(
      await phone.detect({ event: eventFor({}), logger, signal }),
    ).toBeNull();
    expect(
      await phone.detect({
        event: eventFor({ kind: "chat_member", asRichPhone: true }),
        logger,
        signal,
      }),
    ).toBeNull();
    expect(
      await phone.detect({
        event: eventFor({ asRichCard: true }),
        logger,
        signal,
      }),
    ).toBeNull();
  });

  it("scores a rich card and leaves the number out of the hit", async () => {
    const hit = await card.detect({
      event: eventFor({ asRichCard: true }),
      logger,
      signal,
    });
    expect(hit).toEqual({
      detectorId: "rich_card",
      score: 1,
      reasons: ["rich_card"],
      evidence: [{ kind: "feature", summary: "rich:card" }],
    });
    expect(JSON.stringify(hit)).not.toContain("9021190099990000");
    expect(
      await card.detect({
        event: eventFor({ asRichPhone: true }),
        logger,
        signal,
      }),
    ).toBeNull();
  });

  it("scores a rich email and leaves the address out of the hit", async () => {
    const email = createRichDetector("email");
    const hit = await email.detect({
      event: eventFor({ asRichEmail: true }),
      logger,
      signal,
    });
    expect(hit).toEqual({
      detectorId: "rich_email",
      score: 1,
      reasons: ["rich_email"],
      evidence: [{ kind: "feature", summary: "rich:email" }],
    });
    expect(JSON.stringify(hit)).not.toContain("902120011");
    expect(
      await email.detect({ event: eventFor({}), logger, signal }),
    ).toBeNull();
    expect(
      await email.detect({
        event: eventFor({ kind: "chat_member", asRichEmail: true }),
        logger,
        signal,
      }),
    ).toBeNull();
    expect(
      await email.detect({
        event: eventFor({ asRichPhone: true }),
        logger,
        signal,
      }),
    ).toBeNull();
    expect(
      await phone.detect({
        event: eventFor({ asRichEmail: true }),
        logger,
        signal,
      }),
    ).toBeNull();
  });

  it("scores a rich mention and leaves the username out of the hit", async () => {
    const mention = createRichDetector("mention");
    const hit = await mention.detect({
      event: eventFor({ asRichMention: true }),
      logger,
      signal,
    });
    expect(hit).toEqual({
      detectorId: "rich_mention",
      score: 1,
      reasons: ["rich_mention"],
      evidence: [{ kind: "feature", summary: "rich:mention" }],
    });
    expect(JSON.stringify(hit)).not.toContain("90221");
    expect(
      await mention.detect({ event: eventFor({}), logger, signal }),
    ).toBeNull();
    expect(
      await mention.detect({
        event: eventFor({ kind: "chat_member", asRichMention: true }),
        logger,
        signal,
      }),
    ).toBeNull();
    expect(
      await mention.detect({
        event: eventFor({ asRichEmail: true }),
        logger,
        signal,
      }),
    ).toBeNull();
    expect(
      await phone.detect({
        event: eventFor({ asRichMention: true }),
        logger,
        signal,
      }),
    ).toBeNull();
  });

  it("scores a rich text mention and leaves the user id out of the hit", async () => {
    const named = createRichDetector("text_mention");
    const hit = await named.detect({
      event: eventFor({ asRichTextMention: true }),
      logger,
      signal,
    });
    expect(hit).toEqual({
      detectorId: "rich_text_mention",
      score: 1,
      reasons: ["rich_text_mention"],
      evidence: [{ kind: "feature", summary: "rich:text_mention" }],
    });
    expect(JSON.stringify(hit)).not.toContain("902220011");
    expect(
      await named.detect({ event: eventFor({}), logger, signal }),
    ).toBeNull();
    expect(
      await named.detect({
        event: eventFor({ kind: "chat_member", asRichTextMention: true }),
        logger,
        signal,
      }),
    ).toBeNull();
    expect(
      await named.detect({
        event: eventFor({ asRichMention: true }),
        logger,
        signal,
      }),
    ).toBeNull();
    expect(
      await phone.detect({
        event: eventFor({ asRichTextMention: true }),
        logger,
        signal,
      }),
    ).toBeNull();
  });

  it("scores a rich command and leaves the command out of the hit", async () => {
    const command = createRichDetector("command");
    const hit = await command.detect({
      event: eventFor({ asRichCommand: true }),
      logger,
      signal,
    });
    expect(hit).toEqual({
      detectorId: "rich_command",
      score: 1,
      reasons: ["rich_command"],
      evidence: [{ kind: "feature", summary: "rich:command" }],
    });
    expect(JSON.stringify(hit)).not.toContain("90223");
    expect(
      await command.detect({ event: eventFor({}), logger, signal }),
    ).toBeNull();
    expect(
      await command.detect({
        event: eventFor({ kind: "chat_member", asRichCommand: true }),
        logger,
        signal,
      }),
    ).toBeNull();
    expect(
      await command.detect({
        event: eventFor({ asRichTextMention: true }),
        logger,
        signal,
      }),
    ).toBeNull();
    expect(
      await phone.detect({
        event: eventFor({ asRichCommand: true }),
        logger,
        signal,
      }),
    ).toBeNull();
  });

  it("scores a rich hashtag and leaves the tag out of the hit", async () => {
    const tag = createRichDetector("hashtag");
    const hit = await tag.detect({
      event: eventFor({ asRichHashtag: true }),
      logger,
      signal,
    });
    expect(hit).toEqual({
      detectorId: "rich_hashtag",
      score: 1,
      reasons: ["rich_hashtag"],
      evidence: [{ kind: "feature", summary: "rich:hashtag" }],
    });
    expect(JSON.stringify(hit)).not.toContain("90224");
    expect(
      await tag.detect({ event: eventFor({}), logger, signal }),
    ).toBeNull();
    expect(
      await tag.detect({
        event: eventFor({ kind: "chat_member", asRichHashtag: true }),
        logger,
        signal,
      }),
    ).toBeNull();
    expect(
      await tag.detect({
        event: eventFor({ asRichCommand: true }),
        logger,
        signal,
      }),
    ).toBeNull();
    expect(
      await phone.detect({
        event: eventFor({ asRichHashtag: true }),
        logger,
        signal,
      }),
    ).toBeNull();
  });

  it("scores a rich cashtag and leaves the ticker out of the hit", async () => {
    const cash = createRichDetector("cashtag");
    const hit = await cash.detect({
      event: eventFor({ asRichCashtag: true }),
      logger,
      signal,
    });
    expect(hit).toEqual({
      detectorId: "rich_cashtag",
      score: 1,
      reasons: ["rich_cashtag"],
      evidence: [{ kind: "feature", summary: "rich:cashtag" }],
    });
    expect(JSON.stringify(hit)).not.toContain("90226");
    expect(
      await cash.detect({ event: eventFor({}), logger, signal }),
    ).toBeNull();
    expect(
      await cash.detect({
        event: eventFor({ kind: "chat_member", asRichCashtag: true }),
        logger,
        signal,
      }),
    ).toBeNull();
    expect(
      await cash.detect({
        event: eventFor({ asRichHashtag: true }),
        logger,
        signal,
      }),
    ).toBeNull();
    expect(
      await phone.detect({
        event: eventFor({ asRichCashtag: true }),
        logger,
        signal,
      }),
    ).toBeNull();
  });

  it("scores a rich anchor and leaves the name out of the hit", async () => {
    const anchor = createRichDetector("anchor");
    const hit = await anchor.detect({
      event: eventFor({ asRichAnchor: true }),
      logger,
      signal,
    });
    expect(hit).toEqual({
      detectorId: "rich_anchor",
      score: 1,
      reasons: ["rich_anchor"],
      evidence: [{ kind: "feature", summary: "rich:anchor" }],
    });
    expect(JSON.stringify(hit)).not.toContain("90227");
    expect(
      await anchor.detect({ event: eventFor({}), logger, signal }),
    ).toBeNull();
    expect(
      await anchor.detect({
        event: eventFor({ kind: "chat_member", asRichAnchor: true }),
        logger,
        signal,
      }),
    ).toBeNull();
    expect(
      await anchor.detect({
        event: eventFor({ asRichCashtag: true }),
        logger,
        signal,
      }),
    ).toBeNull();
    expect(
      await phone.detect({
        event: eventFor({ asRichAnchor: true }),
        logger,
        signal,
      }),
    ).toBeNull();
  });

  it("scores a rich anchor link and leaves the name out of the hit", async () => {
    const link = createRichDetector("anchor_link");
    const hit = await link.detect({
      event: eventFor({ asRichAnchorLink: true }),
      logger,
      signal,
    });
    expect(hit).toEqual({
      detectorId: "rich_anchor_link",
      score: 1,
      reasons: ["rich_anchor_link"],
      evidence: [{ kind: "feature", summary: "rich:anchor_link" }],
    });
    expect(JSON.stringify(hit)).not.toContain("90229");
    expect(
      await link.detect({ event: eventFor({}), logger, signal }),
    ).toBeNull();
    expect(
      await link.detect({
        event: eventFor({ kind: "chat_member", asRichAnchorLink: true }),
        logger,
        signal,
      }),
    ).toBeNull();
    expect(
      await link.detect({
        event: eventFor({ asRichAnchor: true }),
        logger,
        signal,
      }),
    ).toBeNull();
    expect(
      await phone.detect({
        event: eventFor({ asRichAnchorLink: true }),
        logger,
        signal,
      }),
    ).toBeNull();
  });

  it("scores a rich reference and leaves the name out of the hit", async () => {
    const reference = createRichDetector("reference");
    const hit = await reference.detect({
      event: eventFor({ asRichReference: true }),
      logger,
      signal,
    });
    expect(hit).toEqual({
      detectorId: "rich_reference",
      score: 1,
      reasons: ["rich_reference"],
      evidence: [{ kind: "feature", summary: "rich:reference" }],
    });
    expect(JSON.stringify(hit)).not.toContain("90232");
    expect(
      await reference.detect({ event: eventFor({}), logger, signal }),
    ).toBeNull();
    expect(
      await reference.detect({
        event: eventFor({ kind: "chat_member", asRichReference: true }),
        logger,
        signal,
      }),
    ).toBeNull();
    expect(
      await reference.detect({
        event: eventFor({ asRichAnchorLink: true }),
        logger,
        signal,
      }),
    ).toBeNull();
    expect(
      await phone.detect({
        event: eventFor({ asRichReference: true }),
        logger,
        signal,
      }),
    ).toBeNull();
  });
});
