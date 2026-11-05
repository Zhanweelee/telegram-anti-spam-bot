import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Event, type Logger, parseEvent } from "@tasb/core";
import { describe, expect, it } from "vitest";
import { createKeywordDetector } from "./index.js";

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

describe("keyword detector", () => {
  const detector = createKeywordDetector({ keywords: ["免费领取", "加微信"] });

  it("matches fixtures", async () => {
    for (const fixture of fixtures) {
      const hit = await detector.detect({
        event: messageEvent(fixture.text),
        logger,
        signal,
      });
      expect(hit === null ? "miss" : "hit").toBe(fixture.expect);
    }
  });

  it("can be case sensitive and ignores events without text", async () => {
    const sensitive = createKeywordDetector({
      keywords: ["Spam"],
      caseSensitive: true,
    });
    expect(
      await sensitive.detect({ event: messageEvent("spam"), logger, signal }),
    ).toBeNull();
    expect(
      (await sensitive.detect({ event: messageEvent("Spam"), logger, signal }))
        ?.evidence[0]?.summary,
    ).toBe("keyword:Spam");
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

  it("folds fullwidth latin letters before matching", async () => {
    const vip = createKeywordDetector({ keywords: ["VIP"] });
    const hit = await vip.detect({
      event: messageEvent("\uFF56\uFF49\uFF50"),
      logger,
      signal,
    });
    expect(hit?.evidence[0]?.summary).toBe("keyword:VIP");
    const sensitive = createKeywordDetector({
      keywords: ["VIP"],
      caseSensitive: true,
    });
    expect(
      await sensitive.detect({
        event: messageEvent("\uFF56\uFF49\uFF50"),
        logger,
        signal,
      }),
    ).toBeNull();
    expect(
      (
        await sensitive.detect({
          event: messageEvent("\uFF36\uFF29\uFF30"),
          logger,
          signal,
        })
      )?.evidence[0]?.summary,
    ).toBe("keyword:VIP");
    expect(
      await detector.detect({
        event: messageEvent("免\uFF21费领取"),
        logger,
        signal,
      }),
    ).toBeNull();
  });

  it("folds seven cyrillic lookalikes before matching", async () => {
    const copy = createKeywordDetector({ keywords: ["copy"] });
    const hit = await copy.detect({
      event: messageEvent("\u0441\u043E\u0440\u0443"),
      logger,
      signal,
    });
    expect(hit?.evidence[0]?.summary).toBe("keyword:copy");
    const sensitive = createKeywordDetector({
      keywords: ["COPY"],
      caseSensitive: true,
    });
    expect(
      await sensitive.detect({
        event: messageEvent("\u0441\u043E\u0440\u0443"),
        logger,
        signal,
      }),
    ).toBeNull();
    expect(
      (
        await sensitive.detect({
          event: messageEvent("\u0421\u041E\u0420\u0423"),
          logger,
          signal,
        })
      )?.evidence[0]?.summary,
    ).toBe("keyword:COPY");
    expect(
      await detector.detect({
        event: messageEvent("привет"),
        logger,
        signal,
      }),
    ).toBeNull();
  });

  it("folds ukrainian i before matching", async () => {
    const vip = createKeywordDetector({ keywords: ["vip"] });
    const hit = await vip.detect({
      event: messageEvent("v\u0456p"),
      logger,
      signal,
    });
    expect(hit?.evidence[0]?.summary).toBe("keyword:vip");
    const sensitive = createKeywordDetector({
      keywords: ["VIP"],
      caseSensitive: true,
    });
    expect(
      await sensitive.detect({
        event: messageEvent("v\u0456p"),
        logger,
        signal,
      }),
    ).toBeNull();
    expect(
      (
        await sensitive.detect({
          event: messageEvent("V\u0406P"),
          logger,
          signal,
        })
      )?.evidence[0]?.summary,
    ).toBe("keyword:VIP");
    expect(
      await detector.detect({
        event: messageEvent("привіт"),
        logger,
        signal,
      }),
    ).toBeNull();
  });

  it("matches a join profile without copying the whole name", async () => {
    const name = "广告员免费领取礼品";
    const hit = await detector.detect({
      event: parseEvent({
        id: "evt_1",
        tenantId: "tenant_demo",
        chatId: "chat_demo",
        kind: "chat_member",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        membership: "join",
        profile: { text: name, textSha256: HASH },
      }),
      logger,
      signal,
    });
    expect(hit?.reasons).toEqual(["keyword_match"]);
    expect(hit?.evidence).toEqual([
      { kind: "keyword", summary: "keyword:免费领取" },
    ]);
    expect(JSON.stringify(hit)).not.toContain(name);
  });

  it("matches a sender tag without copying it", async () => {
    const tag = "请免费领取礼品";
    const hit = await detector.detect({
      event: parseEvent({
        id: "evt_1",
        tenantId: "tenant_demo",
        chatId: "chat_demo",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "今天站会",
          textSha256: HASH,
          senderTag: tag,
        },
      }),
      logger,
      signal,
    });
    expect(hit?.reasons).toEqual(["keyword_match"]);
    expect(hit?.evidence).toEqual([
      { kind: "keyword", summary: "keyword:免费领取" },
    ]);
    expect(JSON.stringify(hit)).not.toContain(tag);
  });

  it("matches button text without copying it", async () => {
    const label = "请免费领取礼品";
    const hit = await detector.detect({
      event: parseEvent({
        id: "evt_1",
        tenantId: "tenant_demo",
        chatId: "chat_demo",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "今天站会",
          textSha256: HASH,
          buttonText: label,
        },
      }),
      logger,
      signal,
    });
    expect(hit?.reasons).toEqual(["keyword_match"]);
    expect(hit?.evidence).toEqual([
      { kind: "keyword", summary: "keyword:免费领取" },
    ]);
    expect(JSON.stringify(hit)).not.toContain(label);
  });

  it("matches an author signature without copying it", async () => {
    const signature = "请免费领取礼品";
    const hit = await detector.detect({
      event: parseEvent({
        id: "evt_1",
        tenantId: "tenant_demo",
        chatId: "chat_demo",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "今天站会",
          textSha256: HASH,
          authorSignature: signature,
        },
      }),
      logger,
      signal,
    });
    expect(hit?.reasons).toEqual(["keyword_match"]);
    expect(hit?.evidence).toEqual([
      { kind: "keyword", summary: "keyword:免费领取" },
    ]);
    expect(JSON.stringify(hit)).not.toContain(signature);
  });

  it("matches poll option text without copying it", async () => {
    const label = "请免费领取礼品";
    const hit = await detector.detect({
      event: parseEvent({
        id: "evt_1",
        tenantId: "tenant_demo",
        chatId: "chat_demo",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00Z",
        actor: { id: "user_1", isAdmin: false },
        message: {
          id: "msg_1",
          text: "今天站会",
          textSha256: HASH,
          pollOption: label,
        },
      }),
      logger,
      signal,
    });
    expect(hit?.reasons).toEqual(["keyword_match"]);
    expect(hit?.evidence).toEqual([
      { kind: "keyword", summary: "keyword:免费领取" },
    ]);
    expect(JSON.stringify(hit)).not.toContain(label);
  });

  it("does not treat a variation-selector keyword as a match for every message", async () => {
    const detector = createKeywordDetector({ keywords: ["\uFE0F"] });
    const hit = await detector.detect({
      event: messageEvent("今天站会"),
      logger,
      signal,
    });
    expect(hit).toBeNull();
    const hidden = "免\uFE0F费领取";
    const matched = await detector.detect({
      event: messageEvent(hidden),
      logger,
      signal,
    });
    expect(matched).toBeNull();
    expect(JSON.stringify(matched)).not.toContain("\uFE0F");
  });

  it("does not treat a format-only keyword as a match for every message", async () => {
    const detector = createKeywordDetector({ keywords: ["\u200b"] });
    const hit = await detector.detect({
      event: messageEvent("今天站会"),
      logger,
      signal,
    });
    expect(hit).toBeNull();
    const hidden = "免\u200b费领取";
    const matched = await detector.detect({
      event: messageEvent(hidden),
      logger,
      signal,
    });
    expect(matched).toBeNull();
    expect(JSON.stringify(matched)).not.toContain("\u200b");
  });

  it("folds one encoded middle dot before matching", async () => {
    const hit = await detector.detect({
      event: messageEvent("加%C2%B7微信"),
      logger,
      signal,
    });
    expect(hit?.evidence[0]?.summary).toBe("keyword:加微信");
    expect(JSON.stringify(hit)).not.toContain("%C2%B7");
    const katakana = await detector.detect({
      event: messageEvent("加%E3%83%BB微信"),
      logger,
      signal,
    });
    expect(katakana?.evidence[0]?.summary).toBe("keyword:加微信");
    const armenian = createKeywordDetector({ keywords: ["bit"] });
    expect(
      await armenian.detect({
        event: messageEvent("b\u0561it"),
        logger,
        signal,
      }),
    ).toBeNull();
    expect(
      await detector.detect({
        event: messageEvent("不是免费。领取"),
        logger,
        signal,
      }),
    ).toBeNull();
    expect(
      await detector.detect({
        event: messageEvent("不是免费[.]领取"),
        logger,
        signal,
      }),
    ).toBeNull();
    expect(
      await detector.detect({
        event: messageEvent("不是免费%5B.%5D领取"),
        logger,
        signal,
      }),
    ).toBeNull();
    expect(
      await detector.detect({
        event: messageEvent("加%25C2%25B7微信"),
        logger,
        signal,
      }),
    ).toBeNull();
  });

  it("rejects an empty keyword list", () => {
    expect(() => createKeywordDetector({ keywords: [] })).toThrow();
  });
});
