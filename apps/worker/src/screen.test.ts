import { createMemoryCache, createMemoryStorage } from "@tasb/adapter-memory";
import {
  createMemoryLogger,
  parseEvent,
  type RuleSource,
  type Storage,
} from "@tasb/core";
import { createKeywordDetector } from "@tasb/detector-keyword";
import { normalizeUpdate, sha256Hex } from "@tasb/platform-telegram";
import { describe, expect, it } from "vitest";
import { screenTelegramEvent } from "./screen.js";

async function event(text: string, isAdmin = false, chatId = "-100") {
  return parseEvent({
    id: "tg_1",
    tenantId: "local",
    chatId,
    kind: "message",
    occurredAt: "2026-11-01T00:00:00.000Z",
    actor: { id: "5", isAdmin },
    message: { id: "9", text, textSha256: await sha256Hex(text) },
  });
}

function countingStorage(): Storage & { reads: number } {
  const storage = createMemoryStorage();
  let reads = 0;
  return {
    get reads() {
      return reads;
    },
    appendAudit: (record) => storage.appendAudit(record),
    listAudits: (query) => storage.listAudits(query),
    async getRuleSet(tenantId, chatId) {
      reads += 1;
      return storage.getRuleSet(tenantId, chatId);
    },
    putRuleSet: (tenantId, chatId, rules) =>
      storage.putRuleSet(tenantId, chatId, rules),
  };
}

describe("screenTelegramEvent", () => {
  it("decides delete for a keyword without keeping the raw text in logs", async () => {
    const text = "请免费领取礼品";
    const logger = createMemoryLogger();
    const result = await screenTelegramEvent(await event(text), { logger });
    expect(result.decision.action).toBe("delete");
    expect(result.actionResults[0]?.status).toBe("executed");
    const logged = JSON.stringify(logger.entries);
    expect(logged).not.toContain(text);
    expect(logged).not.toContain('"text"');
  });

  it("allows ordinary text and empty text", async () => {
    const hello = await screenTelegramEvent(await event("hello"));
    expect(hello.decision.action).toBe("allow");
    expect(hello.actionResults).toEqual([]);

    const empty = await screenTelegramEvent(await event(""));
    expect(empty.decision.action).toBe("allow");
  });

  it("lets a join with no text through the pipeline", async () => {
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2001,
        chat_member: {
          chat: { id: -100123 },
          from: { id: 1, first_name: "Admin" },
          date: 1761955200,
          new_chat_member: {
            user: { id: 77, first_name: "Newbie" },
            status: "member",
          },
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    const detector = createKeywordDetector({ keywords: ["免费领取"] });
    const logger = createMemoryLogger();
    expect(
      await detector.detect({
        event: outcome.event,
        logger,
        signal: { aborted: false },
      }),
    ).toBeNull();
    const result = await screenTelegramEvent(outcome.event, { logger });
    expect(result.decision.action).toBe("allow");
    expect(result.detectorErrors).toEqual([]);
    expect(JSON.stringify(logger.entries)).not.toContain("Newbie");
  });

  it("uses a chat override from the rule file and does not read storage", async () => {
    const text = "请免费领取礼品";
    const storage = countingStorage();
    const cache = createMemoryCache();
    let loads = 0;
    const source: RuleSource = {
      async loadChat(_tenantId, chatId) {
        loads += 1;
        if (chatId === "-100777") {
          return {
            version: 1,
            aggregate: "max",
            rules: [
              {
                id: "spam_keywords",
                enabled: true,
                detectorIds: ["keyword"],
                threshold: 2,
                actions: ["delete"],
              },
            ],
          };
        }
        return null;
      },
      async loadDefault() {
        loads += 1;
        return {
          version: 1,
          aggregate: "max",
          rules: [
            {
              id: "spam_keywords",
              enabled: true,
              detectorIds: ["keyword"],
              threshold: 1,
              actions: ["delete"],
            },
          ],
        };
      },
    };
    const overridden = await screenTelegramEvent(
      await event(text, false, "-100777"),
      { cache, source, storage },
    );
    const again = await screenTelegramEvent(
      await event(text, false, "-100777"),
      { cache, source, storage },
    );
    expect(overridden.decision.action).toBe("allow");
    expect(again.decision.action).toBe("allow");
    expect(loads).toBe(1);
    expect(storage.reads).toBe(0);

    const fallback = await screenTelegramEvent(await event(text), {
      cache,
      source,
      storage,
    });
    expect(fallback.decision.action).toBe("delete");
    expect(storage.reads).toBe(0);
  });

  it("reads the bundled rule files", async () => {
    const text = "请免费领取礼品";
    const storage = countingStorage();
    const cache = createMemoryCache();
    const overridden = await screenTelegramEvent(
      await event(text, false, "-100777"),
      { storage, cache },
    );
    const fallback = await screenTelegramEvent(await event(text), {
      storage,
      cache,
    });
    expect(overridden.decision.action).toBe("allow");
    expect(fallback.decision.action).toBe("delete");
    expect(storage.reads).toBe(0);
  });

  it("fail-opens a chat when its rule document is invalid", async () => {
    const text = "请免费领取礼品";
    const phrase = "配置里不该出现的句子";
    const logger = createMemoryLogger();
    const result = await screenTelegramEvent(
      await event(text, false, "-100555"),
      {
        logger,
        cache: createMemoryCache(),
        source: {
          async loadChat() {
            return { version: 1, leak: phrase, text };
          },
          async loadDefault() {
            return { version: 1 };
          },
        },
      },
    );
    expect(result.decision.action).toBe("allow");
    const logged = JSON.stringify(logger.entries);
    expect(logged).toContain("rules_invalid");
    expect(logged).not.toContain(phrase);
    expect(logged).not.toContain(text);
  });

  it("exempts admins before the keyword detector", async () => {
    const result = await screenTelegramEvent(await event("免费领取", true));
    expect(result.outcome).toBe("exempt");
    expect(result.decision.action).toBe("allow");
  });
});
