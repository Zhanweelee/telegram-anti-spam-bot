import { describe, expect, it } from "vitest";
import { parseEvent } from "./event.js";
import { aggregateScores, matchesWhen, parseRuleSet } from "./rule.js";

const event = parseEvent({
  id: "evt_1",
  tenantId: "tenant_1",
  chatId: "chat_1",
  kind: "message",
  occurredAt: "2026-11-01T00:00:00Z",
  actor: { id: "user_1", isAdmin: false },
});

function serviceEvent(
  message: Record<string, unknown>,
): ReturnType<typeof parseEvent> {
  return parseEvent({
    id: "evt_1",
    tenantId: "tenant_1",
    chatId: "chat_1",
    kind: "message",
    occurredAt: "2026-11-01T00:00:00Z",
    actor: { id: "user_1", isAdmin: false },
    message: {
      id: "1",
      text: "加微x",
      textSha256: "a".repeat(64),
      ...message,
    },
  });
}

describe("rules", () => {
  it("matches combinators", () => {
    expect(matchesWhen(undefined, event)).toBe(true);
    expect(matchesWhen({ eventKind: "message" }, event)).toBe(true);
    expect(matchesWhen({ eventKind: "command" }, event)).toBe(false);
    expect(
      matchesWhen(
        { all: [{ eventKind: "message" }, { eventKind: "command" }] },
        event,
      ),
    ).toBe(false);
    expect(matchesWhen({ all: [{ eventKind: "message" }] }, event)).toBe(true);
    expect(
      matchesWhen(
        { any: [{ eventKind: "command" }, { eventKind: "message" }] },
        event,
      ),
    ).toBe(true);
    expect(matchesWhen({ any: [{ eventKind: "command" }] }, event)).toBe(false);
    expect(matchesWhen({ not: { eventKind: "command" } }, event)).toBe(true);
    expect(matchesWhen({ serviceName: true }, event)).toBe(false);
    expect(
      matchesWhen({ serviceName: true }, serviceEvent({ notice: "join" })),
    ).toBe(true);
    expect(
      matchesWhen({ serviceName: true }, serviceEvent({ notice: "leave" })),
    ).toBe(false);
    expect(
      matchesWhen({ serviceName: true }, serviceEvent({ asCallInvite: true })),
    ).toBe(true);
    expect(
      matchesWhen(
        { serviceName: true },
        serviceEvent({ ownerNotice: "changed" }),
      ),
    ).toBe(true);
    expect(
      matchesWhen({ serviceName: true }, serviceEvent({ ownerNotice: "left" })),
    ).toBe(true);
    expect(
      matchesWhen({ serviceName: true }, serviceEvent({ asProximity: true })),
    ).toBe(true);
    expect(
      matchesWhen({ serviceName: true }, serviceEvent({ asChannel: true })),
    ).toBe(false);
    expect(matchesWhen({ senderTag: true }, event)).toBe(false);
    expect(
      matchesWhen({ senderTag: true }, serviceEvent({ notice: "join" })),
    ).toBe(false);
    expect(
      matchesWhen({ senderTag: true }, serviceEvent({ senderTag: "加微x" })),
    ).toBe(true);
    expect(
      matchesWhen({ serviceName: true }, serviceEvent({ senderTag: "加微x" })),
    ).toBe(false);
    expect(matchesWhen({ buttonText: true }, event)).toBe(false);
    expect(
      matchesWhen({ buttonText: true }, serviceEvent({ senderTag: "加微x" })),
    ).toBe(false);
    expect(
      matchesWhen({ buttonText: true }, serviceEvent({ buttonText: "加微x" })),
    ).toBe(true);
    expect(
      matchesWhen({ senderTag: true }, serviceEvent({ buttonText: "加微x" })),
    ).toBe(false);
    expect(matchesWhen({ authorSignature: true }, event)).toBe(false);
    expect(
      matchesWhen(
        { authorSignature: true },
        serviceEvent({ senderTag: "加微x" }),
      ),
    ).toBe(false);
    expect(
      matchesWhen(
        { authorSignature: true },
        serviceEvent({ buttonText: "加微x" }),
      ),
    ).toBe(false);
    expect(
      matchesWhen(
        { authorSignature: true },
        serviceEvent({ authorSignature: "加微x" }),
      ),
    ).toBe(true);
    expect(
      matchesWhen(
        { senderTag: true },
        serviceEvent({ authorSignature: "加微x" }),
      ),
    ).toBe(false);
    expect(
      matchesWhen(
        { buttonText: true },
        serviceEvent({ authorSignature: "加微x" }),
      ),
    ).toBe(false);
    expect(matchesWhen({ mirrorSignature: true }, event)).toBe(false);
    expect(
      matchesWhen(
        { mirrorSignature: true },
        serviceEvent({ authorSignature: "加微x" }),
      ),
    ).toBe(false);
    expect(
      matchesWhen(
        { mirrorSignature: true },
        serviceEvent({ mirrorSignature: "加微x" }),
      ),
    ).toBe(true);
    expect(
      matchesWhen(
        { authorSignature: true },
        serviceEvent({ mirrorSignature: "加微x" }),
      ),
    ).toBe(false);
    expect(matchesWhen({ pollOption: true }, event)).toBe(false);
    expect(
      matchesWhen(
        { pollOption: true },
        serviceEvent({ authorSignature: "加微x" }),
      ),
    ).toBe(false);
    expect(
      matchesWhen(
        { pollOption: true },
        serviceEvent({ mirrorSignature: "加微x" }),
      ),
    ).toBe(false);
    expect(
      matchesWhen({ pollOption: true }, serviceEvent({ pollOption: "加微x" })),
    ).toBe(true);
    expect(
      matchesWhen(
        { authorSignature: true },
        serviceEvent({ pollOption: "加微x" }),
      ),
    ).toBe(false);
    expect(
      matchesWhen(
        { mirrorSignature: true },
        serviceEvent({ pollOption: "加微x" }),
      ),
    ).toBe(false);
    expect(matchesWhen({ checklistTask: true }, event)).toBe(false);
    expect(
      matchesWhen(
        { checklistTask: true },
        serviceEvent({ pollOption: "加微x" }),
      ),
    ).toBe(false);
    expect(
      matchesWhen(
        { checklistTask: true },
        serviceEvent({ checklistTask: "加微x" }),
      ),
    ).toBe(true);
    expect(
      matchesWhen(
        { pollOption: true },
        serviceEvent({ checklistTask: "加微x" }),
      ),
    ).toBe(false);
    expect(matchesWhen({ mediaName: true }, event)).toBe(false);
    expect(
      matchesWhen(
        { mediaName: true },
        serviceEvent({ checklistTask: "加微x" }),
      ),
    ).toBe(false);
    expect(
      matchesWhen({ mediaName: true }, serviceEvent({ mediaName: "加微x" })),
    ).toBe(true);
    expect(
      matchesWhen(
        { checklistTask: true },
        serviceEvent({ mediaName: "加微x" }),
      ),
    ).toBe(false);
    expect(matchesWhen({ performer: true }, event)).toBe(false);
    expect(
      matchesWhen({ performer: true }, serviceEvent({ mediaName: "加微x" })),
    ).toBe(false);
    expect(
      matchesWhen({ performer: true }, serviceEvent({ performer: "加微x" })),
    ).toBe(true);
    expect(
      matchesWhen({ mediaName: true }, serviceEvent({ performer: "加微x" })),
    ).toBe(false);
    expect(matchesWhen({ gameText: true }, event)).toBe(false);
    expect(
      matchesWhen({ gameText: true }, serviceEvent({ gameText: "加微x" })),
    ).toBe(true);
    expect(
      matchesWhen({ invoiceText: true }, serviceEvent({ gameText: "加微x" })),
    ).toBe(false);
    expect(
      matchesWhen(
        { invoiceText: true },
        serviceEvent({ invoiceText: "加微x" }),
      ),
    ).toBe(true);
    expect(
      matchesWhen({ gameText: true }, serviceEvent({ invoiceText: "加微x" })),
    ).toBe(false);
    expect(matchesWhen({ venueAddress: true }, event)).toBe(false);
    expect(
      matchesWhen(
        { venueAddress: true },
        serviceEvent({ invoiceText: "加微x" }),
      ),
    ).toBe(false);
    expect(
      matchesWhen(
        { venueAddress: true },
        serviceEvent({ venueAddress: "加微x" }),
      ),
    ).toBe(true);
    expect(
      matchesWhen(
        { invoiceText: true },
        serviceEvent({ venueAddress: "加微x" }),
      ),
    ).toBe(false);
    expect(matchesWhen({ pollExplanation: true }, event)).toBe(false);
    expect(
      matchesWhen(
        { pollExplanation: true },
        serviceEvent({ venueAddress: "加微x" }),
      ),
    ).toBe(false);
    expect(
      matchesWhen(
        { pollExplanation: true },
        serviceEvent({ pollExplanation: "加微x" }),
      ),
    ).toBe(true);
    expect(
      matchesWhen(
        { venueAddress: true },
        serviceEvent({ pollExplanation: "加微x" }),
      ),
    ).toBe(false);
    expect(matchesWhen({ pollQuestion: true }, event)).toBe(false);
    expect(
      matchesWhen(
        { pollQuestion: true },
        serviceEvent({ pollExplanation: "加微x" }),
      ),
    ).toBe(false);
    expect(
      matchesWhen(
        { pollQuestion: true },
        serviceEvent({ pollQuestion: "加微x" }),
      ),
    ).toBe(true);
    expect(
      matchesWhen(
        { pollExplanation: true },
        serviceEvent({ pollQuestion: "加微x" }),
      ),
    ).toBe(false);
    expect(matchesWhen({ prizeText: true }, event)).toBe(false);
    expect(
      matchesWhen({ prizeText: true }, serviceEvent({ pollQuestion: "加微x" })),
    ).toBe(false);
    expect(
      matchesWhen({ prizeText: true }, serviceEvent({ prizeText: "加微x" })),
    ).toBe(true);
    expect(
      matchesWhen({ pollQuestion: true }, serviceEvent({ prizeText: "加微x" })),
    ).toBe(false);
    expect(matchesWhen({ checklistTitle: true }, event)).toBe(false);
    expect(
      matchesWhen(
        { checklistTitle: true },
        serviceEvent({ prizeText: "加微x" }),
      ),
    ).toBe(false);
    expect(
      matchesWhen(
        { checklistTitle: true },
        serviceEvent({ checklistTitle: "加微x" }),
      ),
    ).toBe(true);
    expect(
      matchesWhen(
        { prizeText: true },
        serviceEvent({ checklistTitle: "加微x" }),
      ),
    ).toBe(false);
    expect(matchesWhen({ gameTitle: true }, event)).toBe(false);
    expect(
      matchesWhen(
        { gameTitle: true },
        serviceEvent({ checklistTitle: "加微x" }),
      ),
    ).toBe(false);
    expect(
      matchesWhen({ gameTitle: true }, serviceEvent({ gameTitle: "加微x" })),
    ).toBe(true);
    expect(
      matchesWhen(
        { checklistTitle: true },
        serviceEvent({ gameTitle: "加微x" }),
      ),
    ).toBe(false);
    expect(matchesWhen({ invoiceTitle: true }, event)).toBe(false);
    expect(
      matchesWhen({ invoiceTitle: true }, serviceEvent({ gameTitle: "加微x" })),
    ).toBe(false);
    expect(
      matchesWhen(
        { invoiceTitle: true },
        serviceEvent({ invoiceTitle: "加微x" }),
      ),
    ).toBe(true);
    expect(
      matchesWhen({ gameTitle: true }, serviceEvent({ invoiceTitle: "加微x" })),
    ).toBe(false);
    expect(matchesWhen({ venueTitle: true }, event)).toBe(false);
    expect(
      matchesWhen(
        { venueTitle: true },
        serviceEvent({ invoiceTitle: "加微x" }),
      ),
    ).toBe(false);
    expect(
      matchesWhen({ venueTitle: true }, serviceEvent({ venueTitle: "加微x" })),
    ).toBe(true);
    expect(
      matchesWhen(
        { invoiceTitle: true },
        serviceEvent({ venueTitle: "加微x" }),
      ),
    ).toBe(false);
    expect(matchesWhen({ webAppButtonText: true }, event)).toBe(false);
    expect(
      matchesWhen(
        { webAppButtonText: true },
        serviceEvent({ venueTitle: "加微x" }),
      ),
    ).toBe(false);
    expect(
      matchesWhen(
        { webAppButtonText: true },
        serviceEvent({ webAppButtonText: "加微x" }),
      ),
    ).toBe(true);
    expect(
      matchesWhen(
        { venueTitle: true },
        serviceEvent({ webAppButtonText: "加微x" }),
      ),
    ).toBe(false);
    expect(matchesWhen({ quoteText: true }, event)).toBe(false);
    expect(
      matchesWhen(
        { quoteText: true },
        serviceEvent({ webAppButtonText: "加微x" }),
      ),
    ).toBe(false);
    expect(
      matchesWhen({ quoteText: true }, serviceEvent({ quoteText: "加微x" })),
    ).toBe(true);
    expect(
      matchesWhen(
        { webAppButtonText: true },
        serviceEvent({ quoteText: "加微x" }),
      ),
    ).toBe(false);
    expect(matchesWhen({ giftText: true }, event)).toBe(false);
    expect(
      matchesWhen({ giftText: true }, serviceEvent({ quoteText: "加微x" })),
    ).toBe(false);
    expect(
      matchesWhen({ giftText: true }, serviceEvent({ giftText: "加微x" })),
    ).toBe(true);
    expect(
      matchesWhen({ quoteText: true }, serviceEvent({ giftText: "加微x" })),
    ).toBe(false);
    expect(matchesWhen({ giftLabel: true }, event)).toBe(false);
    expect(
      matchesWhen({ giftLabel: true }, serviceEvent({ giftText: "加微x" })),
    ).toBe(false);
    expect(
      matchesWhen({ giftLabel: true }, serviceEvent({ giftLabel: "加微x" })),
    ).toBe(true);
    expect(
      matchesWhen({ giftText: true }, serviceEvent({ giftLabel: "加微x" })),
    ).toBe(false);
    expect(matchesWhen({ topicName: true }, event)).toBe(false);
    expect(
      matchesWhen({ topicName: true }, serviceEvent({ giftLabel: "加微x" })),
    ).toBe(false);
    expect(
      matchesWhen({ topicName: true }, serviceEvent({ topicName: "加微x" })),
    ).toBe(true);
    expect(
      matchesWhen({ giftLabel: true }, serviceEvent({ topicName: "加微x" })),
    ).toBe(false);
  });

  it("aggregates empty, max, and sum", () => {
    expect(aggregateScores("max", [])).toBe(0);
    expect(aggregateScores("sum", [])).toBe(0);
    expect(aggregateScores("max", [0.2, 0.9])).toBe(0.9);
    expect(aggregateScores("sum", [0.2, 0.9])).toBeCloseTo(1.1);
  });

  it("rejects duplicate rule ids and an uppercase hash", () => {
    expect(() =>
      parseRuleSet({
        version: 1,
        aggregate: "max",
        rules: [
          {
            id: "same",
            enabled: true,
            detectorIds: ["keyword"],
            threshold: 1,
            actions: ["log"],
          },
          {
            id: "same",
            enabled: true,
            detectorIds: ["keyword"],
            threshold: 1,
            actions: ["log"],
          },
        ],
      }),
    ).toThrow(/duplicate_rule_id/);
  });
});
