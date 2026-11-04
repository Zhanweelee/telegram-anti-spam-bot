import { type Event, parseEvent } from "@tasb/core";
import { describe, expect, it } from "vitest";
import { createRichDetector } from "./index.js";

function eventFor(input: {
  kind?: "message" | "chat_member";
  asRichPhone?: true;
  asRichCard?: true;
  asRichEmail?: true;
  asRichMention?: true;
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
});
