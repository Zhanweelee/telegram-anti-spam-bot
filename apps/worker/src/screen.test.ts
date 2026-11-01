import { sha256HexUtf8 } from "@tasb/adapter-cloudflare";
import {
  createMemoryBlocklistStore,
  createMemoryCache,
  createMemoryCaptchaStore,
  createMemoryModerator,
  createMemoryPolicyStore,
  createMemoryRulePackArchive,
  createMemoryRuleSubscriptionStore,
  createMemoryRuntimeStore,
  createMemoryStorage,
} from "@tasb/adapter-memory";
import {
  type BlocklistStore,
  canonicalPluginPayload,
  createMemoryLogger,
  type Detector,
  type LlmClassifier,
  type Notifier,
  parseEvent,
  type RuleSource,
  type Storage,
} from "@tasb/core";
import { createKeywordDetector } from "@tasb/detector-keyword";
import { createMemoryRateWindow } from "@tasb/detector-rate";
import { normalizeUpdate, sha256Hex } from "@tasb/platform-telegram";
import { describe, expect, it } from "vitest";
import { filePackSource } from "./rules.js";
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
    getAudit: (tenantId, chatId, eventId) =>
      storage.getAudit(tenantId, chatId, eventId),
    exportAudits: (scope) => storage.exportAudits(scope),
    deleteAudits: (scope) => storage.deleteAudits(scope),
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

  it("runs mute and ban from chat rules without deleting", async () => {
    const text = "请免费领取礼品";
    const cache = createMemoryCache();
    const mute = await screenTelegramEvent(await event(text), {
      cache,
      source: {
        async loadChat() {
          return null;
        },
        async loadDefault() {
          return {
            version: 1,
            aggregate: "max",
            rules: [
              {
                id: "quiet",
                enabled: true,
                detectorIds: ["keyword"],
                threshold: 1,
                actions: ["mute"],
              },
            ],
          };
        },
      },
    });
    expect(mute.decision.action).toBe("mute");
    expect(mute.actionResults).toEqual([
      { actionId: "mute", status: "executed" },
    ]);

    const ban = await screenTelegramEvent(await event(text, false, "-1009"), {
      cache: createMemoryCache(),
      source: {
        async loadChat() {
          return null;
        },
        async loadDefault() {
          return {
            version: 1,
            aggregate: "max",
            rules: [
              {
                id: "drop",
                enabled: true,
                detectorIds: ["keyword"],
                threshold: 1,
                actions: ["ban", "delete"],
              },
            ],
          };
        },
      },
    });
    expect(ban.decision.action).toBe("ban");
    expect(ban.actionResults.map((item) => item.status)).toEqual([
      "executed",
      "executed",
    ]);
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
    const moderator = createMemoryModerator();
    const captchaStore = createMemoryCaptchaStore();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
      captchaStore,
      createNonce: () => "0123456789abcdef",
    });
    expect(result.decision.action).toBe("captcha");
    expect(result.detectorErrors).toEqual([]);
    expect(moderator.restricted).toHaveLength(1);
    expect(moderator.released).toEqual([]);
    expect(await captchaStore.get("local", "-100123", "77")).not.toBeNull();
    expect(JSON.stringify(result.actionResults)).not.toContain(
      "0123456789abcdef",
    );
    expect(JSON.stringify(logger.entries)).not.toContain("Newbie");
    expect(JSON.stringify(logger.entries)).not.toContain("0123456789abcdef");
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

  it("deletes an admin message when that chat turns exemption off", async () => {
    const text = "请免费领取礼品";
    const policyStore = createMemoryPolicyStore();
    await policyStore.put("local", "-100", {
      exemptAdmins: false,
      allowActorIds: [],
    });
    const logger = createMemoryLogger();
    const result = await screenTelegramEvent(await event(text, true), {
      logger,
      cache: createMemoryCache(),
      policyStore,
    });
    expect(result.outcome).toBe("decided");
    expect(result.decision.action).toBe("delete");
    expect(JSON.stringify(logger.entries)).not.toContain(text);
  });

  it("allowlists an actor only in the chat that stored the id", async () => {
    const text = "请免费领取礼品";
    const policyStore = createMemoryPolicyStore();
    await policyStore.put("local", "-100", {
      exemptAdmins: true,
      allowActorIds: ["5"],
    });
    const allowed = await screenTelegramEvent(await event(text, false), {
      cache: createMemoryCache(),
      policyStore,
    });
    expect(allowed.outcome).toBe("exempt");
    expect(allowed.exemptReason).toBe("allowlist");

    const otherChat = await screenTelegramEvent(
      await event(text, false, "-200"),
      { cache: createMemoryCache(), policyStore },
    );
    expect(otherChat.decision.action).toBe("delete");

    const adminElsewhere = await screenTelegramEvent(
      await event(text, true, "-200"),
      { cache: createMemoryCache(), policyStore },
    );
    expect(adminElsewhere.exemptReason).toBe("admin");
  });

  it("deletes a short flood and a repeated hash, then skips when full", async () => {
    const window = createMemoryRateWindow();
    const logger = createMemoryLogger();
    const base = Date.parse("2026-11-01T00:00:00.000Z");
    async function at(index: number, text: string) {
      return parseEvent({
        id: `rate_${index}_${text.length}`,
        tenantId: "local",
        chatId: "-100rate",
        kind: "message",
        occurredAt: new Date(base + index * 1000).toISOString(),
        actor: { id: "9", isAdmin: false },
        message: {
          id: String(index),
          text,
          textSha256: await sha256Hex(text),
        },
      });
    }
    const first = await screenTelegramEvent(await at(0, "hello"), {
      logger,
      rateWindow: window,
    });
    expect(first.decision.action).toBe("allow");
    await screenTelegramEvent(await at(1, "hello"), { rateWindow: window });
    const repeated = await screenTelegramEvent(await at(2, "hello"), {
      rateWindow: window,
    });
    expect(repeated.decision.action).toBe("delete");
    expect(repeated.decision.reasons).toContain("repeat");
    expect(JSON.stringify(repeated)).not.toContain("hello");

    const floodWindow = createMemoryRateWindow();
    for (let index = 0; index < 4; index += 1) {
      const step = await screenTelegramEvent(await at(index, `note-${index}`), {
        rateWindow: floodWindow,
      });
      expect(step.decision.action).toBe("allow");
    }
    const flooded = await screenTelegramEvent(await at(4, "note-4"), {
      rateWindow: floodWindow,
    });
    expect(flooded.decision.action).toBe("delete");
    expect(flooded.decision.reasons).toContain("flood");

    const capped = createMemoryRateWindow({ maxKeys: 0 });
    const skipped = await screenTelegramEvent(await at(6, "note-6"), {
      logger,
      rateWindow: capped,
    });
    expect(skipped.decision.action).toBe("allow");
    expect(skipped.detectorErrors).toEqual([]);
    expect(
      logger.entries.some((entry) => entry.message === "rate_window_skipped"),
    ).toBe(true);
  });

  it("deletes a short link and keeps the path out of the decision", async () => {
    const path = "secretpath";
    const result = await screenTelegramEvent(
      await event(`打开 https://bit.ly/${path}`),
      {
        logger: createMemoryLogger(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toContain("short_link");
    expect(JSON.stringify(result)).not.toContain(path);
  });

  it("deletes a shared actor only while that chat is opted in", async () => {
    const text = "今天站会改到三点";
    const blocklist = createMemoryBlocklistStore();
    let reads = 0;
    const wrapped: BlocklistStore = {
      isEnabled: (tenantId, chatId) => blocklist.isEnabled(tenantId, chatId),
      setEnabled: (tenantId, chatId, enabled) =>
        blocklist.setEnabled(tenantId, chatId, enabled),
      add: (tenantId, entry) => blocklist.add(tenantId, entry),
      async has(tenantId, entry) {
        reads += 1;
        return blocklist.has(tenantId, entry);
      },
    };
    const rateWindow = createMemoryRateWindow();
    const off = await screenTelegramEvent(await event(text), {
      blocklist: wrapped,
      rateWindow,
    });
    expect(off.decision.action).toBe("allow");
    expect(reads).toBe(0);
    expect(JSON.stringify(off)).not.toContain(text);

    await wrapped.setEnabled("local", "-100", true);
    await wrapped.add("local", { kind: "actor", value: "5" });
    const on = await screenTelegramEvent(await event("明天下午见"), {
      blocklist: wrapped,
      rateWindow,
    });
    expect(on.decision.action).toBe("delete");
    expect(on.decision.reasons).toContain("shared_actor");
    expect(JSON.stringify(on)).not.toContain("明天下午见");
    const seen = reads;
    expect(seen).toBeGreaterThan(0);

    await wrapped.setEnabled("local", "-100", false);
    const stopped = await screenTelegramEvent(await event("下周一同步"), {
      blocklist: wrapped,
      rateWindow,
    });
    expect(stopped.decision.action).toBe("allow");
    expect(reads).toBe(seen);

    await wrapped.setEnabled("local", "-200", true);
    const shared = await screenTelegramEvent(
      await event("周五再看", false, "-200"),
      { blocklist: wrapped, rateWindow: createMemoryRateWindow() },
    );
    expect(shared.decision.action).toBe("delete");
    expect(shared.decision.reasons).toContain("shared_actor");

    await wrapped.setEnabled("local", "-100777", true);
    const replaced = await screenTelegramEvent(
      await event("规则被整份替换", false, "-100777"),
      { blocklist: wrapped, rateWindow: createMemoryRateWindow() },
    );
    expect(replaced.decision.action).toBe("allow");
    expect(reads).toBe(seen + 1);
  });

  it("leaves the llm detector idle until a chat enables it", async () => {
    const phrase = "这个安排太差了";
    let calls = 0;
    const llm: LlmClassifier = {
      async classify() {
        calls += 1;
        return { label: "NEGATIVE", score: 0.99 };
      },
    };
    const idle = await screenTelegramEvent(
      await event(phrase, false, "-100555"),
      {
        llm,
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(idle.decision.action).toBe("allow");
    expect(calls).toBe(0);
    const source: RuleSource = {
      async loadChat() {
        return {
          version: 1,
          aggregate: "max",
          rules: [
            {
              id: "llm_hint",
              enabled: true,
              detectorIds: ["llm"],
              threshold: 1,
              actions: ["delete"],
            },
          ],
        };
      },
      async loadDefault() {
        return { version: 1, aggregate: "max", rules: [] };
      },
    };
    const hit = await screenTelegramEvent(await event(phrase), {
      llm,
      source,
      cache: createMemoryCache(),
    });
    expect(hit.decision.action).toBe("delete");
    expect(hit.decision.reasons).toContain("llm");
    expect(calls).toBe(1);
    expect(JSON.stringify(hit)).not.toContain(phrase);
  });

  it("leaves the regex detector idle until a chat enables it", async () => {
    const phrase = "加微x看看";
    const logger = createMemoryLogger();
    const idle = await screenTelegramEvent(
      await event(phrase, false, "-100570"),
      {
        logger,
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(idle.decision.action).toBe("allow");
    expect(idle.decision.reasons).not.toContain("regex_match");
    expect(JSON.stringify(logger.entries)).not.toContain(phrase);
    const source: RuleSource = {
      async loadChat() {
        return {
          version: 1,
          aggregate: "max",
          rules: [
            {
              id: "regex_hint",
              enabled: true,
              when: { eventKind: "message" },
              detectorIds: ["regex"],
              threshold: 1,
              actions: ["delete"],
            },
          ],
        };
      },
      async loadDefault() {
        return { version: 1, aggregate: "max", rules: [] };
      },
    };
    const enabledLog = createMemoryLogger();
    const enabled = await screenTelegramEvent(
      await event(phrase, false, "-100571"),
      {
        logger: enabledLog,
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(enabled.decision.action).toBe("delete");
    expect(enabled.decision.reasons).toContain("regex_match");
    expect(enabled.decision.evidence).toEqual([
      { kind: "feature", summary: "regex:hit" },
    ]);
    const logged = JSON.stringify(enabledLog.entries);
    expect(logged).not.toContain(phrase);
    expect(JSON.stringify(enabled)).not.toContain(phrase);
  });

  it("deletes a channel forward and keeps a user forward", async () => {
    const text = "今天站会改到三点";
    const title = "机密频道名";
    const logger = createMemoryLogger();
    const channel = await screenTelegramEvent(
      parseEvent({
        id: "tg_582",
        tenantId: "local",
        chatId: "-100582",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00.000Z",
        actor: { id: "5", isAdmin: false },
        message: {
          id: "9",
          text,
          textSha256: await sha256Hex(text),
          forward: "channel",
        },
      }),
      { logger, rateWindow: createMemoryRateWindow() },
    );
    expect(channel.decision.action).toBe("delete");
    expect(channel.decision.reasons).toContain("forward_channel");
    expect(channel.decision.evidence).toEqual([
      { kind: "feature", summary: "forward:channel" },
    ]);
    const logged = JSON.stringify(logger.entries);
    expect(logged).not.toContain(text);
    expect(logged).not.toContain(title);
    const user = await screenTelegramEvent(
      parseEvent({
        id: "tg_583",
        tenantId: "local",
        chatId: "-100583",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00.000Z",
        actor: { id: "5", isAdmin: false },
        message: {
          id: "9",
          text,
          textSha256: await sha256Hex(text),
          forward: "user",
        },
      }),
      { rateWindow: createMemoryRateWindow() },
    );
    expect(user.decision.action).toBe("allow");
  });

  it("leaves an unsigned external detector out of the pipeline", async () => {
    const logger = createMemoryLogger();
    const extra = {
      kind: "detector" as const,
      id: "extra",
      version: "0.1.0",
      capabilities: ["text"],
      configSchema: { parse: (value: unknown) => value },
      async detect() {
        return {
          detectorId: "extra",
          score: 1,
          reasons: ["extra"],
          evidence: [],
        };
      },
    } as unknown as Detector;
    const payload = canonicalPluginPayload({
      id: "extra",
      version: "0.1.0",
      kind: "detector",
      schema: "extra",
    });
    const manifest = {
      id: "extra",
      version: "0.1.0",
      kind: "detector" as const,
      schema: "extra",
      integrity: await sha256HexUtf8(payload),
    };
    const source: RuleSource = {
      async loadChat() {
        return null;
      },
      async loadDefault() {
        return {
          version: 1,
          aggregate: "max",
          rules: [
            {
              id: "extra_rule",
              enabled: true,
              detectorIds: ["extra"],
              threshold: 1,
              actions: ["delete"],
            },
          ],
        };
      },
    };
    const blocked = await screenTelegramEvent(
      await event("hello", false, "-100556"),
      {
        logger,
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        externalDetectors: [{ source: "external", manifest, value: extra }],
      },
    );
    expect(blocked.decision.action).toBe("allow");
    expect(
      logger.entries.some(
        (entry) =>
          entry.message === "plugin_rejected" &&
          entry.fields.reason === "unsigned",
      ),
    ).toBe(true);
    const opened = await screenTelegramEvent(
      await event("hello", false, "-100557"),
      {
        logger: createMemoryLogger(),
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        allowUnsigned: true,
        externalDetectors: [{ source: "external", manifest, value: extra }],
      },
    );
    expect(opened.decision.action).toBe("delete");
  });

  it("keeps an opted-in pack when refresh fails and returns to local rules after opt-out", async () => {
    const phrase = "请免费领取礼品";
    const logger = createMemoryLogger();
    const store = createMemoryRuleSubscriptionStore();
    const archive = createMemoryRulePackArchive();
    await store.put("local", "-100558", "community");
    let calls = 0;
    const source = {
      async load() {
        calls += 1;
        if (calls > 1) {
          throw new Error(phrase);
        }
        return { version: 1, aggregate: "max", rules: [] };
      },
    };
    const packs = { store, source, archive };
    const subscribed = await screenTelegramEvent(
      await event(phrase, false, "-100558"),
      {
        logger,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        rulePacks: packs,
      },
    );
    expect(subscribed.decision.action).toBe("allow");
    expect(calls).toBe(1);

    const other = await screenTelegramEvent(
      await event(phrase, false, "-100559"),
      {
        logger,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        rulePacks: packs,
      },
    );
    expect(other.decision.action).toBe("delete");
    expect(calls).toBe(1);

    const kept = await screenTelegramEvent(
      await event(phrase, false, "-100558"),
      {
        logger,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        rulePacks: packs,
      },
    );
    expect(kept.decision.action).toBe("allow");
    expect(calls).toBe(2);
    expect(
      logger.entries.some((entry) => entry.message === "pack_update_failed"),
    ).toBe(true);
    expect(JSON.stringify(logger.entries)).not.toContain(phrase);

    await store.put("local", "-100558", null);
    const local = await screenTelegramEvent(
      await event(phrase, false, "-100558"),
      {
        logger,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        rulePacks: packs,
      },
    );
    expect(local.decision.action).toBe("delete");
    expect(calls).toBe(2);
    await expect(filePackSource().load("community")).rejects.toThrow(
      "pack_missing",
    );
  });

  it("treats a broken pack subscription as unsubscribed", async () => {
    const phrase = "请免费领取礼品";
    const logger = createMemoryLogger();
    let calls = 0;
    const result = await screenTelegramEvent(
      await event(phrase, false, "-100560"),
      {
        logger,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        rulePacks: {
          store: {
            async get() {
              throw new Error(phrase);
            },
            async put() {
              throw new Error(phrase);
            },
          },
          source: {
            async load() {
              calls += 1;
              return { version: 1, aggregate: "max", rules: [] };
            },
          },
          archive: createMemoryRulePackArchive(),
        },
      },
    );
    expect(result.decision.action).toBe("delete");
    expect(calls).toBe(0);
    expect(
      logger.entries.some((entry) => entry.message === "pack_store_failed"),
    ).toBe(true);
    expect(JSON.stringify(logger.entries)).not.toContain(phrase);
  });

  it("asks Telegram to delete, mute, or ban once when a token is set", async () => {
    const phrase = "请免费领取礼品";
    const token = "bot-token";
    const calls: { method: string; body: string }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push({
        method: url.slice(url.lastIndexOf("/") + 1),
        body: String(init?.body ?? ""),
      });
      return new Response("{}", { status: 200 });
    };
    const deleted = await screenTelegramEvent(
      await event(phrase, false, "-100561"),
      {
        logger: createMemoryLogger(),
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        botToken: token,
        fetchImpl,
      },
    );
    expect(deleted.actionResults[0]?.status).toBe("executed");
    expect(calls.map((call) => call.method)).toEqual(["deleteMessage"]);
    expect(calls[0]?.body).toContain('"message_id":9');
    expect(calls[0]?.body).not.toContain(phrase);
    expect(calls[0]?.body).not.toContain(token);

    calls.length = 0;
    const muteRules = {
      async loadChat() {
        return null;
      },
      async loadDefault() {
        return {
          version: 1,
          aggregate: "max",
          rules: [
            {
              id: "quiet",
              enabled: true,
              detectorIds: ["keyword"],
              threshold: 1,
              actions: ["mute"],
            },
          ],
        };
      },
    };
    const muted = await screenTelegramEvent(
      await event(phrase, false, "-100562"),
      {
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        source: muteRules,
        botToken: token,
        fetchImpl,
      },
    );
    expect(muted.decision.action).toBe("mute");
    expect(calls.map((call) => call.method)).toEqual(["restrictChatMember"]);

    calls.length = 0;
    const banned = await screenTelegramEvent(
      await event(phrase, false, "-100563"),
      {
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        source: {
          async loadChat() {
            return null;
          },
          async loadDefault() {
            return {
              version: 1,
              aggregate: "max",
              rules: [
                {
                  id: "drop",
                  enabled: true,
                  detectorIds: ["keyword"],
                  threshold: 1,
                  actions: ["ban"],
                },
              ],
            };
          },
        },
        botToken: token,
        fetchImpl,
      },
    );
    expect(banned.decision.action).toBe("ban");
    expect(calls.map((call) => call.method)).toEqual(["banChatMember"]);
    expect(calls[0]?.body).toContain('"revoke_messages":false');

    const runtime = createMemoryRuntimeStore();
    await runtime.setDryRun("local", "-100564", true);
    let dryCalls = 0;
    const dry = await screenTelegramEvent(
      await event(phrase, false, "-100564"),
      {
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        runtime,
        botToken: token,
        fetchImpl: async () => {
          dryCalls += 1;
          return new Response("ok");
        },
      },
    );
    expect(dry.dryRun).toBe(true);
    expect(dryCalls).toBe(0);

    const logger = createMemoryLogger();
    const failed = await screenTelegramEvent(
      await event(phrase, false, "-100565"),
      {
        logger,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        botToken: token,
        fetchImpl: async () => new Response(phrase, { status: 400 }),
      },
    );
    expect(failed.decision.action).toBe("delete");
    expect(failed.actionResults[0]).toEqual({
      actionId: "delete",
      status: "failed",
      detail: "action_failed",
    });
    const logged = JSON.stringify(logger.entries);
    expect(logged).not.toContain(phrase);
    expect(logged).not.toContain(token);
  });

  it("logs and reports without copying the message", async () => {
    const phrase = "请免费领取礼品";
    const logger = createMemoryLogger();
    const notices: string[] = [];
    const notifier: Notifier = {
      async notify(notice) {
        notices.push(JSON.stringify(notice));
      },
    };
    const source: RuleSource = {
      async loadChat() {
        return null;
      },
      async loadDefault() {
        return {
          version: 1,
          aggregate: "max",
          rules: [
            {
              id: "watch",
              enabled: true,
              detectorIds: ["keyword"],
              threshold: 1,
              actions: ["log", "report"],
            },
          ],
        };
      },
    };
    const result = await screenTelegramEvent(
      await event(phrase, false, "-100566"),
      {
        logger,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        source,
        notifier,
      },
    );
    expect(result.decision.action).toBe("report");
    expect(result.actionResults.map((item) => item.status)).toEqual([
      "executed",
      "executed",
    ]);
    expect(notices[0]).toContain("keyword_match");
    expect(notices[0]).not.toContain(phrase);
    const logged = JSON.stringify(logger.entries);
    expect(logged).toContain("moderation_logged");
    expect(logged).not.toContain(phrase);
  });

  it("deletes a keyword that arrives as an edited message", async () => {
    const phrase = "请免费领取礼品";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 3001,
        edited_message: {
          message_id: 9,
          date: 1761955200,
          text: phrase,
          chat: { id: -100568, type: "supergroup" },
          from: { id: 5 },
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
    expect(outcome.event.edited).toBe(true);
    const logger = createMemoryLogger();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      cache: createMemoryCache(),
      rateWindow: createMemoryRateWindow(),
    });
    expect(result.decision.action).toBe("delete");
    expect(JSON.stringify(logger.entries)).not.toContain(phrase);
    const plain = await normalizeUpdate({
      update: {
        update_id: 3002,
        edited_message: {
          message_id: 10,
          date: 1761955200,
          text: "hello",
          chat: { id: -100569, type: "supergroup" },
          from: { id: 5 },
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(plain.status).toBe("event");
    if (plain.status !== "event") {
      return;
    }
    const allowed = await screenTelegramEvent(plain.event, {
      cache: createMemoryCache(),
      rateWindow: createMemoryRateWindow(),
    });
    expect(allowed.decision.action).toBe("allow");
  });
});
