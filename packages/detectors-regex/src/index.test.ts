import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Event, type Logger, parseEvent } from "@tasb/core";
import { describe, expect, it } from "vitest";
import { createRegexDetector, defaultRegexPatterns } from "./index.js";

const fixtures = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../fixtures/messages.json"),
    "utf8",
  ),
) as { text: string; expect: "hit" | "miss" }[];

const logger: Logger = { info() {}, warn() {}, error() {} };
const signal = new AbortController().signal;
const HASH = "b".repeat(64);

function messageEvent(text: string): Event {
  return parseEvent({
    id: "evt_1",
    tenantId: "tenant_demo",
    chatId: "chat_demo",
    kind: "message",
    occurredAt: "2026-11-01T00:00:00Z",
    actor: { id: "user_1", isAdmin: false },
    message: { id: "msg_1", text, textSha256: HASH },
  });
}

function profileEvent(text: string): Event {
  return parseEvent({
    id: "evt_1",
    tenantId: "tenant_demo",
    chatId: "chat_demo",
    kind: "chat_member",
    occurredAt: "2026-11-01T00:00:00Z",
    actor: { id: "user_1", isAdmin: false },
    profile: { text, textSha256: HASH },
  });
}

describe("regex detector", () => {
  const detector = createRegexDetector({
    patterns: [...defaultRegexPatterns],
  });

  it("matches fixtures without copying the text", async () => {
    for (const fixture of fixtures) {
      const hit = await detector.detect({
        event: messageEvent(fixture.text),
        logger,
        signal,
      });
      expect(hit === null ? "miss" : "hit").toBe(fixture.expect);
      if (fixture.expect === "hit" && fixture.text.length > 0) {
        expect(JSON.stringify(hit)).not.toContain(fixture.text);
        expect(hit?.evidence).toEqual([
          { kind: "feature", summary: "regex:hit" },
        ]);
        expect(hit?.reasons).toEqual(["regex_match"]);
      }
    }
  });

  it("ignores events without text", async () => {
    const member = parseEvent({
      id: "evt_1",
      tenantId: "tenant_demo",
      chatId: "chat_demo",
      kind: "chat_member",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
    });
    expect(await detector.detect({ event: member, logger, signal })).toBeNull();
  });

  it("matches a join name without copying it", async () => {
    const name = "加微x广告";
    const hit = await detector.detect({
      event: profileEvent(name),
      logger,
      signal,
    });
    expect(hit?.reasons).toEqual(["regex_match"]);
    expect(hit?.evidence).toEqual([{ kind: "feature", summary: "regex:hit" }]);
    expect(JSON.stringify(hit)).not.toContain(name);
    expect(
      await detector.detect({
        event: profileEvent("今天站会"),
        logger,
        signal,
      }),
    ).toBeNull();
    const both = parseEvent({
      ...messageEvent("今天站会"),
      profile: { text: name, textSha256: HASH },
    });
    const profileHit = await detector.detect({
      event: both,
      logger,
      signal,
    });
    expect(profileHit?.evidence).toEqual([
      { kind: "feature", summary: "regex:hit" },
    ]);
    expect(JSON.stringify(profileHit)).not.toContain(name);
    expect(JSON.stringify(profileHit)).not.toContain("今天站会");
    const tagged = parseEvent({
      ...messageEvent("今天站会"),
      message: {
        id: "msg_1",
        text: "今天站会",
        textSha256: HASH,
        senderTag: name,
      },
    });
    const tagHit = await detector.detect({
      event: tagged,
      logger,
      signal,
    });
    expect(tagHit?.evidence).toEqual([
      { kind: "feature", summary: "regex:hit" },
    ]);
    expect(JSON.stringify(tagHit)).not.toContain(name);
    const labeled = parseEvent({
      ...messageEvent("今天站会"),
      message: {
        id: "msg_1",
        text: "今天站会",
        textSha256: HASH,
        buttonText: `打开 ${name}`,
      },
    });
    const buttonHit = await detector.detect({
      event: labeled,
      logger,
      signal,
    });
    expect(buttonHit?.evidence).toEqual([
      { kind: "feature", summary: "regex:hit" },
    ]);
    expect(JSON.stringify(buttonHit)).not.toContain(name);
    const signed = parseEvent({
      ...messageEvent("今天站会"),
      message: {
        id: "msg_1",
        text: "今天站会",
        textSha256: HASH,
        authorSignature: `打开 ${name}`,
      },
    });
    const signatureHit = await detector.detect({
      event: signed,
      logger,
      signal,
    });
    expect(signatureHit?.evidence).toEqual([
      { kind: "feature", summary: "regex:hit" },
    ]);
    expect(signatureHit?.places).toEqual(["authorSignature"]);
    expect(JSON.stringify(signatureHit)).not.toContain(name);
    const bodyOnly = parseEvent({
      ...messageEvent(name),
      message: {
        id: "msg_1",
        text: name,
        textSha256: HASH,
        authorSignature: "你好",
      },
    });
    const bodyHit = await detector.detect({
      event: bodyOnly,
      logger,
      signal,
    });
    expect(bodyHit?.places).toEqual(["message"]);
    expect(JSON.stringify(bodyHit)).not.toContain("你好");
    const polled = parseEvent({
      ...messageEvent("今天站会"),
      message: {
        id: "msg_1",
        text: "今天站会",
        textSha256: HASH,
        pollOption: `打开 ${name}`,
      },
    });
    const pollHit = await detector.detect({
      event: polled,
      logger,
      signal,
    });
    expect(pollHit?.evidence).toEqual([
      { kind: "feature", summary: "regex:hit" },
    ]);
    expect(pollHit?.places).toEqual(["pollOption"]);
    expect(JSON.stringify(pollHit)).not.toContain(name);
    const pollBody = parseEvent({
      ...messageEvent(name),
      message: {
        id: "msg_1",
        text: name,
        textSha256: HASH,
        pollOption: "你好",
      },
    });
    const pollBodyHit = await detector.detect({
      event: pollBody,
      logger,
      signal,
    });
    expect(pollBodyHit?.places).toEqual(["message"]);
    expect(JSON.stringify(pollBodyHit)).not.toContain("你好");
    const tasked = parseEvent({
      ...messageEvent("今天站会"),
      message: {
        id: "msg_1",
        text: "今天站会",
        textSha256: HASH,
        checklistTask: `打开 ${name}`,
      },
    });
    const taskHit = await detector.detect({
      event: tasked,
      logger,
      signal,
    });
    expect(taskHit?.evidence).toEqual([
      { kind: "feature", summary: "regex:hit" },
    ]);
    expect(taskHit?.places).toEqual(["checklistTask"]);
    expect(JSON.stringify(taskHit)).not.toContain(name);
    const taskBody = parseEvent({
      ...messageEvent(name),
      message: {
        id: "msg_1",
        text: name,
        textSha256: HASH,
        checklistTask: "你好",
      },
    });
    const taskBodyHit = await detector.detect({
      event: taskBody,
      logger,
      signal,
    });
    expect(taskBodyHit?.places).toEqual(["message"]);
    expect(JSON.stringify(taskBodyHit)).not.toContain("你好");
    const named = parseEvent({
      ...messageEvent("今天站会"),
      message: {
        id: "msg_1",
        text: "今天站会",
        textSha256: HASH,
        mediaName: `打开 ${name}`,
      },
    });
    const nameHit = await detector.detect({
      event: named,
      logger,
      signal,
    });
    expect(nameHit?.evidence).toEqual([
      { kind: "feature", summary: "regex:hit" },
    ]);
    expect(nameHit?.places).toEqual(["mediaName"]);
    expect(JSON.stringify(nameHit)).not.toContain(name);
    const nameBody = parseEvent({
      ...messageEvent(name),
      message: {
        id: "msg_1",
        text: name,
        textSha256: HASH,
        mediaName: "你好",
      },
    });
    const nameBodyHit = await detector.detect({
      event: nameBody,
      logger,
      signal,
    });
    expect(nameBodyHit?.places).toEqual(["message"]);
    expect(JSON.stringify(nameBodyHit)).not.toContain("你好");
    const performed = parseEvent({
      ...messageEvent("今天站会"),
      message: {
        id: "msg_1",
        text: "今天站会",
        textSha256: HASH,
        performer: `打开 ${name}`,
      },
    });
    const performerHit = await detector.detect({
      event: performed,
      logger,
      signal,
    });
    expect(performerHit?.evidence).toEqual([
      { kind: "feature", summary: "regex:hit" },
    ]);
    expect(performerHit?.places).toEqual(["performer"]);
    expect(JSON.stringify(performerHit)).not.toContain(name);
    const performerBody = parseEvent({
      ...messageEvent(name),
      message: {
        id: "msg_1",
        text: name,
        textSha256: HASH,
        performer: "你好",
      },
    });
    const performerBodyHit = await detector.detect({
      event: performerBody,
      logger,
      signal,
    });
    expect(performerBodyHit?.places).toEqual(["message"]);
    expect(JSON.stringify(performerBodyHit)).not.toContain("你好");
    const played = parseEvent({
      ...messageEvent("今天站会"),
      message: {
        id: "msg_1",
        text: "今天站会",
        textSha256: HASH,
        gameText: `打开 ${name}`,
      },
    });
    const gameHit = await detector.detect({
      event: played,
      logger,
      signal,
    });
    expect(gameHit?.places).toEqual(["gameText"]);
    expect(JSON.stringify(gameHit)).not.toContain(name);
    const billed = parseEvent({
      ...messageEvent("今天站会"),
      message: {
        id: "msg_1",
        text: "今天站会",
        textSha256: HASH,
        invoiceText: `打开 ${name}`,
      },
    });
    const invoiceHit = await detector.detect({
      event: billed,
      logger,
      signal,
    });
    expect(invoiceHit?.places).toEqual(["invoiceText"]);
    expect(JSON.stringify(invoiceHit)).not.toContain(name);
    const placed = parseEvent({
      ...messageEvent("今天站会"),
      message: {
        id: "msg_1",
        text: "今天站会",
        textSha256: HASH,
        venueAddress: `打开 ${name}`,
      },
    });
    const venueHit = await detector.detect({
      event: placed,
      logger,
      signal,
    });
    expect(venueHit?.places).toEqual(["venueAddress"]);
    expect(JSON.stringify(venueHit)).not.toContain(name);
    const explained = parseEvent({
      ...messageEvent("今天站会"),
      message: {
        id: "msg_1",
        text: "今天站会",
        textSha256: HASH,
        pollExplanation: `打开 ${name}`,
      },
    });
    const explanationHit = await detector.detect({
      event: explained,
      logger,
      signal,
    });
    expect(explanationHit?.places).toEqual(["pollExplanation"]);
    expect(JSON.stringify(explanationHit)).not.toContain(name);
    const asked = parseEvent({
      ...messageEvent("今天站会"),
      message: {
        id: "msg_1",
        text: "今天站会",
        textSha256: HASH,
        pollQuestion: `打开 ${name}`,
      },
    });
    const questionHit = await detector.detect({
      event: asked,
      logger,
      signal,
    });
    expect(questionHit?.places).toEqual(["pollQuestion"]);
    expect(JSON.stringify(questionHit)).not.toContain(name);
    const prized = parseEvent({
      ...messageEvent("今天站会"),
      message: {
        id: "msg_1",
        text: "今天站会",
        textSha256: HASH,
        prizeText: `打开 ${name}`,
      },
    });
    const prizeHit = await detector.detect({
      event: prized,
      logger,
      signal,
    });
    expect(prizeHit?.places).toEqual(["prizeText"]);
    expect(JSON.stringify(prizeHit)).not.toContain(name);
    const titled = parseEvent({
      ...messageEvent("今天站会"),
      message: {
        id: "msg_1",
        text: "今天站会",
        textSha256: HASH,
        checklistTitle: `打开 ${name}`,
      },
    });
    const titleHit = await detector.detect({
      event: titled,
      logger,
      signal,
    });
    expect(titleHit?.places).toEqual(["checklistTitle"]);
    expect(JSON.stringify(titleHit)).not.toContain(name);
    const askedTitle = parseEvent({
      ...messageEvent("今天站会"),
      message: {
        id: "msg_1",
        text: "今天站会",
        textSha256: HASH,
        gameTitle: `打开 ${name}`,
      },
    });
    const gameTitleHit = await detector.detect({
      event: askedTitle,
      logger,
      signal,
    });
    expect(gameTitleHit?.places).toEqual(["gameTitle"]);
    expect(JSON.stringify(gameTitleHit)).not.toContain(name);
    const billedTitle = parseEvent({
      ...messageEvent("今天站会"),
      message: {
        id: "msg_1",
        text: "今天站会",
        textSha256: HASH,
        invoiceTitle: `打开 ${name}`,
      },
    });
    const invoiceTitleHit = await detector.detect({
      event: billedTitle,
      logger,
      signal,
    });
    expect(invoiceTitleHit?.places).toEqual(["invoiceTitle"]);
    expect(JSON.stringify(invoiceTitleHit)).not.toContain(name);
    const namedTitle = parseEvent({
      ...messageEvent("今天站会"),
      message: {
        id: "msg_1",
        text: "今天站会",
        textSha256: HASH,
        venueTitle: `打开 ${name}`,
      },
    });
    const venueTitleHit = await detector.detect({
      event: namedTitle,
      logger,
      signal,
    });
    expect(venueTitleHit?.places).toEqual(["venueTitle"]);
    expect(JSON.stringify(venueTitleHit)).not.toContain(name);
    const opened = parseEvent({
      ...messageEvent("今天站会"),
      message: {
        id: "msg_1",
        text: "今天站会",
        textSha256: HASH,
        webAppButtonText: `打开 ${name}`,
      },
    });
    const webAppHit = await detector.detect({
      event: opened,
      logger,
      signal,
    });
    expect(webAppHit?.places).toEqual(["webAppButtonText"]);
    expect(JSON.stringify(webAppHit)).not.toContain(name);
    const quoted = parseEvent({
      ...messageEvent("今天站会"),
      message: {
        id: "msg_1",
        text: "今天站会",
        textSha256: HASH,
        quoteText: `打开 ${name}`,
      },
    });
    const quoteHit = await detector.detect({
      event: quoted,
      logger,
      signal,
    });
    expect(quoteHit?.places).toEqual(["quoteText"]);
    expect(JSON.stringify(quoteHit)).not.toContain(name);
    const gifted = parseEvent({
      ...messageEvent("今天站会"),
      message: {
        id: "msg_1",
        text: "今天站会",
        textSha256: HASH,
        giftText: `打开 ${name}`,
      },
    });
    const giftHit = await detector.detect({
      event: gifted,
      logger,
      signal,
    });
    expect(giftHit?.places).toEqual(["giftText"]);
    expect(JSON.stringify(giftHit)).not.toContain(name);
    const collected = parseEvent({
      ...messageEvent("今天站会"),
      message: {
        id: "msg_1",
        text: "今天站会",
        textSha256: HASH,
        giftLabel: `打开 ${name}`,
      },
    });
    const labelHit = await detector.detect({
      event: collected,
      logger,
      signal,
    });
    expect(labelHit?.places).toEqual(["giftLabel"]);
    expect(JSON.stringify(labelHit)).not.toContain(name);
    const topiced = parseEvent({
      ...messageEvent("今天站会"),
      message: {
        id: "msg_1",
        text: "今天站会",
        textSha256: HASH,
        topicName: `打开 ${name}`,
      },
    });
    const topicHit = await detector.detect({
      event: topiced,
      logger,
      signal,
    });
    expect(topicHit?.places).toEqual(["topicName"]);
    expect(JSON.stringify(topicHit)).not.toContain(name);
    const commented = parseEvent({
      ...messageEvent("今天站会"),
      message: {
        id: "msg_1",
        text: "今天站会",
        textSha256: HASH,
        declineComment: `打开 ${name}`,
      },
    });
    const commentHit = await detector.detect({
      event: commented,
      logger,
      signal,
    });
    expect(commentHit?.places).toEqual(["declineComment"]);
    expect(JSON.stringify(commentHit)).not.toContain(name);
    const appended = parseEvent({
      ...messageEvent("今天站会"),
      message: {
        id: "msg_1",
        text: "今天站会",
        textSha256: HASH,
        addedText: `打开 ${name}`,
      },
    });
    const addedHit = await detector.detect({
      event: appended,
      logger,
      signal,
    });
    expect(addedHit?.places).toEqual(["addedText"]);
    expect(JSON.stringify(addedHit)).not.toContain(name);
    const concealed = parseEvent({
      ...messageEvent("今天站会"),
      message: {
        id: "msg_1",
        text: "今天站会",
        textSha256: HASH,
        hiddenName: `打开 ${name}`,
      },
    });
    const hiddenHit = await detector.detect({
      event: concealed,
      logger,
      signal,
    });
    expect(hiddenHit?.places).toEqual(["hiddenName"]);
    expect(JSON.stringify(hiddenHit)).not.toContain(name);
    const roster = parseEvent({
      ...messageEvent("今天站会"),
      message: {
        id: "msg_1",
        text: "今天站会",
        textSha256: HASH,
        memberName: `打开 ${name}`,
      },
    });
    const memberHit = await detector.detect({
      event: roster,
      logger,
      signal,
    });
    expect(memberHit?.places).toEqual(["memberName"]);
    expect(JSON.stringify(memberHit)).not.toContain(name);
    const shared = parseEvent({
      ...messageEvent("今天站会"),
      message: {
        id: "msg_1",
        text: "今天站会",
        textSha256: HASH,
        sharedName: `打开 ${name}`,
      },
    });
    const sharedHit = await detector.detect({
      event: shared,
      logger,
      signal,
    });
    expect(sharedHit?.places).toEqual(["sharedName"]);
    expect(JSON.stringify(sharedHit)).not.toContain(name);
    const gameBody = parseEvent({
      ...messageEvent(name),
      message: {
        id: "msg_1",
        text: name,
        textSha256: HASH,
        gameText: "说明",
        invoiceText: "商品说明",
      },
    });
    const gameBodyHit = await detector.detect({
      event: gameBody,
      logger,
      signal,
    });
    expect(gameBodyHit?.places).toEqual(["message"]);
    expect(JSON.stringify(gameBodyHit)).not.toContain("说明");
    expect(JSON.stringify(gameBodyHit)).not.toContain("商品说明");
  });

  it("accepts a short unquantified subset and rejects the rest", () => {
    expect(() =>
      createRegexDetector({
        patterns: ["https?://", "t\\.me/\\+", "加微[信xX]", "(a|b)"],
      }),
    ).not.toThrow();
    const unsafe = [
      "(a+)+",
      "(a*)*",
      "(?=a)",
      "\\1",
      "(",
      "a".repeat(65),
      "++",
      "a{2}",
    ];
    for (const pattern of unsafe) {
      expect(() => createRegexDetector({ patterns: [pattern] })).toThrow();
    }
    expect(() => createRegexDetector({ patterns: [] })).toThrow();
    expect(() =>
      createRegexDetector({
        patterns: Array.from({ length: 9 }, () => "a"),
      }),
    ).toThrow();
  });

  it("fails open when matching throws and does not log the text", async () => {
    const single = createRegexDetector({ patterns: ["a"] });
    const event = messageEvent("aaaa");
    const original = RegExp.prototype.test;
    const leak = "加微x secret";
    RegExp.prototype.test = () => {
      throw new Error(leak);
    };
    const warnings: { message: string; fields?: unknown }[] = [];
    try {
      const hit = await single.detect({
        event,
        logger: {
          info() {},
          error() {},
          warn(message, fields) {
            warnings.push({ message, fields });
          },
        },
        signal,
      });
      expect(hit).toBeNull();
    } finally {
      RegExp.prototype.test = original;
    }
    expect(warnings).toEqual([
      {
        message: "regex_failed",
        fields: {
          detectorId: "regex",
          eventId: "evt_1",
          chatId: "chat_demo",
          tenantId: "tenant_demo",
        },
      },
    ]);
    expect(JSON.stringify(warnings)).not.toContain(leak);
  });
});
