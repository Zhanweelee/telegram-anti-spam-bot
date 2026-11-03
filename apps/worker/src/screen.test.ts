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
import { createMemoryQuotaStore, quotaPolicyFromEnv } from "@tasb/cloud";
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
import { screenTelegramEvent, workerStorage } from "./screen.js";

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
    expect(JSON.stringify(logger.entries)).not.toContain("Newbie");
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

  it("bans a join whose visible name matches a keyword", async () => {
    const name = "广告员免费领取礼品";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2002,
        chat_member: {
          chat: { id: -100588, type: "supergroup", title: "机密群名" },
          from: { id: 1 },
          date: 1761955200,
          old_chat_member: { user: { id: 78 }, status: "left" },
          new_chat_member: {
            user: { id: 78, first_name: name, language_code: "机密群名" },
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const captchaStore = createMemoryCaptchaStore();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
      captchaStore,
      createNonce: () => "0123456789abcdef",
    });
    expect(result.decision.action).toBe("ban");
    expect(result.decision.reasons).toContain("keyword_match");
    expect(result.decision.ruleIds).toContain("join_name");
    expect(moderator.banned).toEqual([
      { tenantId: "local", chatId: "-100588", actorId: "78" },
    ]);
    expect(moderator.restricted).toEqual([]);
    expect(await captchaStore.get("local", "-100588", "78")).toBeNull();
    const logged = JSON.stringify(logger.entries);
    expect(logged).not.toContain(name);
    expect(logged).not.toContain("机密群名");
    expect(JSON.stringify(result.decision.evidence)).not.toContain(name);
    const audit = await workerStorage.listAudits({
      tenantId: "local",
      chatId: "-100588",
      limit: 5,
    });
    expect(audit[0]?.textSha256).toBe(outcome.event.profile?.textSha256);
    expect(JSON.stringify(audit)).not.toContain(name);
  });

  it("bans a join whose visible name carries a short link", async () => {
    const screenJoin = async (
      updateId: number,
      chatId: number,
      user: { id: number; first_name: string; last_name?: string },
      inviteLink?: string,
    ) => {
      const outcome = await normalizeUpdate({
        update: {
          update_id: updateId,
          chat_member: {
            chat: { id: chatId, type: "supergroup", title: "机密群名" },
            from: { id: 1 },
            date: 1761955200,
            old_chat_member: { user: { id: user.id }, status: "left" },
            new_chat_member: {
              user: { ...user, language_code: "机密群名" },
              status: "member",
            },
            ...(inviteLink ? { invite_link: { invite_link: inviteLink } } : {}),
          },
        },
        tenantId: "local",
        adminUserIds: [],
        nowIso: "2026-11-01T00:00:00.000Z",
      });
      expect(outcome.status).toBe("event");
      if (outcome.status !== "event") {
        throw new Error("expected event");
      }
      const logger = createMemoryLogger();
      const moderator = createMemoryModerator();
      const captchaStore = createMemoryCaptchaStore();
      const result = await screenTelegramEvent(outcome.event, {
        logger,
        moderator,
        captchaStore,
        createNonce: () => "0123456789abcdef",
      });
      return { outcome, logger, moderator, captchaStore, result };
    };

    const name = "https://bit.ly/name84";
    const labeled = await screenJoin(5501, -100591, {
      id: 86,
      first_name: name,
    });
    expect(labeled.result.decision.action).toBe("ban");
    expect(labeled.result.decision.reasons).toContain("short_link");
    expect(labeled.result.decision.ruleIds).toContain("join_link");
    expect(JSON.stringify(labeled.result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    expect(labeled.moderator.banned).toEqual([
      { tenantId: "local", chatId: "-100591", actorId: "86" },
    ]);
    expect(labeled.moderator.restricted).toEqual([]);
    expect(await labeled.captchaStore.get("local", "-100591", "86")).toBeNull();
    const logged = JSON.stringify(labeled.logger.entries);
    expect(logged).not.toContain("name84");
    expect(logged).not.toContain("机密群名");
    expect(JSON.stringify(labeled.result.decision.evidence)).not.toContain(
      "name84",
    );
    const audit = await workerStorage.listAudits({
      tenantId: "local",
      chatId: "-100591",
      limit: 5,
    });
    expect(audit[0]?.textSha256).toBe(
      labeled.outcome.event.profile?.textSha256,
    );
    expect(JSON.stringify(audit)).not.toContain("name84");

    const ordinary = await screenJoin(5502, -100592, {
      id: 86,
      first_name: "https://example.com/ok84",
    });
    expect(ordinary.result.decision.action).toBe("captcha");
    expect(ordinary.moderator.banned).toEqual([]);
    expect(ordinary.moderator.restricted).toHaveLength(1);

    const invite = await screenJoin(5503, -100593, {
      id: 86,
      first_name: "https://t.me/+CODE84",
    });
    expect(invite.result.decision.action).toBe("ban");
    expect(invite.result.decision.reasons).toContain("invite");
    expect(invite.result.decision.ruleIds).toContain("join_link");
    expect(JSON.stringify(invite.result.decision.evidence)).toContain(
      "invite:t.me",
    );
    expect(JSON.stringify(invite.logger.entries)).not.toContain("CODE84");
    expect(JSON.stringify(invite.result.decision.evidence)).not.toContain(
      "CODE84",
    );

    const publicName = await screenJoin(5504, -100594, {
      id: 86,
      first_name: "https://t.me/durov",
    });
    expect(publicName.result.decision.action).toBe("captcha");
    expect(publicName.moderator.banned).toEqual([]);

    const joinedByLink = await screenJoin(
      5505,
      -100595,
      { id: 86, first_name: "Ada" },
      "https://t.me/+KEEP84",
    );
    expect(joinedByLink.result.decision.action).toBe("captcha");
    expect(joinedByLink.moderator.banned).toEqual([]);
    expect(JSON.stringify(joinedByLink.logger.entries)).not.toContain("KEEP84");
    expect(JSON.stringify(joinedByLink.result)).not.toContain("KEEP84");
  });

  it("declines a join request whose bio carries a short link", async () => {
    const phrase = "请免费领取礼品";
    const bio = `${phrase} https://bit.ly/bio83`;
    const outcome = await normalizeUpdate({
      update: {
        update_id: 5410,
        chat_join_request: {
          chat: {
            id: -100589,
            type: "supergroup",
            title: "https://cutt.ly/old83",
          },
          from: { id: 83, first_name: "https://tinyurl.com/name83" },
          user_chat_id: 83001,
          date: 1761955200,
          bio,
          invite_link: { invite_link: "https://t.me/+KEEP83" },
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("decline");
    expect(result.decision.ruleIds).toContain("join_request");
    expect(moderator.declined).toEqual([
      { tenantId: "local", chatId: "-100589", actorId: "83" },
    ]);
    expect(moderator.banned).toEqual([]);
    const logged = JSON.stringify(logger.entries);
    expect(logged).not.toContain(phrase);
    expect(logged).not.toContain("bio83");
    expect(logged).not.toContain("name83");
    expect(logged).not.toContain("KEEP83");
    expect(logged).not.toContain("old83");
    const audit = await workerStorage.listAudits({
      tenantId: "local",
      chatId: "-100589",
      limit: 5,
    });
    expect(audit[0]?.textSha256).toBe(outcome.event.profile?.textSha256);
    expect(JSON.stringify(audit)).not.toContain(phrase);
    expect(JSON.stringify(audit)).not.toContain("bio83");

    const clean = await normalizeUpdate({
      update: {
        update_id: 5411,
        chat_join_request: {
          chat: {
            id: -100590,
            type: "supergroup",
            title: "https://bit.ly/kept83",
          },
          from: { id: 83, first_name: phrase },
          date: 1761955200,
          bio: "https://example.com/ok83",
          invite_link: { invite_link: "https://ow.ly/inv83" },
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(clean.status).toBe("event");
    if (clean.status !== "event") {
      return;
    }
    const cleanModerator = createMemoryModerator();
    const cleanResult = await screenTelegramEvent(clean.event, {
      logger: createMemoryLogger(),
      moderator: cleanModerator,
    });
    expect(cleanResult.decision.action).toBe("allow");
    expect(cleanModerator.declined).toEqual([]);
  });

  it("bans a bot added from outside and drops its username", async () => {
    const name = "广告机器人";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2006,
        chat_member: {
          chat: { id: -100591, type: "supergroup", title: "机密群名" },
          from: { id: 1 },
          date: 1761955200,
          old_chat_member: {
            user: { id: 90, is_bot: true, username: name },
            status: "left",
          },
          new_chat_member: {
            user: { id: 90, is_bot: true, username: name, first_name: name },
            status: "administrator",
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
    expect(outcome.event.actor.bot).toBe(true);
    expect(outcome.event.actor.isAdmin).toBe(false);
    expect(outcome.event.membership).toBeUndefined();
    expect(JSON.stringify(outcome.event)).not.toContain(name);
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const captchaStore = createMemoryCaptchaStore();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
      captchaStore,
      createNonce: () => "0123456789abcdef",
    });
    expect(result.decision.action).toBe("ban");
    expect(result.decision.reasons).toContain("bot_joined");
    expect(result.decision.ruleIds).toContain("bot_join");
    expect(moderator.banned).toEqual([
      { tenantId: "local", chatId: "-100591", actorId: "90" },
    ]);
    expect(moderator.restricted).toEqual([]);
    expect(await captchaStore.get("local", "-100591", "90")).toBeNull();
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(name);
    expect(dumped).not.toContain("机密群名");
  });

  it("deletes a shared contact and keeps the phone out of logs", async () => {
    const phone = "13800138000";
    const name = "机密姓名";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2008,
        message: {
          message_id: 13,
          date: 1761955200,
          chat: { id: -100593, type: "supergroup", title: "机密群名" },
          from: { id: 92 },
          contact: {
            phone_number: phone,
            first_name: name,
            user_id: 999001,
            vcard: "BEGIN:VCARD",
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
    expect(outcome.event.message?.contact).toBe(true);
    const logger = createMemoryLogger();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      rateWindow: createMemoryRateWindow(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toContain("contact_shared");
    expect(result.decision.ruleIds).toContain("shared_contact");
    expect(JSON.stringify(result.decision.evidence)).toContain("contact:card");
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(phone);
    expect(dumped).not.toContain(name);
    expect(dumped).not.toContain("VCARD");
    expect(dumped).not.toContain("999001");
    expect(dumped).not.toContain("机密群名");
  });

  it("leaves inline bots alone until a chat enables the rule", async () => {
    const name = "机密代发";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2009,
        message: {
          message_id: 14,
          date: 1761955200,
          chat: { id: -100594, type: "supergroup", title: "机密群名" },
          from: { id: 93 },
          text: "今天站会",
          via_bot: {
            id: 999002,
            is_bot: true,
            first_name: name,
            username: name,
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
    expect(outcome.event.message?.via).toBe(true);
    const logger = createMemoryLogger();
    const idle = await screenTelegramEvent(outcome.event, {
      logger,
      rateWindow: createMemoryRateWindow(),
    });
    expect(idle.decision.action).toBe("allow");
    expect(idle.decision.reasons).not.toContain("via_bot");
    const source: RuleSource = {
      async loadChat() {
        return {
          version: 1,
          aggregate: "max",
          rules: [
            {
              id: "via_inline",
              enabled: true,
              when: { eventKind: "message" },
              detectorIds: ["via"],
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
      {
        ...outcome.event,
        id: "tg_2010",
        chatId: "-100595",
      },
      {
        logger: enabledLog,
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(enabled.decision.action).toBe("delete");
    expect(enabled.decision.reasons).toContain("via_bot");
    expect(enabled.decision.ruleIds).toContain("via_inline");
    expect(JSON.stringify(enabled.decision.evidence)).toContain("via:bot");
    const dumped = JSON.stringify({
      idle,
      enabled,
      logs: [...logger.entries, ...enabledLog.entries],
    });
    expect(dumped).not.toContain(name);
    expect(dumped).not.toContain("999002");
    expect(dumped).not.toContain("机密群名");
  });

  it("deletes an inline bot after a private-chat switch enables the rule", async () => {
    const name = "机密代发";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2011,
        message: {
          message_id: 15,
          date: 1761955200,
          chat: { id: -100596, type: "supergroup", title: "机密群名" },
          from: { id: 94 },
          text: "今天站会",
          via_bot: {
            id: 999003,
            is_bot: true,
            first_name: name,
            username: name,
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
    const runtime = createMemoryRuntimeStore();
    const cache = createMemoryCache();
    const idle = await screenTelegramEvent(outcome.event, {
      logger: createMemoryLogger(),
      rateWindow: createMemoryRateWindow(),
      runtime,
      cache,
    });
    expect(idle.decision.action).toBe("allow");
    expect(
      await runtime.setRuleSwitch("local", "-100596", "via_inline", true),
    ).toBe(true);
    const hit = await screenTelegramEvent(
      { ...outcome.event, id: "tg_2012" },
      {
        logger: createMemoryLogger(),
        rateWindow: createMemoryRateWindow(),
        runtime,
        cache,
      },
    );
    expect(hit.decision.action).toBe("delete");
    expect(hit.decision.reasons).toContain("via_bot");
    expect(hit.decision.ruleIds).toContain("via_inline");
    await runtime.clearRuleSwitch("local", "-100596", "via_inline");
    const again = await screenTelegramEvent(
      { ...outcome.event, id: "tg_2013" },
      {
        logger: createMemoryLogger(),
        rateWindow: createMemoryRateWindow(),
        runtime,
        cache,
      },
    );
    expect(again.decision.action).toBe("allow");
    const brokenLog = createMemoryLogger();
    const broken = await screenTelegramEvent(
      { ...outcome.event, id: "tg_2014" },
      {
        logger: brokenLog,
        rateWindow: createMemoryRateWindow(),
        cache,
        runtime: {
          ...runtime,
          async listRuleSwitches() {
            throw new Error(name);
          },
        },
      },
    );
    expect(broken.decision.action).toBe("allow");
    expect(JSON.stringify(brokenLog.entries)).toContain("runtime_failed");
    expect(JSON.stringify(brokenLog.entries)).not.toContain(name);
    expect(JSON.stringify(hit.decision.evidence)).not.toContain("999003");
  });

  it("drops a switched-on via rule after the free quota is spent", async () => {
    const runtime = createMemoryRuntimeStore();
    expect(
      await runtime.setRuleSwitch("local", "-100597", "via_inline", true),
    ).toBe(true);
    const quota = {
      policy: quotaPolicyFromEnv({
        QUOTA_ENABLED: "true",
        QUOTA_LIMIT: "1",
        QUOTA_BASIC: "keyword",
      }),
      store: createMemoryQuotaStore(),
    };
    const viaEvent = parseEvent({
      id: "tg_2015",
      tenantId: "local",
      chatId: "-100597",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00.000Z",
      actor: { id: "94", isAdmin: false },
      message: {
        id: "15",
        text: "今天站会",
        textSha256: "ab".repeat(32),
        via: true,
      },
    });
    const first = await screenTelegramEvent(viaEvent, {
      runtime,
      quota,
      cache: createMemoryCache(),
      rateWindow: createMemoryRateWindow(),
    });
    expect(first.decision.action).toBe("delete");
    expect(first.decision.reasons).toContain("via_bot");
    const second = await screenTelegramEvent(
      { ...viaEvent, id: "tg_2016" },
      {
        runtime,
        quota,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(second.decision.action).toBe("allow");
    expect(second.decision.reasons).not.toContain("via_bot");
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

  it("deletes a contact card URL and keeps the vCard out of logs", async () => {
    const phone = "13800138118";
    const path = "card118";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2118,
        message: {
          message_id: 118,
          date: 1761955200,
          chat: { id: -1008118, type: "supergroup", title: "机密群名" },
          from: { id: 118 },
          contact: {
            phone_number: phone,
            first_name: "名片姓名118",
            vcard: `BEGIN:VCARD\nURL:https://bit.ly/${path}\nEND:VCARD`,
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
    const logger = createMemoryLogger();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      rateWindow: createMemoryRateWindow(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toContain("short_link");
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(phone);
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("名片姓名118");
    expect(dumped).not.toContain("VCARD");
    expect(dumped).not.toContain("机密群名");
  });

  it("deletes a hidden short link and keeps the path out of logs", async () => {
    const secret = "https://bit.ly/机密路径";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2003,
        message: {
          message_id: 11,
          date: 1761955200,
          chat: { id: -100589, type: "supergroup", title: "机密群名" },
          from: { id: 81 },
          text: "点这里",
          entities: [{ type: "text_link", offset: 0, length: 3, url: secret }],
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
    const logger = createMemoryLogger();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      rateWindow: createMemoryRateWindow(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toContain("short_link");
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(secret);
    expect(dumped).not.toContain("机密路径");
    expect(dumped).not.toContain("机密群名");
  });

  it("deletes a short link Android stops on before a later authority", async () => {
    const path = "span119";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2119,
        message: {
          message_id: 119,
          date: 1761955200,
          chat: { id: -1008119, type: "supergroup", title: "机密群名" },
          from: { id: 119 },
          text: `http://bit.ly\u2215@example.com/${path}`,
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
    const logger = createMemoryLogger();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      rateWindow: createMemoryRateWindow(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toContain("short_link");
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");
  });

  it("deletes a short link Android stops on inside a compose draft", async () => {
    const path = "span120";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2122,
        message: {
          message_id: 122,
          date: 1761955200,
          chat: { id: -1008122, type: "supergroup", title: "机密群名" },
          from: { id: 122 },
          text: "今天站会",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "主页",
                  url: `https://t.me/durov?text=${encodeURIComponent(`http://bit.ly\u2215@example.com/${path}`)}`,
                },
              ],
            ],
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
    const logger = createMemoryLogger();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      rateWindow: createMemoryRateWindow(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toContain("short_link");
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("durov");
    expect(dumped).not.toContain("机密群名");
  });

  it("deletes a short link Android opens in an empty game description", async () => {
    const path = "span121";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2130,
        message: {
          message_id: 130,
          date: 1761955200,
          chat: { id: -1008130, type: "supergroup", title: "机密群名" },
          from: { id: 130 },
          game: {
            title: "今天站会",
            description: `http://bit.ly\u2215@example.com/${path}`,
            photo: [],
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
    const logger = createMemoryLogger();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      rateWindow: createMemoryRateWindow(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toContain("short_link");
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");
  });

  it("deletes a short link Android opens in an invoice description", async () => {
    const path = "span122";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2140,
        message: {
          message_id: 140,
          date: 1761955200,
          chat: { id: -1008140, type: "supergroup", title: "机密群名" },
          from: { id: 140 },
          text: "今天站会",
          invoice: {
            title: "账单",
            description: `http://bit.ly\u2215@example.com/${path}`,
            currency: "XTR",
            total_amount: 1,
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
    const logger = createMemoryLogger();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      rateWindow: createMemoryRateWindow(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toContain("short_link");
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("XTR");
    expect(dumped).not.toContain("机密群名");
  });

  it("deletes a hidden telegram invite and keeps the code out of logs", async () => {
    const code = "INVITESECRET99";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2004,
        message: {
          message_id: 12,
          date: 1761955200,
          chat: { id: -100590, type: "supergroup", title: "机密群名" },
          from: { id: 82 },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/+${code}`,
            },
          ],
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
    const logger = createMemoryLogger();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      rateWindow: createMemoryRateWindow(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toContain("invite");
    expect(JSON.stringify(result.decision.evidence)).toContain("invite:t.me");
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(code);
    expect(dumped).not.toContain("机密群名");
  });

  it("deletes an android folder invite and keeps the code out of logs", async () => {
    const code = "FOLDER108";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 78011,
        message: {
          message_id: 78011,
          date: 1761955200,
          chat: { id: -100590, type: "supergroup", title: "机密群名" },
          from: { id: 108 },
          text: `打开 https://t.me/folder/${code}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-02T00:00:00.000Z",
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    const logger = createMemoryLogger();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      rateWindow: createMemoryRateWindow(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toContain("invite");
    expect(JSON.stringify(result.decision.evidence)).toContain("invite:t.me");
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(code);
    expect(dumped).not.toContain("机密群名");
  });

  it("deletes a business chat link and keeps the slug out of logs", async () => {
    const code = "BIZCHAT123";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2150,
        message: {
          message_id: 2150,
          date: 1761955200,
          chat: { id: -100590, type: "supergroup", title: "机密群名" },
          from: { id: 123 },
          text: `打开 https://t.me/m/${code}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-02T00:00:00.000Z",
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    const logger = createMemoryLogger();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      rateWindow: createMemoryRateWindow(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toContain("invite");
    expect(JSON.stringify(result.decision.evidence)).toContain("invite:t.me");
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(code);
    expect(dumped).not.toContain("机密群名");
  });

  it("deletes a short link Android opens in an inline query", async () => {
    const path = "span124";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2160,
        message: {
          message_id: 160,
          date: 1761955200,
          chat: { id: -1008160, type: "supergroup", title: "机密群名" },
          from: { id: 160 },
          text: "今天站会",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "打开",
                  switch_inline_query: `http://bit.ly\u2215@example.com/${path}`,
                  callback_data: "https://ow.ly/cb124",
                },
              ],
            ],
          },
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-02T00:00:00.000Z",
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    const logger = createMemoryLogger();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      rateWindow: createMemoryRateWindow(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toContain("short_link");
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("cb124");
    expect(dumped).not.toContain("ow.ly");
    expect(dumped).not.toContain("机密群名");
  });

  it("deletes an android prefix invite and keeps the code out of logs", async () => {
    const code = "PREFIX109";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 78016,
        message: {
          message_id: 78016,
          date: 1761955200,
          chat: { id: -100590, type: "supergroup", title: "机密群名" },
          from: { id: 109 },
          text: `打开 https://joinchat.t.me/${code}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-02T00:00:00.000Z",
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    const logger = createMemoryLogger();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      rateWindow: createMemoryRateWindow(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toContain("invite");
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "invite:joinchat.t.me",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(code);
    expect(dumped).not.toContain("机密群名");
  });

  it("deletes a capitalized joinchat invite and keeps the code out of logs", async () => {
    const code = "CASE110";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 78019,
        message: {
          message_id: 78019,
          date: 1761955200,
          chat: { id: -100590, type: "supergroup", title: "机密群名" },
          from: { id: 110 },
          text: `打开 https://telegram.me/ADDLIST/${code}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-02T00:00:00.000Z",
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    const logger = createMemoryLogger();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      rateWindow: createMemoryRateWindow(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toContain("invite");
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "invite:telegram.me",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(code);
    expect(dumped).not.toContain("机密群名");
  });

  it("deletes a percent-encoded space invite and keeps the code out of logs", async () => {
    const code = "CASE111";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 78023,
        message: {
          message_id: 78023,
          date: 1761955200,
          chat: { id: -100590, type: "supergroup", title: "机密群名" },
          from: { id: 111 },
          text: `打开 https://telegram.me/%20${code}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-02T00:00:00.000Z",
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    const logger = createMemoryLogger();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      rateWindow: createMemoryRateWindow(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toContain("invite");
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "invite:telegram.me",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(code);
    expect(dumped).not.toContain("机密群名");
  });

  it("deletes a passport callback host and keeps the secrets out of logs", async () => {
    const address = "203.0.113.112";
    const path = "hidden112";
    const nonce = "NONCE112";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 78028,
        message: {
          message_id: 78028,
          date: 1761955200,
          chat: { id: -100590, type: "supergroup", title: "机密群名" },
          from: { id: 112 },
          text: `打开 https://t.me/telegrampassport?callback_url=${encodeURIComponent(`http://${address}/${path}`)}&nonce=${nonce}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-02T00:00:00.000Z",
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    const logger = createMemoryLogger();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      rateWindow: createMemoryRateWindow(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toContain("ip_host");
    expect(JSON.stringify(result.decision.evidence)).toContain(
      `ip_host:${address}`,
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain(nonce);
    expect(dumped).not.toContain("机密群名");
  });

  it("deletes a username app draft and keeps the name out of logs", async () => {
    const address = "203.0.113.114";
    const hidden = "hidden114";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 78032,
        message: {
          message_id: 78032,
          date: 1761955200,
          chat: { id: -100590, type: "supergroup", title: "机密群名" },
          from: { id: 114 },
          text: `打开 https://telegram.me/durov/shop?text=${encodeURIComponent(`http://${address}/${hidden}`)}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-02T00:00:00.000Z",
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    const logger = createMemoryLogger();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      rateWindow: createMemoryRateWindow(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toContain("ip_host");
    expect(JSON.stringify(result.decision.evidence)).toContain(
      `ip_host:${address}`,
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(hidden);
    expect(dumped).not.toContain("durov");
    expect(dumped).not.toContain("机密群名");
  });

  it("deletes a long desktop path draft and keeps the segment out of logs", async () => {
    const address = "203.0.113.115";
    const hidden = "hidden115";
    const app = "b".repeat(129);
    const outcome = await normalizeUpdate({
      update: {
        update_id: 78036,
        message: {
          message_id: 78036,
          date: 1761955200,
          chat: { id: -100590, type: "supergroup", title: "机密群名" },
          from: { id: 115 },
          text: `打开 https://t.me/durov/${app}?text=${encodeURIComponent(`http://${address}/${hidden}`)}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-02T00:00:00.000Z",
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    const logger = createMemoryLogger();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      rateWindow: createMemoryRateWindow(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toContain("ip_host");
    expect(JSON.stringify(result.decision.evidence)).toContain(
      `ip_host:${address}`,
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(hidden);
    expect(dumped).not.toContain(app);
    expect(dumped).not.toContain("机密群名");
  });

  it("deletes a stripped preview draft and keeps the name out of logs", async () => {
    const address = "203.0.113.118";
    const hidden = "hidden118";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 78045,
        message: {
          message_id: 78045,
          date: 1761955200,
          chat: { id: -100592, type: "supergroup", title: "机密群名" },
          from: { id: 118 },
          text: `打开 https://t.me/s/durov/123?text=${encodeURIComponent(`http://${address}/${hidden}`)}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-02T00:00:00.000Z",
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    const logger = createMemoryLogger();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      rateWindow: createMemoryRateWindow(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toContain("ip_host");
    expect(JSON.stringify(result.decision.evidence)).toContain(
      `ip_host:${address}`,
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(hidden);
    expect(dumped).not.toContain("durov");
    expect(dumped).not.toContain("机密群名");
  });

  it("deletes an Android label subdomain draft and keeps the name out of logs", async () => {
    const address = "203.0.113.117";
    const hidden = "hidden117";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 78042,
        message: {
          message_id: 78042,
          date: 1761955200,
          chat: { id: -100591, type: "supergroup", title: "机密群名" },
          from: { id: 117 },
          text: `打开 https://s.t.me/durov?text=${encodeURIComponent(`http://${address}/${hidden}`)}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-02T00:00:00.000Z",
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    const logger = createMemoryLogger();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      rateWindow: createMemoryRateWindow(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toContain("ip_host");
    expect(JSON.stringify(result.decision.evidence)).toContain(
      `ip_host:${address}`,
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(hidden);
    expect(dumped).not.toContain("durov");
    expect(dumped).not.toContain("机密群名");
  });

  it("deletes a preview resolve draft and keeps the name out of logs", async () => {
    const address = "203.0.113.116";
    const hidden = "hidden116";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 78039,
        message: {
          message_id: 78039,
          date: 1761955200,
          chat: { id: -100590, type: "supergroup", title: "机密群名" },
          from: { id: 116 },
          text: `打开 tg://resolve?domain=s&appname=durov&text=${encodeURIComponent(`http://${address}/${hidden}`)}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-02T00:00:00.000Z",
    });
    expect(outcome.status).toBe("event");
    if (outcome.status !== "event") {
      return;
    }
    const logger = createMemoryLogger();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      rateWindow: createMemoryRateWindow(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toContain("ip_host");
    expect(JSON.stringify(result.decision.evidence)).toContain(
      `ip_host:${address}`,
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(hidden);
    expect(dumped).not.toContain("durov");
    expect(dumped).not.toContain("机密群名");
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
      remove: (tenantId, entry) => blocklist.remove(tenantId, entry),
      size: (tenantId) => blocklist.size(tenantId),
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

  it("keeps keyword deletes after the free quota drops llm", async () => {
    const phrase = "请免费领取礼品";
    let calls = 0;
    const llm: LlmClassifier = {
      async classify() {
        calls += 1;
        return { label: "NEGATIVE", score: 0.99 };
      },
    };
    const quota = {
      policy: quotaPolicyFromEnv({
        QUOTA_ENABLED: "true",
        QUOTA_LIMIT: "1",
        QUOTA_BASIC: "keyword",
      }),
      store: createMemoryQuotaStore(),
    };
    const source: RuleSource = {
      async loadChat() {
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
    const logger = createMemoryLogger();
    const first = await screenTelegramEvent(
      await event(phrase, false, "-100584"),
      {
        logger,
        llm,
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        quota,
      },
    );
    expect(first.decision.action).toBe("delete");
    expect(calls).toBe(1);
    const second = await screenTelegramEvent(
      await event(phrase, false, "-100584"),
      {
        logger,
        llm,
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        quota,
      },
    );
    expect(second.decision.action).toBe("delete");
    expect(second.decision.reasons).toContain("keyword_match");
    expect(second.decision.reasons).not.toContain("llm");
    expect(calls).toBe(1);
    expect(JSON.stringify(logger.entries)).not.toContain(phrase);
    const other = await screenTelegramEvent(
      await event("hello", false, "-100585"),
      {
        llm,
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        quota,
      },
    );
    expect(calls).toBe(2);
    expect(other.decision.reasons).toContain("llm");
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

  it("deletes a join service message whose visible name carries a short link", async () => {
    const screenMembers = async (
      updateId: number,
      chatId: number,
      members: readonly Record<string, unknown>[],
      extra?: Record<string, unknown>,
    ) => {
      const outcome = await normalizeUpdate({
        update: {
          update_id: updateId,
          message: {
            message_id: updateId,
            date: 1761955200,
            chat: { id: chatId, type: "supergroup", title: "机密群名" },
            from: { id: 87, first_name: "https://tinyurl.com/from85" },
            ...extra,
            ...(members.length > 0 ? { new_chat_members: members } : {}),
          },
        },
        tenantId: "local",
        adminUserIds: [],
        nowIso: "2026-11-01T00:00:00.000Z",
      });
      expect(outcome.status).toBe("event");
      if (outcome.status !== "event") {
        throw new Error("expected event");
      }
      const logger = createMemoryLogger();
      const moderator = createMemoryModerator();
      const result = await screenTelegramEvent(outcome.event, {
        logger,
        moderator,
      });
      return { outcome, logger, moderator, result };
    };

    const linked = await screenMembers(5510, -100596, [
      { id: 87, first_name: "https://bit.ly/name85" },
    ]);
    expect(linked.result.decision.action).toBe("delete");
    expect(linked.result.decision.reasons).toContain("short_link");
    expect(linked.result.decision.ruleIds).toContain("links");
    expect(linked.moderator.deleted).toEqual([
      { tenantId: "local", chatId: "-100596", messageId: "5510" },
    ]);
    expect(JSON.stringify(linked.logger.entries)).not.toContain("name85");
    expect(JSON.stringify(linked.logger.entries)).not.toContain("from85");
    expect(JSON.stringify(linked.result.decision.evidence)).not.toContain(
      "name85",
    );

    const named = await screenMembers(5511, -100597, [
      { id: 87, first_name: "广告员免费领取礼品" },
    ]);
    expect(named.result.decision.action).toBe("delete");
    expect(named.result.decision.reasons).toContain("keyword_match");
    expect(named.result.decision.ruleIds).toContain("spam_keywords");
    expect(JSON.stringify(named.logger.entries)).not.toContain("免费领取");

    const ordinary = await screenMembers(5512, -100598, [
      { id: 87, first_name: "https://example.com/ok85" },
    ]);
    expect(ordinary.result.decision.action).toBe("allow");
    expect(ordinary.moderator.deleted).toEqual([]);

    const invited = await screenMembers(5513, -100599, [
      { id: 87, first_name: "https://t.me/+CODE85" },
    ]);
    expect(invited.result.decision.action).toBe("delete");
    expect(invited.result.decision.reasons).toContain("invite");
    expect(JSON.stringify(invited.logger.entries)).not.toContain("CODE85");

    const left = await screenMembers(5514, -100600, [], {
      left_chat_member: { id: 87004, first_name: "https://bit.ly/left85" },
    });
    expect(left.result.decision.action).toBe("allow");
    expect(left.moderator.deleted).toEqual([]);
    expect(JSON.stringify(left.logger.entries)).not.toContain("left85");
    expect(JSON.stringify(left.result)).not.toContain("left85");
  });

  it("deletes a video chat invite whose visible name carries a short link", async () => {
    const screenInvite = async (
      updateId: number,
      chatId: number,
      users: readonly Record<string, unknown>[],
      extra?: Record<string, unknown>,
    ) => {
      const outcome = await normalizeUpdate({
        update: {
          update_id: updateId,
          message: {
            message_id: updateId,
            date: 1761955200,
            chat: { id: chatId, type: "supergroup", title: "机密群名" },
            from: { id: 88, first_name: "https://tinyurl.com/from86" },
            video_chat_participants_invited: { users },
            ...extra,
          },
        },
        tenantId: "local",
        adminUserIds: [],
        nowIso: "2026-11-01T00:00:00.000Z",
      });
      expect(outcome.status).toBe("event");
      if (outcome.status !== "event") {
        throw new Error("expected event");
      }
      const logger = createMemoryLogger();
      const moderator = createMemoryModerator();
      const result = await screenTelegramEvent(outcome.event, {
        logger,
        moderator,
      });
      return { logger, moderator, result };
    };

    const linked = await screenInvite(5610, -100610, [
      { id: 88, first_name: "https://bit.ly/name86" },
    ]);
    expect(linked.result.decision.action).toBe("delete");
    expect(linked.result.decision.reasons).toContain("short_link");
    expect(linked.result.decision.ruleIds).toContain("links");
    expect(linked.moderator.deleted).toEqual([
      { tenantId: "local", chatId: "-100610", messageId: "5610" },
    ]);
    expect(JSON.stringify(linked.logger.entries)).not.toContain("name86");
    expect(JSON.stringify(linked.logger.entries)).not.toContain("from86");
    expect(JSON.stringify(linked.result.decision.evidence)).not.toContain(
      "name86",
    );

    const named = await screenInvite(5611, -100611, [
      { id: 88, first_name: "广告员免费领取礼品" },
    ]);
    expect(named.result.decision.action).toBe("delete");
    expect(named.result.decision.reasons).toContain("keyword_match");
    expect(JSON.stringify(named.logger.entries)).not.toContain("免费领取");

    const ordinary = await screenInvite(5612, -100612, [
      { id: 88, first_name: "https://example.com/ok86" },
    ]);
    expect(ordinary.result.decision.action).toBe("allow");
    expect(ordinary.moderator.deleted).toEqual([]);

    const ended = await screenInvite(
      5613,
      -100613,
      [{ id: 88, first_name: "Ada" }],
      { video_chat_ended: { duration: 86 } },
    );
    expect(ended.result.decision.action).toBe("allow");
    expect(JSON.stringify(ended.result)).not.toContain("机密群名");
  });

  it("deletes an owner change whose visible name carries a short link", async () => {
    const screenOwner = async (
      updateId: number,
      chatId: number,
      owner: Record<string, unknown> | undefined,
      field: "chat_owner_changed" | "chat_owner_left",
    ) => {
      const outcome = await normalizeUpdate({
        update: {
          update_id: updateId,
          message: {
            message_id: updateId,
            date: 1761955200,
            chat: { id: chatId, type: "supergroup", title: "机密群名" },
            from: { id: 89, first_name: "https://tinyurl.com/from87" },
            [field]: owner ? { new_owner: owner } : {},
          },
        },
        tenantId: "local",
        adminUserIds: [],
        nowIso: "2026-11-01T00:00:00.000Z",
      });
      expect(outcome.status).toBe("event");
      if (outcome.status !== "event") {
        throw new Error("expected event");
      }
      const logger = createMemoryLogger();
      const moderator = createMemoryModerator();
      const result = await screenTelegramEvent(outcome.event, {
        logger,
        moderator,
      });
      return { logger, moderator, result };
    };

    const linked = await screenOwner(
      5710,
      -100620,
      { id: 89, first_name: "https://bit.ly/name87" },
      "chat_owner_changed",
    );
    expect(linked.result.decision.action).toBe("delete");
    expect(linked.result.decision.reasons).toContain("short_link");
    expect(linked.result.decision.ruleIds).toContain("links");
    expect(linked.moderator.deleted).toEqual([
      { tenantId: "local", chatId: "-100620", messageId: "5710" },
    ]);
    expect(JSON.stringify(linked.logger.entries)).not.toContain("name87");
    expect(JSON.stringify(linked.logger.entries)).not.toContain("from87");
    expect(JSON.stringify(linked.result.decision.evidence)).not.toContain(
      "name87",
    );

    const named = await screenOwner(
      5711,
      -100621,
      { id: 89, first_name: "广告员免费领取礼品" },
      "chat_owner_left",
    );
    expect(named.result.decision.action).toBe("delete");
    expect(named.result.decision.reasons).toContain("keyword_match");
    expect(JSON.stringify(named.logger.entries)).not.toContain("免费领取");

    const ordinary = await screenOwner(
      5712,
      -100622,
      { id: 89, first_name: "https://example.com/ok87" },
      "chat_owner_changed",
    );
    expect(ordinary.result.decision.action).toBe("allow");
    expect(ordinary.moderator.deleted).toEqual([]);

    const departed = await screenOwner(
      5713,
      -100623,
      undefined,
      "chat_owner_left",
    );
    expect(departed.result.decision.action).toBe("allow");
    expect(JSON.stringify(departed.result)).not.toContain("from87");
    expect(JSON.stringify(departed.logger.entries)).not.toContain("机密群名");
  });

  it("deletes a proximity alert whose visible name carries a short link", async () => {
    const screenNear = async (
      updateId: number,
      chatId: number,
      alert: Record<string, unknown>,
    ) => {
      const outcome = await normalizeUpdate({
        update: {
          update_id: updateId,
          message: {
            message_id: updateId,
            date: 1761955200,
            chat: { id: chatId, type: "supergroup", title: "机密群名" },
            from: { id: 90, first_name: "https://tinyurl.com/from88" },
            proximity_alert_triggered: alert,
          },
        },
        tenantId: "local",
        adminUserIds: [],
        nowIso: "2026-11-01T00:00:00.000Z",
      });
      expect(outcome.status).toBe("event");
      if (outcome.status !== "event") {
        throw new Error("expected event");
      }
      const logger = createMemoryLogger();
      const moderator = createMemoryModerator();
      const result = await screenTelegramEvent(outcome.event, {
        logger,
        moderator,
      });
      return { logger, moderator, result };
    };

    const linked = await screenNear(5810, -100630, {
      traveler: { id: 90, first_name: "https://bit.ly/name88" },
      watcher: { id: 91, first_name: "Ada" },
      distance: 90909,
    });
    expect(linked.result.decision.action).toBe("delete");
    expect(linked.result.decision.reasons).toContain("short_link");
    expect(linked.result.decision.ruleIds).toContain("links");
    expect(linked.moderator.deleted).toEqual([
      { tenantId: "local", chatId: "-100630", messageId: "5810" },
    ]);
    expect(JSON.stringify(linked.logger.entries)).not.toContain("name88");
    expect(JSON.stringify(linked.logger.entries)).not.toContain("from88");
    expect(JSON.stringify(linked.logger.entries)).not.toContain("90909");
    expect(JSON.stringify(linked.result.decision.evidence)).not.toContain(
      "name88",
    );

    const named = await screenNear(5811, -100631, {
      traveler: { id: 90, first_name: "Ada" },
      watcher: { id: 91, first_name: "广告员免费领取礼品" },
      distance: 8,
    });
    expect(named.result.decision.action).toBe("delete");
    expect(named.result.decision.reasons).toContain("keyword_match");
    expect(JSON.stringify(named.logger.entries)).not.toContain("免费领取");

    const ordinary = await screenNear(5812, -100632, {
      traveler: { id: 90, first_name: "https://example.com/ok88" },
      watcher: { id: 91, first_name: "Bea" },
      distance: 12,
    });
    expect(ordinary.result.decision.action).toBe("allow");
    expect(ordinary.moderator.deleted).toEqual([]);
    expect(JSON.stringify(ordinary.result)).not.toContain("90909");
  });

  it("deletes a mathematical expression that carries a short link", async () => {
    const screenMath = async (
      updateId: number,
      chatId: number,
      blocks: readonly Record<string, unknown>[],
    ) => {
      const outcome = await normalizeUpdate({
        update: {
          update_id: updateId,
          message: {
            message_id: updateId,
            date: 1761955200,
            chat: { id: chatId, type: "supergroup", title: "机密群名" },
            from: { id: 91, first_name: "https://tinyurl.com/from91" },
            rich_message: { blocks },
          },
        },
        tenantId: "local",
        adminUserIds: [],
        nowIso: "2026-11-01T00:00:00.000Z",
      });
      expect(outcome.status).toBe("event");
      if (outcome.status !== "event") {
        throw new Error("expected event");
      }
      const logger = createMemoryLogger();
      const moderator = createMemoryModerator();
      const result = await screenTelegramEvent(outcome.event, {
        logger,
        moderator,
      });
      return { logger, moderator, result, event: outcome.event };
    };

    const linked = await screenMath(5910, -100640, [
      {
        type: "mathematical_expression",
        expression: "LATEXSECRET91 https://bit.ly/name91",
      },
    ]);
    expect(linked.result.decision.action).toBe("delete");
    expect(linked.result.decision.reasons).toContain("short_link");
    expect(linked.result.decision.ruleIds).toContain("links");
    expect(linked.event.message?.text).toBe("");
    expect(linked.moderator.deleted).toEqual([
      { tenantId: "local", chatId: "-100640", messageId: "5910" },
    ]);
    expect(JSON.stringify(linked.logger.entries)).not.toContain("name91");
    expect(JSON.stringify(linked.logger.entries)).not.toContain(
      "LATEXSECRET91",
    );
    expect(JSON.stringify(linked.logger.entries)).not.toContain("from91");
    expect(JSON.stringify(linked.result.decision.evidence)).not.toContain(
      "name91",
    );

    const keyword = await screenMath(5911, -100641, [
      {
        type: "mathematical_expression",
        expression: "请免费领取礼品",
      },
    ]);
    expect(keyword.result.decision.action).toBe("allow");
    expect(keyword.event.message?.text).toBe("");
    expect(keyword.moderator.deleted).toEqual([]);
    expect(JSON.stringify(keyword.logger.entries)).not.toContain("免费领取");
    expect(JSON.stringify(keyword.event)).not.toContain("免费领取");

    const ordinary = await screenMath(5912, -100642, [
      {
        type: "mathematical_expression",
        expression: "https://example.com/ok91",
      },
    ]);
    expect(ordinary.result.decision.action).toBe("allow");
    expect(ordinary.moderator.deleted).toEqual([]);
    expect(JSON.stringify(ordinary.event)).not.toContain("ok91");
  });

  it("deletes the third caption-less rich photo with the same file", async () => {
    const window = createMemoryRateWindow();
    const fileId = "SECRETFILE92";
    const uniqueId = "RICHPHOTO92";
    const screenPhoto = async (updateId: number, id: string) => {
      const outcome = await normalizeUpdate({
        update: {
          update_id: updateId,
          message: {
            message_id: updateId,
            date: 1761955200,
            chat: { id: -100650, type: "supergroup", title: "机密群名" },
            from: { id: 92, first_name: "from92" },
            rich_message: {
              blocks: [
                {
                  type: "photo",
                  photo: [
                    {
                      file_id: fileId,
                      file_unique_id: id,
                      width: 1,
                      height: 1,
                    },
                  ],
                },
              ],
            },
          },
        },
        tenantId: "local",
        adminUserIds: [],
        nowIso: "2026-11-01T00:00:00.000Z",
      });
      expect(outcome.status).toBe("event");
      if (outcome.status !== "event") {
        throw new Error("expected event");
      }
      const logger = createMemoryLogger();
      const moderator = createMemoryModerator();
      const result = await screenTelegramEvent(outcome.event, {
        logger,
        moderator,
        rateWindow: window,
      });
      return { logger, moderator, result, event: outcome.event };
    };

    const first = await screenPhoto(6110, uniqueId);
    expect(first.result.decision.action).toBe("allow");
    const second = await screenPhoto(6111, uniqueId);
    expect(second.result.decision.action).toBe("allow");
    const third = await screenPhoto(6112, uniqueId);
    expect(third.result.decision.action).toBe("delete");
    expect(third.result.decision.reasons).toContain("repeat");
    expect(third.result.decision.ruleIds).toContain("repeat");
    expect(third.event.message?.text).toBe("");
    expect(third.event.message?.media).toBe("photo");
    expect(third.moderator.deleted).toEqual([
      { tenantId: "local", chatId: "-100650", messageId: "6112" },
    ]);
    expect(JSON.stringify(third.logger.entries)).not.toContain(fileId);
    expect(JSON.stringify(third.logger.entries)).not.toContain(uniqueId);
    expect(JSON.stringify(third.logger.entries)).not.toContain("from92");
    expect(JSON.stringify(third.result.decision.evidence)).not.toContain(
      fileId,
    );
    expect(JSON.stringify(third.result.decision.evidence)).not.toContain(
      uniqueId,
    );

    const other = await screenPhoto(6113, "OTHERPHOTO92");
    expect(other.result.decision.action).toBe("allow");
    expect(other.moderator.deleted).toEqual([]);
    expect(JSON.stringify(other.event)).not.toContain("OTHERPHOTO92");
    expect(JSON.stringify(other.event)).not.toContain(fileId);
    expect(JSON.stringify(other.logger.entries)).not.toContain(fileId);
  });

  it("deletes the third caption-less paid photo with the same file", async () => {
    const window = createMemoryRateWindow();
    const fileId = "SECRETFILE93";
    const uniqueId = "PAIDPHOTO93";
    const screenPhoto = async (updateId: number, id: string) => {
      const outcome = await normalizeUpdate({
        update: {
          update_id: updateId,
          message: {
            message_id: updateId,
            date: 1761955200,
            chat: { id: -100660, type: "supergroup", title: "机密群名" },
            from: { id: 93, first_name: "from93" },
            paid_media: {
              star_count: 93093,
              paid_media: [
                {
                  type: "photo",
                  photo: [
                    {
                      file_id: fileId,
                      file_unique_id: id,
                      width: 1,
                      height: 1,
                    },
                  ],
                },
              ],
            },
          },
        },
        tenantId: "local",
        adminUserIds: [],
        nowIso: "2026-11-01T00:00:00.000Z",
      });
      expect(outcome.status).toBe("event");
      if (outcome.status !== "event") {
        throw new Error("expected event");
      }
      const logger = createMemoryLogger();
      const moderator = createMemoryModerator();
      const result = await screenTelegramEvent(outcome.event, {
        logger,
        moderator,
        rateWindow: window,
      });
      return { logger, moderator, result, event: outcome.event };
    };

    const first = await screenPhoto(6210, uniqueId);
    expect(first.result.decision.action).toBe("allow");
    const second = await screenPhoto(6211, uniqueId);
    expect(second.result.decision.action).toBe("allow");
    const third = await screenPhoto(6212, uniqueId);
    expect(third.result.decision.action).toBe("delete");
    expect(third.result.decision.reasons).toContain("repeat");
    expect(third.result.decision.ruleIds).toContain("repeat");
    expect(third.event.message?.text).toBe("");
    expect(third.event.message?.media).toBe("photo");
    expect(third.moderator.deleted).toEqual([
      { tenantId: "local", chatId: "-100660", messageId: "6212" },
    ]);
    expect(JSON.stringify(third.logger.entries)).not.toContain(fileId);
    expect(JSON.stringify(third.logger.entries)).not.toContain(uniqueId);
    expect(JSON.stringify(third.logger.entries)).not.toContain("from93");
    expect(JSON.stringify(third.logger.entries)).not.toContain("93093");
    expect(JSON.stringify(third.result.decision.evidence)).not.toContain(
      fileId,
    );
    expect(JSON.stringify(third.result.decision.evidence)).not.toContain(
      uniqueId,
    );

    const other = await screenPhoto(6213, "OTHERPHOTO93");
    expect(other.result.decision.action).toBe("allow");
    expect(other.moderator.deleted).toEqual([]);
    expect(JSON.stringify(other.event)).not.toContain("OTHERPHOTO93");
    expect(JSON.stringify(other.event)).not.toContain(fileId);
    expect(JSON.stringify(other.logger.entries)).not.toContain(fileId);
  });

  it("deletes an ephemeral short link for the receiver only", async () => {
    const visible = "https://bit.ly/name94";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 6310,
        message: {
          message_id: 0,
          ephemeral_message_id: 63101,
          date: 1761955200,
          chat: { id: -100680, type: "supergroup", title: "机密群名" },
          from: { id: 94, first_name: "from94" },
          receiver_user: { id: 940, first_name: "recv94" },
          text: visible,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
      rateWindow: createMemoryRateWindow(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toContain("short_link");
    expect(result.decision.ruleIds).toContain("links");
    expect(moderator.deleted).toEqual([
      {
        tenantId: "local",
        chatId: "-100680",
        messageId: "63101",
        audienceId: "940",
      },
    ]);
    expect(JSON.stringify(logger.entries)).not.toContain("name94");
    expect(JSON.stringify(logger.entries)).not.toContain("from94");
    expect(JSON.stringify(logger.entries)).not.toContain("recv94");
    expect(JSON.stringify(result.decision.evidence)).not.toContain("name94");

    const plain = await normalizeUpdate({
      update: {
        update_id: 6311,
        message: {
          message_id: 0,
          ephemeral_message_id: 63102,
          date: 1761955200,
          chat: { id: -100681, type: "supergroup" },
          from: { id: 94 },
          receiver_user: { id: 940, first_name: "recv94" },
          text: "今天站会",
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
    const allowed = createMemoryModerator();
    const allow = await screenTelegramEvent(plain.event, {
      moderator: allowed,
      rateWindow: createMemoryRateWindow(),
    });
    expect(allow.decision.action).toBe("allow");
    expect(allowed.deleted).toEqual([]);
    expect(JSON.stringify(plain.event)).not.toContain("recv94");
  });

  it("deletes a custom emoji alternative that carries a short link", async () => {
    const emojiId = "SECRETEMOJI95";
    const screenEmoji = async (
      updateId: number,
      chatId: number,
      message: Record<string, unknown>,
    ) => {
      const outcome = await normalizeUpdate({
        update: {
          update_id: updateId,
          message: {
            message_id: updateId,
            date: 1761955200,
            chat: { id: chatId, type: "supergroup", title: "机密群名" },
            from: { id: 95, first_name: "https://tinyurl.com/from95" },
            ...message,
          },
        },
        tenantId: "local",
        adminUserIds: [],
        nowIso: "2026-11-01T00:00:00.000Z",
      });
      expect(outcome.status).toBe("event");
      if (outcome.status !== "event") {
        throw new Error("expected event");
      }
      const logger = createMemoryLogger();
      const moderator = createMemoryModerator();
      const result = await screenTelegramEvent(outcome.event, {
        logger,
        moderator,
      });
      return { logger, moderator, result, event: outcome.event };
    };
    const emoji = (alternative: string) => ({
      rich_message: {
        blocks: [
          {
            type: "paragraph",
            text: {
              type: "custom_emoji",
              custom_emoji_id: emojiId,
              alternative_text: alternative,
            },
          },
        ],
      },
    });

    const linked = await screenEmoji(
      6410,
      -100690,
      emoji("https://bit.ly/name95"),
    );
    expect(linked.result.decision.action).toBe("delete");
    expect(linked.result.decision.reasons).toContain("short_link");
    expect(linked.result.decision.ruleIds).toContain("links");
    expect(linked.event.message?.text).toBe("https://bit.ly/name95");
    expect(linked.moderator.deleted).toEqual([
      { tenantId: "local", chatId: "-100690", messageId: "6410" },
    ]);
    expect(JSON.stringify(linked.logger.entries)).not.toContain("name95");
    expect(JSON.stringify(linked.logger.entries)).not.toContain(emojiId);
    expect(JSON.stringify(linked.logger.entries)).not.toContain("from95");
    expect(JSON.stringify(linked.result.decision.evidence)).not.toContain(
      "name95",
    );
    expect(JSON.stringify(linked.result.decision.evidence)).not.toContain(
      emojiId,
    );

    const named = await screenEmoji(6411, -100691, emoji("请免费领取礼品"));
    expect(named.result.decision.action).toBe("delete");
    expect(named.result.decision.reasons).toContain("keyword_match");
    expect(JSON.stringify(named.logger.entries)).not.toContain("免费领取");
    expect(JSON.stringify(named.logger.entries)).not.toContain(emojiId);

    const beside = await screenEmoji(6412, -100692, {
      text: "今天站会",
      ...emoji("https://bit.ly/name95"),
    });
    expect(beside.result.decision.action).toBe("delete");
    expect(beside.result.decision.reasons).toContain("short_link");
    expect(beside.event.message?.text).toBe("今天站会");
    expect(JSON.stringify(beside.event)).not.toContain("name95");
    expect(JSON.stringify(beside.event)).not.toContain(emojiId);
    expect(JSON.stringify(beside.logger.entries)).not.toContain("name95");
    expect(JSON.stringify(beside.logger.entries)).not.toContain("from95");

    const decoy = await screenEmoji(6413, -100693, {
      rich_message: {
        blocks: [
          {
            type: "paragraph",
            text: {
              type: "custom_emoji",
              custom_emoji_id: "https://bit.ly/icon95",
              alternative_text: "今天站会",
            },
          },
        ],
      },
    });
    expect(decoy.result.decision.action).toBe("allow");
    expect(decoy.moderator.deleted).toEqual([]);
    expect(JSON.stringify(decoy.event)).not.toContain("bit.ly");
    expect(JSON.stringify(decoy.event)).not.toContain("icon95");
    expect(JSON.stringify(decoy.logger.entries)).not.toContain("from95");
  });

  it("deletes a code block whose language label carries a short link", async () => {
    const screenCode = async (
      updateId: number,
      chatId: number,
      language: string,
      text: string,
    ) => {
      const outcome = await normalizeUpdate({
        update: {
          update_id: updateId,
          message: {
            message_id: updateId,
            date: 1761955200,
            chat: { id: chatId, type: "supergroup", title: "机密群名" },
            from: { id: 96, first_name: "https://tinyurl.com/from96" },
            rich_message: {
              blocks: [{ type: "pre", language, text }],
            },
          },
        },
        tenantId: "local",
        adminUserIds: [],
        nowIso: "2026-11-01T00:00:00.000Z",
      });
      expect(outcome.status).toBe("event");
      if (outcome.status !== "event") {
        throw new Error("expected event");
      }
      const logger = createMemoryLogger();
      const moderator = createMemoryModerator();
      const result = await screenTelegramEvent(outcome.event, {
        logger,
        moderator,
      });
      return { logger, moderator, result, event: outcome.event };
    };

    const linked = await screenCode(
      6510,
      -100700,
      "https://bit.ly/name96",
      "今天站会",
    );
    expect(linked.result.decision.action).toBe("delete");
    expect(linked.result.decision.reasons).toContain("short_link");
    expect(linked.result.decision.ruleIds).toContain("links");
    expect(linked.event.message?.text).toBe("今天站会");
    expect(linked.moderator.deleted).toEqual([
      { tenantId: "local", chatId: "-100700", messageId: "6510" },
    ]);
    expect(JSON.stringify(linked.event)).not.toContain("name96");
    expect(JSON.stringify(linked.logger.entries)).not.toContain("name96");
    expect(JSON.stringify(linked.logger.entries)).not.toContain("from96");
    expect(JSON.stringify(linked.result.decision.evidence)).not.toContain(
      "name96",
    );

    const keyword = await screenCode(
      6511,
      -100701,
      "请免费领取礼品",
      "今天站会",
    );
    expect(keyword.result.decision.action).toBe("allow");
    expect(keyword.moderator.deleted).toEqual([]);
    expect(JSON.stringify(keyword.event)).not.toContain("免费领取");
    expect(JSON.stringify(keyword.logger.entries)).not.toContain("免费领取");

    const code = await screenCode(6512, -100702, "python", "请免费领取礼品");
    expect(code.result.decision.action).toBe("delete");
    expect(code.result.decision.reasons).toContain("keyword_match");
    expect(code.event.message?.text).toBe("请免费领取礼品");
    expect(JSON.stringify(code.logger.entries)).not.toContain("免费领取");
    expect(JSON.stringify(code.event)).not.toContain("python");

    const ordinary = await screenCode(
      6513,
      -100703,
      "https://example.com/ok96",
      "今天站会",
    );
    expect(ordinary.result.decision.action).toBe("allow");
    expect(ordinary.moderator.deleted).toEqual([]);
    expect(JSON.stringify(ordinary.event)).not.toContain("ok96");
    expect(JSON.stringify(ordinary.logger.entries)).not.toContain("from96");
  });

  it("deletes a message whose code entity language carries a short link", async () => {
    const screenEntity = async (
      updateId: number,
      chatId: number,
      language: string,
      text: string,
    ) => {
      const outcome = await normalizeUpdate({
        update: {
          update_id: updateId,
          message: {
            message_id: updateId,
            date: 1761955200,
            chat: { id: chatId, type: "supergroup", title: "机密群名" },
            from: { id: 97, first_name: "https://tinyurl.com/from97" },
            text,
            entities: [{ type: "pre", offset: 0, length: 4, language }],
          },
        },
        tenantId: "local",
        adminUserIds: [],
        nowIso: "2026-11-01T00:00:00.000Z",
      });
      expect(outcome.status).toBe("event");
      if (outcome.status !== "event") {
        throw new Error("expected event");
      }
      const logger = createMemoryLogger();
      const moderator = createMemoryModerator();
      const result = await screenTelegramEvent(outcome.event, {
        logger,
        moderator,
      });
      return { logger, moderator, result, event: outcome.event };
    };

    const linked = await screenEntity(
      6610,
      -100710,
      "https://bit.ly/name97",
      "今天站会",
    );
    expect(linked.result.decision.action).toBe("delete");
    expect(linked.result.decision.reasons).toContain("short_link");
    expect(linked.result.decision.ruleIds).toContain("links");
    expect(linked.event.message?.text).toBe("今天站会");
    expect(linked.moderator.deleted).toEqual([
      { tenantId: "local", chatId: "-100710", messageId: "6610" },
    ]);
    expect(JSON.stringify(linked.event)).not.toContain("name97");
    expect(JSON.stringify(linked.logger.entries)).not.toContain("name97");
    expect(JSON.stringify(linked.logger.entries)).not.toContain("from97");
    expect(JSON.stringify(linked.result.decision.evidence)).not.toContain(
      "name97",
    );

    const keyword = await screenEntity(
      6611,
      -100711,
      "请免费领取礼品",
      "今天站会",
    );
    expect(keyword.result.decision.action).toBe("allow");
    expect(keyword.moderator.deleted).toEqual([]);
    expect(JSON.stringify(keyword.event)).not.toContain("免费领取");
    expect(JSON.stringify(keyword.logger.entries)).not.toContain("免费领取");

    const code = await screenEntity(6612, -100712, "python", "请免费领取礼品");
    expect(code.result.decision.action).toBe("delete");
    expect(code.result.decision.reasons).toContain("keyword_match");
    expect(code.event.message?.text).toBe("请免费领取礼品");
    expect(JSON.stringify(code.logger.entries)).not.toContain("免费领取");
    expect(JSON.stringify(code.event)).not.toContain("python");

    const ordinary = await screenEntity(
      6613,
      -100713,
      "https://example.com/ok97",
      "今天站会",
    );
    expect(ordinary.result.decision.action).toBe("allow");
    expect(ordinary.moderator.deleted).toEqual([]);
    expect(JSON.stringify(ordinary.event)).not.toContain("ok97");
    expect(JSON.stringify(ordinary.logger.entries)).not.toContain("from97");
  });

  it("deletes a telegram proxy link whose server is an address", async () => {
    const screenProxy = async (
      updateId: number,
      chatId: number,
      text: string,
      url?: string,
    ) => {
      const outcome = await normalizeUpdate({
        update: {
          update_id: updateId,
          message: {
            message_id: updateId,
            date: 1761955200,
            chat: { id: chatId, type: "supergroup", title: "机密群名" },
            from: { id: 98, first_name: "https://tinyurl.com/from98" },
            text,
            ...(url === undefined
              ? {}
              : {
                  reply_markup: {
                    inline_keyboard: [[{ text: "代理", url }]],
                  },
                }),
          },
        },
        tenantId: "local",
        adminUserIds: [],
        nowIso: "2026-11-01T00:00:00.000Z",
      });
      expect(outcome.status).toBe("event");
      if (outcome.status !== "event") {
        throw new Error("expected event");
      }
      const logger = createMemoryLogger();
      const moderator = createMemoryModerator();
      const result = await screenTelegramEvent(outcome.event, {
        logger,
        moderator,
      });
      return { logger, moderator, result, event: outcome.event };
    };

    const linked = await screenProxy(
      6710,
      -100720,
      "https://t.me/proxy?server=203.0.113.9&port=4444&secret=SECRET98",
    );
    expect(linked.result.decision.action).toBe("delete");
    expect(linked.result.decision.reasons).toContain("ip_host");
    expect(linked.result.decision.ruleIds).toContain("links");
    expect(linked.moderator.deleted).toEqual([
      { tenantId: "local", chatId: "-100720", messageId: "6710" },
    ]);
    expect(JSON.stringify(linked.logger.entries)).not.toContain("SECRET98");
    expect(JSON.stringify(linked.logger.entries)).not.toContain("4444");
    expect(JSON.stringify(linked.logger.entries)).not.toContain("from98");
    expect(JSON.stringify(linked.result.decision.evidence)).not.toContain(
      "SECRET98",
    );
    expect(JSON.stringify(linked.result.decision.evidence)).toContain(
      "ip_host:203.0.113.9",
    );

    const socks = await screenProxy(
      6711,
      -100721,
      "今天站会",
      "https://t.me/socks?server=https://bit.ly/name98&user=USER98&pass=PASS98",
    );
    expect(socks.result.decision.action).toBe("delete");
    expect(socks.result.decision.reasons).toContain("short_link");
    expect(socks.event.message?.text).toBe("今天站会");
    expect(socks.event.message?.hosts).toEqual(["t.me", "bit.ly"]);
    expect(JSON.stringify(socks.event)).not.toContain("name98");
    expect(JSON.stringify(socks.event)).not.toContain("USER98");
    expect(JSON.stringify(socks.event)).not.toContain("PASS98");
    expect(JSON.stringify(socks.logger.entries)).not.toContain("from98");

    const ordinary = await screenProxy(
      6712,
      -100722,
      "https://t.me/proxy?server=proxy.example.com&secret=SECRET98",
    );
    expect(ordinary.result.decision.action).toBe("allow");
    expect(ordinary.moderator.deleted).toEqual([]);
    expect(JSON.stringify(ordinary.logger.entries)).not.toContain("SECRET98");
    expect(JSON.stringify(ordinary.logger.entries)).not.toContain("from98");

    const foreign = await screenProxy(
      6713,
      -100723,
      "https://example.com/proxy?server=203.0.113.9&secret=SECRET98",
    );
    expect(foreign.result.decision.action).toBe("allow");
    expect(foreign.moderator.deleted).toEqual([]);
  });

  it("deletes a telegram share link whose target is a short link", async () => {
    const screenShare = async (
      updateId: number,
      chatId: number,
      text: string,
      url?: string,
    ) => {
      const outcome = await normalizeUpdate({
        update: {
          update_id: updateId,
          message: {
            message_id: updateId,
            date: 1761955200,
            chat: { id: chatId, type: "supergroup", title: "机密群名" },
            from: { id: 99, first_name: "https://tinyurl.com/from99" },
            text,
            ...(url === undefined
              ? {}
              : {
                  reply_markup: {
                    inline_keyboard: [[{ text: "分享", url }]],
                  },
                }),
          },
        },
        tenantId: "local",
        adminUserIds: [],
        nowIso: "2026-11-01T00:00:00.000Z",
      });
      expect(outcome.status).toBe("event");
      if (outcome.status !== "event") {
        throw new Error("expected event");
      }
      const logger = createMemoryLogger();
      const moderator = createMemoryModerator();
      const result = await screenTelegramEvent(outcome.event, {
        logger,
        moderator,
      });
      return { logger, moderator, result, event: outcome.event };
    };

    const linked = await screenShare(
      6810,
      -100730,
      "https://t.me/share/url?url=https%3A%2F%2Fbit.ly%2Fname99&text=hello",
    );
    expect(linked.result.decision.action).toBe("delete");
    expect(linked.result.decision.reasons).toContain("short_link");
    expect(linked.result.decision.ruleIds).toContain("links");
    expect(linked.moderator.deleted).toEqual([
      { tenantId: "local", chatId: "-100730", messageId: "6810" },
    ]);
    expect(JSON.stringify(linked.logger.entries)).not.toContain("name99");
    expect(JSON.stringify(linked.logger.entries)).not.toContain("from99");
    expect(JSON.stringify(linked.result.decision.evidence)).not.toContain(
      "name99",
    );
    expect(JSON.stringify(linked.result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );

    const preview = await screenShare(
      6811,
      -100731,
      "今天站会",
      "https://t.me/iv?url=http%3A%2F%2F203.0.113.9%2Fpath99&rhash=RHASH99",
    );
    expect(preview.result.decision.action).toBe("delete");
    expect(preview.result.decision.reasons).toContain("ip_host");
    expect(preview.event.message?.text).toBe("今天站会");
    expect(preview.event.message?.hosts).toEqual(["t.me", "203.0.113.9"]);
    expect(JSON.stringify(preview.event)).not.toContain("path99");
    expect(JSON.stringify(preview.event)).not.toContain("RHASH99");
    expect(JSON.stringify(preview.logger.entries)).not.toContain("from99");

    const keyword = await screenShare(
      6812,
      -100732,
      "今天站会",
      "https://t.me/share/url?url=https%3A%2F%2Fexample.com%2Fok99&text=请免费领取礼品",
    );
    expect(keyword.result.decision.action).toBe("allow");
    expect(keyword.moderator.deleted).toEqual([]);
    expect(JSON.stringify(keyword.event)).not.toContain("免费领取");
    expect(JSON.stringify(keyword.event)).not.toContain("ok99");
    expect(JSON.stringify(keyword.logger.entries)).not.toContain("from99");

    const foreign = await screenShare(
      6813,
      -100733,
      "https://example.com/share/url?url=https%3A%2F%2Fbit.ly%2Fname99",
    );
    expect(foreign.result.decision.action).toBe("allow");
    expect(foreign.moderator.deleted).toEqual([]);
  });

  it("deletes a telegram msg link whose text carries an address", async () => {
    const screenMsg = async (
      updateId: number,
      chatId: number,
      text: string,
      url?: string,
    ) => {
      const outcome = await normalizeUpdate({
        update: {
          update_id: updateId,
          message: {
            message_id: updateId,
            date: 1761955200,
            chat: { id: chatId, type: "supergroup", title: "机密群名" },
            from: { id: 100, first_name: "https://tinyurl.com/from100" },
            text,
            ...(url === undefined
              ? {}
              : {
                  reply_markup: {
                    inline_keyboard: [[{ text: "私聊", url }]],
                  },
                }),
          },
        },
        tenantId: "local",
        adminUserIds: [],
        nowIso: "2026-11-01T00:00:00.000Z",
      });
      expect(outcome.status).toBe("event");
      if (outcome.status !== "event") {
        throw new Error("expected event");
      }
      const logger = createMemoryLogger();
      const moderator = createMemoryModerator();
      const result = await screenTelegramEvent(outcome.event, {
        logger,
        moderator,
      });
      return { logger, moderator, result, event: outcome.event };
    };

    const linked = await screenMsg(
      6910,
      -100740,
      "tg://msg?text=https%3A%2F%2F203.0.113.9%2Fpath100&to=durov",
    );
    expect(linked.result.decision.action).toBe("delete");
    expect(linked.result.decision.reasons).toContain("ip_host");
    expect(linked.result.decision.ruleIds).toContain("links");
    expect(linked.moderator.deleted).toEqual([
      { tenantId: "local", chatId: "-100740", messageId: "6910" },
    ]);
    expect(JSON.stringify(linked.logger.entries)).not.toContain("path100");
    expect(JSON.stringify(linked.logger.entries)).not.toContain("from100");
    expect(JSON.stringify(linked.result.decision.evidence)).not.toContain(
      "path100",
    );
    expect(JSON.stringify(linked.result.decision.evidence)).toContain(
      "ip_host:203.0.113.9",
    );

    const code = "code100";
    const invite = await screenMsg(
      6911,
      -100741,
      "今天站会",
      `tg://msg?text=${encodeURIComponent(`tg://join?invite=${code}`)}&to=durov`,
    );
    expect(invite.result.decision.action).toBe("delete");
    expect(invite.result.decision.reasons).toContain("invite");
    expect(invite.event.message?.text).toBe("今天站会");
    expect(invite.event.message?.hosts).toEqual(["t.me"]);
    expect(invite.event.message?.invites).toEqual(["t.me"]);
    expect(JSON.stringify(invite.event)).not.toContain(code);
    expect(JSON.stringify(invite.event)).not.toContain("durov");
    expect(JSON.stringify(invite.logger.entries)).not.toContain("from100");

    const keyword = await screenMsg(
      6912,
      -100742,
      "今天站会",
      "tg://msg?text=请免费领取礼品&to=durov",
    );
    expect(keyword.result.decision.action).toBe("allow");
    expect(keyword.moderator.deleted).toEqual([]);
    expect(JSON.stringify(keyword.event)).not.toContain("免费领取");
    expect(JSON.stringify(keyword.logger.entries)).not.toContain("from100");

    const ordinary = await screenMsg(
      6913,
      -100743,
      "tg://msg?text=https%3A%2F%2Fexample.com%2Fok100&to=198.51.100.20",
    );
    expect(ordinary.result.decision.action).toBe("allow");
    expect(ordinary.moderator.deleted).toEqual([]);
    expect(JSON.stringify(ordinary.logger.entries)).not.toContain("from100");
  });

  it("deletes a giveaway whose required chat title carries a short link", async () => {
    const screenGiveaway = async (
      updateId: number,
      chatId: number,
      message: Record<string, unknown>,
    ) => {
      const outcome = await normalizeUpdate({
        update: {
          update_id: updateId,
          message: {
            message_id: updateId,
            date: 1761955200,
            chat: {
              id: chatId,
              type: "supergroup",
              title: "https://cutt.ly/grp101",
            },
            from: { id: 101, first_name: "https://tinyurl.com/from101" },
            ...message,
          },
        },
        tenantId: "local",
        adminUserIds: [],
        nowIso: "2026-11-01T00:00:00.000Z",
      });
      expect(outcome.status).toBe("event");
      if (outcome.status !== "event") {
        throw new Error("expected event");
      }
      const logger = createMemoryLogger();
      const moderator = createMemoryModerator();
      const result = await screenTelegramEvent(outcome.event, {
        logger,
        moderator,
      });
      return { logger, moderator, result, event: outcome.event };
    };

    const linked = await screenGiveaway(7010, -100750, {
      text: "今天站会",
      giveaway: {
        chats: [
          { id: -100101, type: "channel", title: "https://bit.ly/name101" },
        ],
        winners_selection_date: 1762000000,
        winner_count: 1,
      },
    });
    expect(linked.result.decision.action).toBe("delete");
    expect(linked.result.decision.reasons).toContain("short_link");
    expect(linked.result.decision.ruleIds).toContain("links");
    expect(linked.moderator.deleted).toEqual([
      { tenantId: "local", chatId: "-100750", messageId: "7010" },
    ]);
    expect(linked.event.message?.text).toBe("今天站会");
    expect(JSON.stringify(linked.logger.entries)).not.toContain("name101");
    expect(JSON.stringify(linked.logger.entries)).not.toContain("from101");
    expect(JSON.stringify(linked.logger.entries)).not.toContain("grp101");
    expect(JSON.stringify(linked.result.decision.evidence)).not.toContain(
      "name101",
    );
    expect(JSON.stringify(linked.result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );

    const winners = await screenGiveaway(7011, -100751, {
      text: "今天站会",
      giveaway_winners: {
        chat: {
          id: -100102,
          type: "channel",
          title: "http://203.0.113.9/path101",
        },
        winners_selection_date: 1762000000,
        winner_count: 1,
        winners: [
          {
            id: 10101,
            is_bot: false,
            first_name: "https://tinyurl.com/win101",
          },
        ],
      },
    });
    expect(winners.result.decision.action).toBe("delete");
    expect(winners.result.decision.reasons).toContain("ip_host");
    expect(winners.event.message?.text).toBe("今天站会");
    expect(winners.event.message?.hosts).toEqual(["203.0.113.9"]);
    expect(JSON.stringify(winners.event)).not.toContain("path101");
    expect(JSON.stringify(winners.event)).not.toContain("win101");
    expect(JSON.stringify(winners.logger.entries)).not.toContain("from101");

    const keyword = await screenGiveaway(7012, -100752, {
      text: "今天站会",
      giveaway: {
        chats: [{ id: -100103, type: "channel", title: "请免费领取礼品" }],
        winners_selection_date: 1762000000,
        winner_count: 1,
      },
    });
    expect(keyword.result.decision.action).toBe("allow");
    expect(keyword.moderator.deleted).toEqual([]);
    expect(JSON.stringify(keyword.event)).not.toContain("免费领取");
    expect(JSON.stringify(keyword.logger.entries)).not.toContain("from101");

    const ordinary = await screenGiveaway(7013, -100753, {
      text: "今天站会",
      giveaway: {
        chats: [
          {
            id: -100104,
            type: "channel",
            title: "https://example.com/ok101",
            username: "bit.ly",
          },
        ],
        winners_selection_date: 1762000000,
        winner_count: 1,
      },
    });
    expect(ordinary.result.decision.action).toBe("allow");
    expect(ordinary.moderator.deleted).toEqual([]);
    expect(JSON.stringify(ordinary.event)).not.toContain("ok101");
    expect(JSON.stringify(ordinary.event)).not.toContain("bit.ly");
    expect(JSON.stringify(ordinary.logger.entries)).not.toContain("grp101");
  });

  it("deletes the other telegram share links whose url carries an address", async () => {
    const screenShare = async (
      updateId: number,
      chatId: number,
      text: string,
      url?: string,
    ) => {
      const outcome = await normalizeUpdate({
        update: {
          update_id: updateId,
          message: {
            message_id: updateId,
            date: 1761955200,
            chat: {
              id: chatId,
              type: "supergroup",
              title: "https://cutt.ly/grp102",
            },
            from: { id: 102, first_name: "https://tinyurl.com/from102" },
            text,
            ...(url === undefined
              ? {}
              : {
                  reply_markup: {
                    inline_keyboard: [[{ text: "分享", url }]],
                  },
                }),
          },
        },
        tenantId: "local",
        adminUserIds: [],
        nowIso: "2026-11-01T00:00:00.000Z",
      });
      expect(outcome.status).toBe("event");
      if (outcome.status !== "event") {
        throw new Error("expected event");
      }
      const logger = createMemoryLogger();
      const moderator = createMemoryModerator();
      const result = await screenTelegramEvent(outcome.event, {
        logger,
        moderator,
      });
      return { logger, moderator, result, event: outcome.event };
    };

    const linked = await screenShare(
      7120,
      -100760,
      "https://t.me/share?url=https%3A%2F%2Fbit.ly%2Fname102&text=hello",
    );
    expect(linked.result.decision.action).toBe("delete");
    expect(linked.result.decision.reasons).toContain("short_link");
    expect(linked.result.decision.ruleIds).toContain("links");
    expect(linked.moderator.deleted).toEqual([
      { tenantId: "local", chatId: "-100760", messageId: "7120" },
    ]);
    expect(JSON.stringify(linked.logger.entries)).not.toContain("name102");
    expect(JSON.stringify(linked.logger.entries)).not.toContain("from102");
    expect(JSON.stringify(linked.logger.entries)).not.toContain("grp102");
    expect(JSON.stringify(linked.result.decision.evidence)).not.toContain(
      "name102",
    );
    expect(JSON.stringify(linked.result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );

    const address = await screenShare(
      7121,
      -100761,
      "今天站会",
      "https://t.me/msg/url?url=http%3A%2F%2F203.0.113.9%2Fpath102",
    );
    expect(address.result.decision.action).toBe("delete");
    expect(address.result.decision.reasons).toContain("ip_host");
    expect(address.event.message?.text).toBe("今天站会");
    expect(address.event.message?.hosts).toEqual(["t.me", "203.0.113.9"]);
    expect(JSON.stringify(address.event)).not.toContain("path102");
    expect(JSON.stringify(address.logger.entries)).not.toContain("from102");
    expect(JSON.stringify(address.result.decision.evidence)).toContain(
      "ip_host:203.0.113.9",
    );

    const keyword = await screenShare(
      7122,
      -100762,
      "今天站会",
      "tg://msg?url=https%3A%2F%2Fexample.com%2Fok102&text=请免费领取礼品&to=durov",
    );
    expect(keyword.result.decision.action).toBe("allow");
    expect(keyword.moderator.deleted).toEqual([]);
    expect(keyword.event.message?.text).toBe("今天站会");
    expect(JSON.stringify(keyword.event)).not.toContain("免费领取");
    expect(JSON.stringify(keyword.event)).not.toContain("durov");
    expect(JSON.stringify(keyword.event)).not.toContain("ok102");
    expect(JSON.stringify(keyword.logger.entries)).not.toContain("grp102");

    const username = await screenShare(
      7123,
      -100763,
      "https://t.me/msg?url=https%3A%2F%2Fbit.ly%2Fname102",
    );
    expect(username.result.decision.action).toBe("allow");
    expect(username.moderator.deleted).toEqual([]);
    expect(JSON.stringify(username.result.decision.evidence)).not.toContain(
      "short_link:bit.ly",
    );
    expect(JSON.stringify(username.logger.entries)).not.toContain("from102");
  });

  it("deletes a telegram web proxy link whose server is an address", async () => {
    const screenWebProxy = async (
      updateId: number,
      chatId: number,
      text: string,
      url?: string,
    ) => {
      const outcome = await normalizeUpdate({
        update: {
          update_id: updateId,
          message: {
            message_id: updateId,
            date: 1761955200,
            chat: {
              id: chatId,
              type: "supergroup",
              title: "https://cutt.ly/grp103",
            },
            from: { id: 103, first_name: "https://tinyurl.com/from103" },
            text,
            ...(url === undefined
              ? {}
              : {
                  reply_markup: {
                    inline_keyboard: [[{ text: "网页代理", url }]],
                  },
                }),
          },
        },
        tenantId: "local",
        adminUserIds: [],
        nowIso: "2026-11-01T00:00:00.000Z",
      });
      expect(outcome.status).toBe("event");
      if (outcome.status !== "event") {
        throw new Error("expected event");
      }
      const logger = createMemoryLogger();
      const moderator = createMemoryModerator();
      const result = await screenTelegramEvent(outcome.event, {
        logger,
        moderator,
      });
      return { logger, moderator, result, event: outcome.event };
    };

    const linked = await screenWebProxy(
      7210,
      -100770,
      "https://t.me/webproxy?server=203.0.113.9&secret=SECRET103",
    );
    expect(linked.result.decision.action).toBe("delete");
    expect(linked.result.decision.reasons).toContain("ip_host");
    expect(linked.result.decision.ruleIds).toContain("links");
    expect(linked.moderator.deleted).toEqual([
      { tenantId: "local", chatId: "-100770", messageId: "7210" },
    ]);
    expect(JSON.stringify(linked.logger.entries)).not.toContain("SECRET103");
    expect(JSON.stringify(linked.logger.entries)).not.toContain("from103");
    expect(JSON.stringify(linked.logger.entries)).not.toContain("grp103");
    expect(JSON.stringify(linked.result.decision.evidence)).not.toContain(
      "SECRET103",
    );
    expect(JSON.stringify(linked.result.decision.evidence)).toContain(
      "ip_host:203.0.113.9",
    );

    const shortened = await screenWebProxy(
      7211,
      -100771,
      "今天站会",
      "tg://webproxy?server=bit.ly%2Fname103&secret=SECRET103",
    );
    expect(shortened.result.decision.action).toBe("delete");
    expect(shortened.result.decision.reasons).toContain("short_link");
    expect(shortened.event.message?.text).toBe("今天站会");
    expect(shortened.event.message?.hosts).toEqual(["bit.ly"]);
    expect(JSON.stringify(shortened.event)).not.toContain("name103");
    expect(JSON.stringify(shortened.event)).not.toContain("SECRET103");
    expect(JSON.stringify(shortened.logger.entries)).not.toContain("from103");
    expect(JSON.stringify(shortened.result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );

    const ordinary = await screenWebProxy(
      7212,
      -100772,
      "今天站会",
      "https://t.me/webproxy?server=proxy.example.com&secret=SECRET103",
    );
    expect(ordinary.result.decision.action).toBe("allow");
    expect(ordinary.moderator.deleted).toEqual([]);
    expect(JSON.stringify(ordinary.logger.entries)).not.toContain("SECRET103");
    expect(JSON.stringify(ordinary.logger.entries)).not.toContain("grp103");

    const reserved = await screenWebProxy(
      7213,
      -100773,
      "https://t.me/web?server=203.0.113.9&secret=SECRET103",
    );
    expect(reserved.result.decision.action).toBe("allow");
    expect(reserved.moderator.deleted).toEqual([]);
    expect(JSON.stringify(reserved.result.decision.evidence)).not.toContain(
      "ip_host:203.0.113.9",
    );
    expect(JSON.stringify(reserved.logger.entries)).not.toContain("SECRET103");
  });

  it("deletes a telegram proxy link whose host alias is an address", async () => {
    const screenHost = async (
      updateId: number,
      chatId: number,
      text: string,
      url?: string,
    ) => {
      const outcome = await normalizeUpdate({
        update: {
          update_id: updateId,
          message: {
            message_id: updateId,
            date: 1761955200,
            chat: {
              id: chatId,
              type: "supergroup",
              title: "https://cutt.ly/grp104",
            },
            from: { id: 104, first_name: "https://tinyurl.com/from104" },
            text,
            ...(url === undefined
              ? {}
              : {
                  reply_markup: {
                    inline_keyboard: [[{ text: "代理", url }]],
                  },
                }),
          },
        },
        tenantId: "local",
        adminUserIds: [],
        nowIso: "2026-11-01T00:00:00.000Z",
      });
      expect(outcome.status).toBe("event");
      if (outcome.status !== "event") {
        throw new Error("expected event");
      }
      const logger = createMemoryLogger();
      const moderator = createMemoryModerator();
      const result = await screenTelegramEvent(outcome.event, {
        logger,
        moderator,
      });
      return { logger, moderator, result, event: outcome.event };
    };

    const linked = await screenHost(
      7310,
      -100780,
      "https://t.me/proxy?host=203.0.113.9&port=443&secret=SECRET104",
    );
    expect(linked.result.decision.action).toBe("delete");
    expect(linked.result.decision.reasons).toContain("ip_host");
    expect(linked.result.decision.ruleIds).toContain("links");
    expect(linked.moderator.deleted).toEqual([
      { tenantId: "local", chatId: "-100780", messageId: "7310" },
    ]);
    expect(JSON.stringify(linked.logger.entries)).not.toContain("SECRET104");
    expect(JSON.stringify(linked.logger.entries)).not.toContain("from104");
    expect(JSON.stringify(linked.logger.entries)).not.toContain("grp104");
    expect(JSON.stringify(linked.result.decision.evidence)).not.toContain(
      "SECRET104",
    );
    expect(JSON.stringify(linked.result.decision.evidence)).toContain(
      "ip_host:203.0.113.9",
    );

    const shortened = await screenHost(
      7311,
      -100781,
      "今天站会",
      "tg://webproxy?host=bit.ly%2Fname104&secret=SECRET104",
    );
    expect(shortened.result.decision.action).toBe("delete");
    expect(shortened.result.decision.reasons).toContain("short_link");
    expect(shortened.event.message?.text).toBe("今天站会");
    expect(shortened.event.message?.hosts).toEqual(["bit.ly"]);
    expect(JSON.stringify(shortened.event)).not.toContain("name104");
    expect(JSON.stringify(shortened.event)).not.toContain("SECRET104");
    expect(JSON.stringify(shortened.logger.entries)).not.toContain("from104");
    expect(JSON.stringify(shortened.result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );

    const ordinary = await screenHost(
      7312,
      -100782,
      "今天站会",
      "https://t.me/socks?host=proxy.example.com&port=1080&user=user104&pass=pass104",
    );
    expect(ordinary.result.decision.action).toBe("allow");
    expect(ordinary.moderator.deleted).toEqual([]);
    expect(JSON.stringify(ordinary.logger.entries)).not.toContain("user104");
    expect(JSON.stringify(ordinary.logger.entries)).not.toContain("pass104");
    expect(JSON.stringify(ordinary.logger.entries)).not.toContain("grp104");

    const emptyServer = await screenHost(
      7313,
      -100783,
      "https://t.me/proxy?server=&host=203.0.113.9&port=443&secret=SECRET104",
    );
    expect(emptyServer.result.decision.action).toBe("allow");
    expect(emptyServer.moderator.deleted).toEqual([]);
    expect(JSON.stringify(emptyServer.result.decision.evidence)).not.toContain(
      "ip_host:203.0.113.9",
    );
    expect(JSON.stringify(emptyServer.logger.entries)).not.toContain(
      "SECRET104",
    );
  });

  it("deletes a web proxy link whose empty server falls back to host", async () => {
    const screenHost = async (
      updateId: number,
      chatId: number,
      text: string,
      url?: string,
    ) => {
      const outcome = await normalizeUpdate({
        update: {
          update_id: updateId,
          message: {
            message_id: updateId,
            date: 1761955200,
            chat: {
              id: chatId,
              type: "supergroup",
              title: "https://cutt.ly/grp105",
            },
            from: { id: 105, first_name: "https://tinyurl.com/from105" },
            text,
            ...(url === undefined
              ? {}
              : {
                  reply_markup: {
                    inline_keyboard: [[{ text: "网页代理", url }]],
                  },
                }),
          },
        },
        tenantId: "local",
        adminUserIds: [],
        nowIso: "2026-11-01T00:00:00.000Z",
      });
      expect(outcome.status).toBe("event");
      if (outcome.status !== "event") {
        throw new Error("expected event");
      }
      const logger = createMemoryLogger();
      const moderator = createMemoryModerator();
      const result = await screenTelegramEvent(outcome.event, {
        logger,
        moderator,
      });
      return { logger, moderator, result, event: outcome.event };
    };

    const linked = await screenHost(
      7410,
      -100790,
      "https://t.me/webproxy?server=&host=203.0.113.9&secret=SECRET105",
    );
    expect(linked.result.decision.action).toBe("delete");
    expect(linked.result.decision.reasons).toContain("ip_host");
    expect(linked.result.decision.ruleIds).toContain("links");
    expect(linked.moderator.deleted).toEqual([
      { tenantId: "local", chatId: "-100790", messageId: "7410" },
    ]);
    expect(JSON.stringify(linked.logger.entries)).not.toContain("SECRET105");
    expect(JSON.stringify(linked.logger.entries)).not.toContain("from105");
    expect(JSON.stringify(linked.logger.entries)).not.toContain("grp105");
    expect(JSON.stringify(linked.result.decision.evidence)).not.toContain(
      "SECRET105",
    );
    expect(JSON.stringify(linked.result.decision.evidence)).toContain(
      "ip_host:203.0.113.9",
    );

    const shortened = await screenHost(
      7411,
      -100791,
      "今天站会",
      "tg://webproxy?server=&host=bit.ly%2Fname105&secret=SECRET105",
    );
    expect(shortened.result.decision.action).toBe("delete");
    expect(shortened.result.decision.reasons).toContain("short_link");
    expect(shortened.event.message?.text).toBe("今天站会");
    expect(shortened.event.message?.hosts).toEqual(["bit.ly"]);
    expect(JSON.stringify(shortened.event)).not.toContain("name105");
    expect(JSON.stringify(shortened.event)).not.toContain("SECRET105");
    expect(JSON.stringify(shortened.logger.entries)).not.toContain("from105");
    expect(JSON.stringify(shortened.result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );

    const socks = await screenHost(
      7412,
      -100792,
      "今天站会",
      "https://t.me/socks?server=&host=203.0.113.9&port=1080&user=user105&pass=pass105",
    );
    expect(socks.result.decision.action).toBe("allow");
    expect(socks.moderator.deleted).toEqual([]);
    expect(JSON.stringify(socks.event)).not.toContain("203.0.113.9");
    expect(JSON.stringify(socks.logger.entries)).not.toContain("user105");
    expect(JSON.stringify(socks.logger.entries)).not.toContain("pass105");
    expect(JSON.stringify(socks.logger.entries)).not.toContain("grp105");
  });

  it("deletes a username link whose draft text is an address", async () => {
    const outcome = await normalizeUpdate({
      update: {
        update_id: 7510,
        message: {
          message_id: 7510,
          date: 1761955200,
          chat: {
            id: -100800,
            type: "supergroup",
            title: "https://cutt.ly/grp106",
          },
          from: { id: 106, first_name: "https://tinyurl.com/from106" },
          text: "https://t.me/durov?text=https%3A%2F%2F203.0.113.9%2Fpath106",
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toContain("ip_host");
    expect(result.decision.ruleIds).toContain("links");
    expect(moderator.deleted).toEqual([
      { tenantId: "local", chatId: "-100800", messageId: "7510" },
    ]);
    expect(JSON.stringify(logger.entries)).not.toContain("path106");
    expect(JSON.stringify(logger.entries)).not.toContain("from106");
    expect(JSON.stringify(logger.entries)).not.toContain("grp106");
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "ip_host:203.0.113.9",
    );

    const ordinary = await normalizeUpdate({
      update: {
        update_id: 7511,
        message: {
          message_id: 7511,
          date: 1761955200,
          chat: { id: -100801, type: "supergroup" },
          from: { id: 106 },
          text: "今天站会",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "帖子",
                  url: "https://t.me/durov/123?text=https%3A%2F%2Fbit.ly%2Fname106",
                },
              ],
            ],
          },
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(ordinary.status).toBe("event");
    if (ordinary.status !== "event") {
      return;
    }
    const deleted = await screenTelegramEvent(ordinary.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(deleted.decision.action).toBe("delete");
    expect(deleted.decision.reasons).toContain("short_link");
    expect(ordinary.event.message?.hosts).toEqual(["t.me", "bit.ly"]);
    expect(JSON.stringify(ordinary.event)).not.toContain("name106");
    expect(JSON.stringify(ordinary.event)).not.toContain("durov");
  });

  it("deletes a t.me subdomain whose draft text is an address", async () => {
    const outcome = await normalizeUpdate({
      update: {
        update_id: 7710,
        message: {
          message_id: 7710,
          date: 1761955200,
          chat: {
            id: -100820,
            type: "supergroup",
            title: "https://cutt.ly/grp108",
          },
          from: { id: 108, first_name: "https://tinyurl.com/from108" },
          text: "https://durov.t.me/?text=https%3A%2F%2F203.0.113.8%2Fpath108",
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toContain("ip_host");
    expect(result.decision.ruleIds).toContain("links");
    expect(moderator.deleted).toEqual([
      { tenantId: "local", chatId: "-100820", messageId: "7710" },
    ]);
    expect(JSON.stringify(logger.entries)).not.toContain("path108");
    expect(JSON.stringify(logger.entries)).not.toContain("from108");
    expect(JSON.stringify(logger.entries)).not.toContain("grp108");
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "ip_host:203.0.113.8",
    );

    const thread = await normalizeUpdate({
      update: {
        update_id: 7711,
        message: {
          message_id: 7711,
          date: 1761955200,
          chat: { id: -100821, type: "supergroup" },
          from: { id: 108 },
          text: "今天站会",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "讨论",
                  url: "https://t.me/durov/12/34?text=https%3A%2F%2Fbit.ly%2Fname108",
                },
              ],
            ],
          },
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(thread.status).toBe("event");
    if (thread.status !== "event") {
      return;
    }
    const allowed = await screenTelegramEvent(thread.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(allowed.decision.action).toBe("allow");
    expect(thread.event.message?.hosts).toEqual(["t.me"]);
    expect(JSON.stringify(thread.event)).not.toContain("name108");
    expect(JSON.stringify(thread.event)).not.toContain("bit.ly");
  });

  it("deletes a telegram link whose query name is capitalized", async () => {
    const outcome = await normalizeUpdate({
      update: {
        update_id: 78001,
        message: {
          message_id: 78001,
          date: 1761955200,
          chat: {
            id: -100830,
            type: "supergroup",
            title: "https://cutt.ly/grp109",
          },
          from: { id: 109, first_name: "https://tinyurl.com/from109" },
          text: "tg://resolve?DOMAIN=durov&TEXT=https%3A%2F%2F203.0.113.109%2Fname109",
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toContain("ip_host");
    expect(result.decision.ruleIds).toContain("links");
    expect(moderator.deleted).toEqual([
      { tenantId: "local", chatId: "-100830", messageId: "78001" },
    ]);
    expect(JSON.stringify(logger.entries)).not.toContain("name109");
    expect(JSON.stringify(logger.entries)).not.toContain("durov");
    expect(JSON.stringify(logger.entries)).not.toContain("from109");
    expect(JSON.stringify(logger.entries)).not.toContain("grp109");
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "ip_host:203.0.113.109",
    );

    const proxy = await normalizeUpdate({
      update: {
        update_id: 78002,
        message: {
          message_id: 78002,
          date: 1761955200,
          chat: { id: -100831, type: "supergroup" },
          from: { id: 109 },
          text: "今天站会",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "代理",
                  url: "https://t.me/proxy?SERVER=bit.ly&secret=sek109",
                },
              ],
            ],
          },
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(proxy.status).toBe("event");
    if (proxy.status !== "event") {
      return;
    }
    const deleted = await screenTelegramEvent(proxy.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(deleted.decision.action).toBe("delete");
    expect(deleted.decision.reasons).toContain("short_link");
    expect(proxy.event.message?.text).toBe("今天站会");
    expect(proxy.event.message?.hosts).toEqual(["t.me", "bit.ly"]);
    expect(JSON.stringify(proxy.event)).not.toContain("sek109");

    const blank = await normalizeUpdate({
      update: {
        update_id: 78003,
        message: {
          message_id: 78003,
          date: 1761955200,
          chat: { id: -100832, type: "supergroup" },
          from: { id: 109 },
          text: "今天站会",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "空白",
                  url: "tg://socks?SERVER=%20&HOST=203.0.113.109",
                },
              ],
            ],
          },
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(blank.status).toBe("event");
    if (blank.status !== "event") {
      return;
    }
    const allowed = await screenTelegramEvent(blank.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(allowed.decision.action).toBe("allow");
    expect(blank.event.message?.hosts).toBeUndefined();
    expect(JSON.stringify(blank.event)).not.toContain("203.0.113.109");
  });

  it("deletes a phone link whose draft text is an address", async () => {
    const outcome = await normalizeUpdate({
      update: {
        update_id: 7610,
        message: {
          message_id: 7610,
          date: 1761955200,
          chat: {
            id: -100810,
            type: "supergroup",
            title: "https://cutt.ly/grp107",
          },
          from: { id: 107, first_name: "https://tinyurl.com/from107" },
          text: "https://t.me/+79990001107?text=https%3A%2F%2Fbit.ly%2Fname107",
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toContain("short_link");
    expect(result.decision.ruleIds).toContain("links");
    expect(moderator.deleted).toEqual([
      { tenantId: "local", chatId: "-100810", messageId: "7610" },
    ]);
    expect(JSON.stringify(logger.entries)).not.toContain("name107");
    expect(JSON.stringify(logger.entries)).not.toContain("79990001107");
    expect(JSON.stringify(logger.entries)).not.toContain("from107");
    expect(JSON.stringify(logger.entries)).not.toContain("grp107");
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    expect(JSON.stringify(result.decision.evidence)).not.toContain("invite");

    const bare = await normalizeUpdate({
      update: {
        update_id: 7611,
        message: {
          message_id: 7611,
          date: 1761955200,
          chat: { id: -100811, type: "supergroup" },
          from: { id: 107 },
          text: "今天站会",
          reply_markup: {
            inline_keyboard: [
              [{ text: "电话", url: "https://t.me/+79990001107" }],
            ],
          },
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(bare.status).toBe("event");
    if (bare.status !== "event") {
      return;
    }
    const allowed = await screenTelegramEvent(bare.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(allowed.decision.action).toBe("allow");
    expect(bare.event.message?.hosts).toEqual(["t.me"]);
    expect(bare.event.message?.invites).toBeUndefined();
    expect(JSON.stringify(bare.event)).not.toContain("79990001107");
  });

  it("deletes a short link Android stops on before a trailing hyphen", async () => {
    const path = "offer125";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2167,
        message: {
          message_id: 2167,
          date: 1761955200,
          chat: { id: -1008125, type: "supergroup", title: "机密群名" },
          from: { id: 125, first_name: "https://tinyurl.com/from125" },
          text: `http://bit.ly-/${path}`,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toContain("short_link");
    expect(result.decision.ruleIds).toContain("links");
    expect(moderator.deleted).toEqual([
      { tenantId: "local", chatId: "-1008125", messageId: "2167" },
    ]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("from125");
    expect(dumped).not.toContain("机密群名");

    const ham = await normalizeUpdate({
      update: {
        update_id: 2168,
        message: {
          message_id: 2168,
          date: 1761955200,
          chat: { id: -1008126, type: "supergroup" },
          from: { id: 125 },
          text: "http://bit.ly-@example.com/ok125",
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(ham.status).toBe("event");
    if (ham.status !== "event") {
      return;
    }
    const allowed = await screenTelegramEvent(ham.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(allowed.decision.action).toBe("allow");
    expect(JSON.stringify(allowed.decision.evidence)).not.toContain("bit.ly");
  });

  it("deletes a short link Android stops on before an empty label", async () => {
    const path = "offer126";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2169,
        message: {
          message_id: 2169,
          date: 1761955200,
          chat: { id: -1008127, type: "supergroup", title: "机密群名" },
          from: { id: 126, first_name: "https://tinyurl.com/from126" },
          text: `http://bit.ly../${path}`,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toContain("short_link");
    expect(result.decision.ruleIds).toContain("links");
    expect(moderator.deleted).toEqual([
      { tenantId: "local", chatId: "-1008127", messageId: "2169" },
    ]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("from126");
    expect(dumped).not.toContain("机密群名");

    const joined = await normalizeUpdate({
      update: {
        update_id: 2170,
        message: {
          message_id: 2170,
          date: 1761955200,
          chat: { id: -1008128, type: "supergroup" },
          from: { id: 126 },
          text: "http://bit.ly.evil.com/keep",
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(joined.status).toBe("event");
    if (joined.status !== "event") {
      return;
    }
    const allowed = await screenTelegramEvent(joined.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(allowed.decision.action).toBe("allow");
    expect(JSON.stringify(allowed.decision.evidence)).not.toContain("bit.ly");
  });

  it("deletes a short link Android stops on before an overlong port", async () => {
    const path = "offer127";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2171,
        message: {
          message_id: 2171,
          date: 1761955200,
          chat: { id: -1008129, type: "supergroup", title: "机密群名" },
          from: { id: 127, first_name: "https://tinyurl.com/from127" },
          text: `http://bit.ly:999999/${path}`,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toContain("short_link");
    expect(result.decision.ruleIds).toContain("links");
    expect(moderator.deleted).toEqual([
      { tenantId: "local", chatId: "-1008129", messageId: "2171" },
    ]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("999999");
    expect(dumped).not.toContain("from127");
    expect(dumped).not.toContain("机密群名");

    const plain = await normalizeUpdate({
      update: {
        update_id: 2172,
        message: {
          message_id: 2172,
          date: 1761955200,
          chat: { id: -1008130, type: "supergroup" },
          from: { id: 127 },
          text: "http://example.com:999999/ok",
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
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(allowed.decision.action).toBe("allow");
    expect(JSON.stringify(allowed.decision.evidence)).not.toContain("999999");
  });

  it("deletes a short link Android stops on before a 64 character label", async () => {
    const over = "a".repeat(64);
    const path = "offer128";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2173,
        message: {
          message_id: 2173,
          date: 1761955200,
          chat: { id: -1008131, type: "supergroup", title: "机密群名" },
          from: { id: 128, first_name: "https://tinyurl.com/from128" },
          text: `http://bit.ly.${over}/${path}`,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toContain("short_link");
    expect(result.decision.ruleIds).toContain("links");
    expect(moderator.deleted).toEqual([
      { tenantId: "local", chatId: "-1008131", messageId: "2173" },
    ]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain(over);
    expect(dumped).not.toContain("from128");
    expect(dumped).not.toContain("机密群名");

    const exact = "b".repeat(63);
    const fitted = await normalizeUpdate({
      update: {
        update_id: 2174,
        message: {
          message_id: 2174,
          date: 1761955200,
          chat: { id: -1008132, type: "supergroup" },
          from: { id: 128 },
          text: `http://bit.ly.${exact}.example/keep`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(fitted.status).toBe("event");
    if (fitted.status !== "event") {
      return;
    }
    const allowed = await screenTelegramEvent(fitted.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(allowed.decision.action).toBe("allow");
    expect(JSON.stringify(allowed.decision.evidence)).not.toContain("bit.ly");
  });

  it("deletes a short link Android stops on before an underscore that cannot finish a label", async () => {
    const blocked = "a".repeat(62);
    const path = "offer129";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2175,
        message: {
          message_id: 2175,
          date: 1761955200,
          chat: { id: -1008133, type: "supergroup", title: "机密群名" },
          from: { id: 129, first_name: "https://tinyurl.com/from129" },
          text: `http://bit.ly.${blocked}_b/${path}`,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toContain("short_link");
    expect(result.decision.ruleIds).toContain("links");
    expect(moderator.deleted).toEqual([
      { tenantId: "local", chatId: "-1008133", messageId: "2175" },
    ]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain(blocked);
    expect(dumped).not.toContain("from129");
    expect(dumped).not.toContain("机密群名");

    const inside = await normalizeUpdate({
      update: {
        update_id: 2176,
        message: {
          message_id: 2176,
          date: 1761955200,
          chat: { id: -1008134, type: "supergroup" },
          from: { id: 129 },
          text: "http://bit.ly_foo/keep",
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(inside.status).toBe("event");
    if (inside.status !== "event") {
      return;
    }
    const allowed = await screenTelegramEvent(inside.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(allowed.decision.action).toBe("allow");
    expect(JSON.stringify(allowed.decision.evidence)).not.toContain("bit.ly");
  });

  it("deletes a short link Android opens when a gap ends the link", async () => {
    const path = "offer130";
    const tail = "tail130.example";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2177,
        message: {
          message_id: 2177,
          date: 1761955200,
          chat: { id: -1008135, type: "supergroup", title: "机密群名" },
          from: { id: 130, first_name: "https://tinyurl.com/from130" },
          text: `http://bit.ly\t${tail}/${path}`,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toContain("short_link");
    expect(result.decision.ruleIds).toContain("links");
    expect(moderator.deleted).toEqual([
      { tenantId: "local", chatId: "-1008135", messageId: "2177" },
    ]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain(tail);
    expect(dumped).not.toContain("from130");
    expect(dumped).not.toContain("机密群名");

    const plain = await normalizeUpdate({
      update: {
        update_id: 2178,
        message: {
          message_id: 2178,
          date: 1761955200,
          chat: { id: -1008136, type: "supergroup" },
          from: { id: 130 },
          text: `http://example.com\t${tail}/ok`,
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
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(allowed.decision.action).toBe("allow");
    expect(JSON.stringify(allowed.decision.evidence)).not.toContain("bit.ly");
  });

  it("deletes a short link Android opens when a percent-encoded tail follows", async () => {
    const path = "offer131";
    const tail = "tail131.example";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2179,
        message: {
          message_id: 2179,
          date: 1761955200,
          chat: { id: -1008137, type: "supergroup", title: "机密群名" },
          from: { id: 131, first_name: "https://tinyurl.com/from131" },
          text: `http://bit.ly%2E${tail}/${path}`,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toContain("short_link");
    expect(result.decision.ruleIds).toContain("links");
    expect(moderator.deleted).toEqual([
      { tenantId: "local", chatId: "-1008137", messageId: "2179" },
    ]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain(tail);
    expect(dumped).not.toContain("%2E");
    expect(dumped).not.toContain("from131");
    expect(dumped).not.toContain("机密群名");

    const plain = await normalizeUpdate({
      update: {
        update_id: 2180,
        message: {
          message_id: 2180,
          date: 1761955200,
          chat: { id: -1008138, type: "supergroup" },
          from: { id: 131 },
          text: `http://example.com%2E${tail}/ok`,
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
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(allowed.decision.action).toBe("allow");
    expect(JSON.stringify(allowed.decision.evidence)).not.toContain("bit.ly");
  });

  it("deletes a short link Android opens when a supplementary letter follows", async () => {
    const path = "offer132";
    const tail = "tail132.example";
    const greek = "\u{10140}";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2181,
        message: {
          message_id: 2181,
          date: 1761955200,
          chat: { id: -1008139, type: "supergroup", title: "机密群名" },
          from: { id: 132, first_name: "https://tinyurl.com/from132" },
          text: `http://bit.ly${greek}${tail}/${path}`,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toContain("short_link");
    expect(result.decision.ruleIds).toContain("links");
    expect(moderator.deleted).toEqual([
      { tenantId: "local", chatId: "-1008139", messageId: "2181" },
    ]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain(tail);
    expect(dumped).not.toContain(greek);
    expect(dumped).not.toContain("from132");
    expect(dumped).not.toContain("机密群名");

    const plain = await normalizeUpdate({
      update: {
        update_id: 2182,
        message: {
          message_id: 2182,
          date: 1761955200,
          chat: { id: -1008140, type: "supergroup" },
          from: { id: 132 },
          text: `http://example.com${greek}${tail}/ok`,
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
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(allowed.decision.action).toBe("allow");
    expect(JSON.stringify(allowed.decision.evidence)).not.toContain("bit.ly");
  });

  it("deletes a short link Android opens when @ cannot finish user info", async () => {
    const path = "offer133";
    const tail = "tail133.example";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2183,
        message: {
          message_id: 2183,
          date: 1761955200,
          chat: { id: -1008141, type: "supergroup", title: "机密群名" },
          from: { id: 133, first_name: "https://tinyurl.com/from133" },
          text: `http://bit.ly@.${tail}/${path}`,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toContain("short_link");
    expect(result.decision.ruleIds).toContain("links");
    expect(moderator.deleted).toEqual([
      { tenantId: "local", chatId: "-1008141", messageId: "2183" },
    ]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain(tail);
    expect(dumped).not.toContain("from133");
    expect(dumped).not.toContain("机密群名");

    const plain = await normalizeUpdate({
      update: {
        update_id: 2184,
        message: {
          message_id: 2184,
          date: 1761955200,
          chat: { id: -1008142, type: "supergroup" },
          from: { id: 133 },
          text: `http://example.com@.${tail}/ok`,
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
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(allowed.decision.action).toBe("allow");
    expect(JSON.stringify(allowed.decision.evidence)).not.toContain("bit.ly");
  });

  it("deletes a short link Android opens after a character the path cannot include", async () => {
    const path = "offer134";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2185,
        message: {
          message_id: 2185,
          date: 1761955200,
          chat: { id: -1008143, type: "supergroup", title: "机密群名" },
          from: { id: 134, first_name: "https://tinyurl.com/from134" },
          text: `http://example.com|http://bit.ly/${path}`,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toContain("short_link");
    expect(result.decision.ruleIds).toContain("links");
    expect(moderator.deleted).toEqual([
      { tenantId: "local", chatId: "-1008143", messageId: "2185" },
    ]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("from134");
    expect(dumped).not.toContain("机密群名");

    const plain = await normalizeUpdate({
      update: {
        update_id: 2186,
        message: {
          message_id: 2186,
          date: 1761955200,
          chat: { id: -1008144, type: "supergroup" },
          from: { id: 134 },
          text: "http://example.com|http://news.example/ok",
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
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(allowed.decision.action).toBe("allow");
    expect(JSON.stringify(allowed.decision.evidence)).not.toContain("bit.ly");
  });

  it("deletes a short link Android opens after an unfinished percent", async () => {
    const path = "offer135";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2187,
        message: {
          message_id: 2187,
          date: 1761955200,
          chat: { id: -1008145, type: "supergroup", title: "机密群名" },
          from: { id: 135, first_name: "https://tinyurl.com/from135" },
          text: `http://example.com%http://bit.ly/${path}`,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toContain("short_link");
    expect(result.decision.ruleIds).toContain("links");
    expect(moderator.deleted).toEqual([
      { tenantId: "local", chatId: "-1008145", messageId: "2187" },
    ]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("from135");
    expect(dumped).not.toContain("机密群名");

    const plain = await normalizeUpdate({
      update: {
        update_id: 2188,
        message: {
          message_id: 2188,
          date: 1761955200,
          chat: { id: -1008146, type: "supergroup" },
          from: { id: 135 },
          text: `http://example.com/%20http://bit.ly/${path}`,
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
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(allowed.decision.action).toBe("allow");
    expect(JSON.stringify(allowed.decision.evidence)).not.toContain("bit.ly");
  });

  it("deletes a short link Android opens after a character the path class omits", async () => {
    const path = "offer136";
    const emoji = "\u{1F600}";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2189,
        message: {
          message_id: 2189,
          date: 1761955200,
          chat: { id: -1008147, type: "supergroup", title: "机密群名" },
          from: { id: 136, first_name: "https://tinyurl.com/from136" },
          text: `http://example.com${emoji}http://bit.ly/${path}`,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toContain("short_link");
    expect(result.decision.ruleIds).toContain("links");
    expect(moderator.deleted).toEqual([
      { tenantId: "local", chatId: "-1008147", messageId: "2189" },
    ]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("from136");
    expect(dumped).not.toContain("机密群名");

    const plain = await normalizeUpdate({
      update: {
        update_id: 2190,
        message: {
          message_id: 2190,
          date: 1761955200,
          chat: { id: -1008148, type: "supergroup" },
          from: { id: 136 },
          text: `http://example.com/点击http://bit.ly/${path}`,
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
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(allowed.decision.action).toBe("allow");
    expect(JSON.stringify(allowed.decision.evidence)).not.toContain("bit.ly");
  });

  it("deletes a short link Android opens after punctuation that ends the host", async () => {
    const path = "offer137";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2191,
        message: {
          message_id: 2191,
          date: 1761955200,
          chat: { id: -1008149, type: "supergroup", title: "机密群名" },
          from: { id: 137, first_name: "https://tinyurl.com/from137" },
          text: `http://example.com!http://bit.ly/${path}`,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toContain("short_link");
    expect(result.decision.ruleIds).toContain("links");
    expect(moderator.deleted).toEqual([
      { tenantId: "local", chatId: "-1008149", messageId: "2191" },
    ]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("from137");
    expect(dumped).not.toContain("机密群名");

    const plain = await normalizeUpdate({
      update: {
        update_id: 2192,
        message: {
          message_id: 2192,
          date: 1761955200,
          chat: { id: -1008150, type: "supergroup" },
          from: { id: 137 },
          text: `http://example.com/!http://bit.ly/${path}`,
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
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(allowed.decision.action).toBe("allow");
    expect(JSON.stringify(allowed.decision.evidence)).not.toContain("bit.ly");
  });

  it("deletes a short link Android opens after a bare domain ends", async () => {
    const path = "offer138";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2193,
        message: {
          message_id: 2193,
          date: 1761955200,
          chat: { id: -1008151, type: "supergroup", title: "机密群名" },
          from: { id: 138, first_name: "https://tinyurl.com/from138" },
          text: `www.example.com-http://bit.ly/${path}`,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toContain("short_link");
    expect(result.decision.ruleIds).toContain("links");
    expect(moderator.deleted).toEqual([
      { tenantId: "local", chatId: "-1008151", messageId: "2193" },
    ]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("from138");
    expect(dumped).not.toContain("机密群名");

    const plain = await normalizeUpdate({
      update: {
        update_id: 2194,
        message: {
          message_id: 2194,
          date: 1761955200,
          chat: { id: -1008152, type: "supergroup" },
          from: { id: 138 },
          text: `www.example.com/!http://bit.ly/${path}`,
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
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(allowed.decision.action).toBe("allow");
    expect(JSON.stringify(allowed.decision.evidence)).not.toContain("bit.ly");
  });

  it("deletes a short link Android opens after a dot that does not start a label", async () => {
    const path = "offer139";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2195,
        message: {
          message_id: 2195,
          date: 1761955200,
          chat: { id: -1008153, type: "supergroup", title: "机密群名" },
          from: { id: 139, first_name: "https://tinyurl.com/from139" },
          text: `http://example.com..http://bit.ly/${path}`,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toContain("short_link");
    expect(result.decision.ruleIds).toContain("links");
    expect(moderator.deleted).toEqual([
      { tenantId: "local", chatId: "-1008153", messageId: "2195" },
    ]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("from139");
    expect(dumped).not.toContain("机密群名");

    const plain = await normalizeUpdate({
      update: {
        update_id: 2196,
        message: {
          message_id: 2196,
          date: 1761955200,
          chat: { id: -1008154, type: "supergroup" },
          from: { id: 139 },
          text: `http://example.com./http://bit.ly/${path}`,
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
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(allowed.decision.action).toBe("allow");
    expect(JSON.stringify(allowed.decision.evidence)).not.toContain("bit.ly");
  });

  it("deletes a short link Android opens after user info that is too long", async () => {
    const path = "offer140";
    const user = "a".repeat(65);
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2197,
        message: {
          message_id: 2197,
          date: 1761955200,
          chat: { id: -1008155, type: "supergroup", title: "机密群名" },
          from: { id: 140, first_name: "https://tinyurl.com/from140" },
          text: `http://${user}@http://bit.ly/${path}`,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toContain("short_link");
    expect(result.decision.ruleIds).toContain("links");
    expect(moderator.deleted).toEqual([
      { tenantId: "local", chatId: "-1008155", messageId: "2197" },
    ]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain(user);
    expect(dumped).not.toContain("from140");
    expect(dumped).not.toContain("机密群名");

    const plain = await normalizeUpdate({
      update: {
        update_id: 2198,
        message: {
          message_id: 2198,
          date: 1761955200,
          chat: { id: -1008156, type: "supergroup" },
          from: { id: 140 },
          text: `http://${"a".repeat(64)}@http://bit.ly/${path}`,
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
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(allowed.decision.action).toBe("allow");
    expect(JSON.stringify(allowed.decision.evidence)).not.toContain("bit.ly");
  });

  it("deletes a short link Android opens after a label that does not fit", async () => {
    const path = "offer141";
    const label = "a".repeat(59);
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2199,
        message: {
          message_id: 2199,
          date: 1761955200,
          chat: { id: -1008157, type: "supergroup", title: "机密群名" },
          from: { id: 141, first_name: "https://tinyurl.com/from141" },
          text: `http://${label}-http://bit.ly/${path}`,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toContain("short_link");
    expect(result.decision.ruleIds).toContain("links");
    expect(moderator.deleted).toEqual([
      { tenantId: "local", chatId: "-1008157", messageId: "2199" },
    ]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain(label);
    expect(dumped).not.toContain("from141");
    expect(dumped).not.toContain("机密群名");

    const plain = await normalizeUpdate({
      update: {
        update_id: 2200,
        message: {
          message_id: 2200,
          date: 1761955200,
          chat: { id: -1008158, type: "supergroup" },
          from: { id: 141 },
          text: `http://${"a".repeat(58)}-http://bit.ly/${path}`,
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
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(allowed.decision.action).toBe("allow");
    expect(JSON.stringify(allowed.decision.evidence)).not.toContain("bit.ly");
  });

  it("deletes a bare IPv4 Android opens", async () => {
    const path = "offer142";
    const address = "203.0.113.142";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2201,
        message: {
          message_id: 2201,
          date: 1761955200,
          chat: { id: -1008159, type: "supergroup", title: "机密群名" },
          from: { id: 142, first_name: "https://tinyurl.com/from142" },
          text: `${address}/${path}`,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toContain("ip_host");
    expect(result.decision.ruleIds).toContain("links");
    expect(moderator.deleted).toEqual([
      { tenantId: "local", chatId: "-1008159", messageId: "2201" },
    ]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      `ip_host:${address}`,
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("from142");
    expect(dumped).not.toContain("机密群名");

    const plain = await normalizeUpdate({
      update: {
        update_id: 2202,
        message: {
          message_id: 2202,
          date: 1761955200,
          chat: { id: -1008160, type: "supergroup" },
          from: { id: 142 },
          text: `${address}.example.com/${path}`,
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
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(allowed.decision.action).toBe("allow");
    expect(JSON.stringify(allowed.decision.evidence)).not.toContain(address);
  });

  it("deletes a short link Android opens after tg: without slashes", async () => {
    const path = "offer143";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2203,
        message: {
          message_id: 2203,
          date: 1761955200,
          chat: { id: -1008161, type: "supergroup", title: "机密群名" },
          from: { id: 143, first_name: "https://tinyurl.com/from143" },
          text: `tg:http://bit.ly/${path}`,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toContain("short_link");
    expect(result.decision.ruleIds).toContain("links");
    expect(moderator.deleted).toEqual([
      { tenantId: "local", chatId: "-1008161", messageId: "2203" },
    ]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("from143");
    expect(dumped).not.toContain("机密群名");

    const plain = await normalizeUpdate({
      update: {
        update_id: 2204,
        message: {
          message_id: 2204,
          date: 1761955200,
          chat: { id: -1008162, type: "supergroup" },
          from: { id: 143 },
          text: `tg://http://bit.ly/${path}`,
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
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(allowed.decision.action).toBe("allow");
    expect(JSON.stringify(allowed.decision.evidence)).not.toContain("bit.ly");
  });

  it("allows a bare domain whose question mark Android keeps", async () => {
    const path = "offer144";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2205,
        message: {
          message_id: 2205,
          date: 1761955200,
          chat: { id: -1008163, type: "supergroup", title: "机密群名" },
          from: { id: 144, first_name: "Ada" },
          text: `example.com?http://bit.ly/${path}`,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("allow");
    expect(moderator.deleted).toEqual([]);
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain("bit.ly");
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const short = await normalizeUpdate({
      update: {
        update_id: 2206,
        message: {
          message_id: 2206,
          date: 1761955200,
          chat: { id: -1008164, type: "supergroup", title: "机密群名" },
          from: { id: 144, first_name: "https://tinyurl.com/from144" },
          text: `bit.ly?http://t.co/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(short.status).toBe("event");
    if (short.status !== "event") {
      return;
    }
    const shortLogger = createMemoryLogger();
    const deleted = await screenTelegramEvent(short.event, {
      logger: shortLogger,
      moderator: createMemoryModerator(),
    });
    expect(deleted.decision.action).toBe("delete");
    expect(deleted.decision.reasons).toContain("short_link");
    expect(JSON.stringify(deleted.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    expect(JSON.stringify(deleted.decision.evidence)).not.toContain("t.co");
    const deletedDump = JSON.stringify({
      result: deleted,
      logs: shortLogger.entries,
    });
    expect(deletedDump).not.toContain(path);
    expect(deletedDump).not.toContain("from144");
    expect(deletedDump).not.toContain("机密群名");
  });

  it("allows a path apostrophe Android keeps inside one link", async () => {
    const path = "offer145";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2207,
        message: {
          message_id: 2207,
          date: 1761955200,
          chat: { id: -1008165, type: "supergroup", title: "机密群名" },
          from: { id: 145, first_name: "Ada" },
          text: `http://example.com/'http://bit.ly/${path}`,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("allow");
    expect(moderator.deleted).toEqual([]);
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain("bit.ly");
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const split = await normalizeUpdate({
      update: {
        update_id: 2208,
        message: {
          message_id: 2208,
          date: 1761955200,
          chat: { id: -1008166, type: "supergroup", title: "机密群名" },
          from: { id: 145, first_name: "https://tinyurl.com/from145" },
          text: `example.com'bit.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(split.status).toBe("event");
    if (split.status !== "event") {
      return;
    }
    const splitLogger = createMemoryLogger();
    const deleted = await screenTelegramEvent(split.event, {
      logger: splitLogger,
      moderator: createMemoryModerator(),
    });
    expect(deleted.decision.action).toBe("delete");
    expect(deleted.decision.reasons).toContain("short_link");
    expect(JSON.stringify(deleted.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const deletedDump = JSON.stringify({
      result: deleted,
      logs: splitLogger.entries,
    });
    expect(deletedDump).not.toContain(path);
    expect(deletedDump).not.toContain("from145");
    expect(deletedDump).not.toContain("机密群名");
  });

  it("allows a label space Android keeps inside one link", async () => {
    const path = "offer146";
    const ogham = "\u1680";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2209,
        message: {
          message_id: 2209,
          date: 1761955200,
          chat: { id: -1008167, type: "supergroup", title: "机密群名" },
          from: { id: 146, first_name: "Ada" },
          text: `http://example.com/${ogham}http://bit.ly/${path}`,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("allow");
    expect(moderator.deleted).toEqual([]);
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain("bit.ly");
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const split = await normalizeUpdate({
      update: {
        update_id: 2210,
        message: {
          message_id: 2210,
          date: 1761955200,
          chat: { id: -1008168, type: "supergroup", title: "机密群名" },
          from: { id: 146, first_name: "https://tinyurl.com/from146" },
          text: `example.com${ogham}http://bit.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(split.status).toBe("event");
    if (split.status !== "event") {
      return;
    }
    const splitLogger = createMemoryLogger();
    const deleted = await screenTelegramEvent(split.event, {
      logger: splitLogger,
      moderator: createMemoryModerator(),
    });
    expect(deleted.decision.action).toBe("delete");
    expect(deleted.decision.reasons).toContain("short_link");
    expect(JSON.stringify(deleted.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const deletedDump = JSON.stringify({
      result: deleted,
      logs: splitLogger.entries,
    });
    expect(deletedDump).not.toContain(path);
    expect(deletedDump).not.toContain("from146");
    expect(deletedDump).not.toContain("机密群名");
  });

  it("allows a label character Android keeps on the host", async () => {
    const path = "offer147";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2211,
        message: {
          message_id: 2211,
          date: 1761955200,
          chat: { id: -1008169, type: "supergroup", title: "机密群名" },
          from: { id: 147, first_name: "Ada" },
          text: "http://bit.ly，广告",
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("allow");
    expect(moderator.deleted).toEqual([]);
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain("bit.ly");
    expect(dumped).not.toContain("机密群名");

    const split = await normalizeUpdate({
      update: {
        update_id: 2212,
        message: {
          message_id: 2212,
          date: 1761955200,
          chat: { id: -1008170, type: "supergroup", title: "机密群名" },
          from: { id: 147, first_name: "https://tinyurl.com/from147" },
          text: `http://bit\u200B.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(split.status).toBe("event");
    if (split.status !== "event") {
      return;
    }
    const splitLogger = createMemoryLogger();
    const deleted = await screenTelegramEvent(split.event, {
      logger: splitLogger,
      moderator: createMemoryModerator(),
    });
    expect(deleted.decision.action).toBe("delete");
    expect(deleted.decision.reasons).toContain("short_link");
    expect(JSON.stringify(deleted.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const deletedDump = JSON.stringify({
      result: deleted,
      logs: splitLogger.entries,
    });
    expect(deletedDump).not.toContain(path);
    expect(deletedDump).not.toContain("from147");
    expect(deletedDump).not.toContain("机密群名");
  });

  it("allows a schemed dot Android keeps and deletes the www dot it drops", async () => {
    const path = "offer148";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2213,
        message: {
          message_id: 2213,
          date: 1761955200,
          chat: { id: -1008171, type: "supergroup", title: "机密群名" },
          from: { id: 148, first_name: "Ada" },
          text: `http://www.example.com./http://bit.ly/${path}`,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("allow");
    expect(moderator.deleted).toEqual([]);
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain("bit.ly");
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const split = await normalizeUpdate({
      update: {
        update_id: 2214,
        message: {
          message_id: 2214,
          date: 1761955200,
          chat: { id: -1008172, type: "supergroup", title: "机密群名" },
          from: { id: 148, first_name: "https://tinyurl.com/from148" },
          text: `www.example.com./http://bit.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(split.status).toBe("event");
    if (split.status !== "event") {
      return;
    }
    const splitLogger = createMemoryLogger();
    const deleted = await screenTelegramEvent(split.event, {
      logger: splitLogger,
      moderator: createMemoryModerator(),
    });
    expect(deleted.decision.action).toBe("delete");
    expect(deleted.decision.reasons).toContain("short_link");
    expect(JSON.stringify(deleted.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const deletedDump = JSON.stringify({
      result: deleted,
      logs: splitLogger.entries,
    });
    expect(deletedDump).not.toContain(path);
    expect(deletedDump).not.toContain("from148");
    expect(deletedDump).not.toContain("机密群名");
  });

  it("allows a schemed suffix Android keeps and deletes the bare suffix it splits", async () => {
    const path = "offer149";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2215,
        message: {
          message_id: 2215,
          date: 1761955200,
          chat: { id: -1008173, type: "supergroup", title: "机密群名" },
          from: { id: 149, first_name: "Ada" },
          text: `http://foo.example/http://bit.ly/${path}`,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("allow");
    expect(moderator.deleted).toEqual([]);
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain("bit.ly");
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const split = await normalizeUpdate({
      update: {
        update_id: 2216,
        message: {
          message_id: 2216,
          date: 1761955200,
          chat: { id: -1008174, type: "supergroup", title: "机密群名" },
          from: { id: 149, first_name: "https://tinyurl.com/from149" },
          text: `foo.example/http://bit.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(split.status).toBe("event");
    if (split.status !== "event") {
      return;
    }
    const splitLogger = createMemoryLogger();
    const deleted = await screenTelegramEvent(split.event, {
      logger: splitLogger,
      moderator: createMemoryModerator(),
    });
    expect(deleted.decision.action).toBe("delete");
    expect(deleted.decision.reasons).toContain("short_link");
    expect(JSON.stringify(deleted.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const deletedDump = JSON.stringify({
      result: deleted,
      logs: splitLogger.entries,
    });
    expect(deletedDump).not.toContain(path);
    expect(deletedDump).not.toContain("from149");
    expect(deletedDump).not.toContain("机密群名");
  });

  it("allows an underscore Android leaves inside a bare label and deletes the trailing underscore it splits", async () => {
    const path = "offer150";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2217,
        message: {
          message_id: 2217,
          date: 1761955200,
          chat: { id: -1008175, type: "supergroup", title: "机密群名" },
          from: { id: 150, first_name: "Ada" },
          text: `foo_bar.com/http://bit.ly/${path}`,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("allow");
    expect(moderator.deleted).toEqual([]);
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain("bit.ly");
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const split = await normalizeUpdate({
      update: {
        update_id: 2218,
        message: {
          message_id: 2218,
          date: 1761955200,
          chat: { id: -1008176, type: "supergroup", title: "机密群名" },
          from: { id: 150, first_name: "https://tinyurl.com/from150" },
          text: `foo_.com/http://bit.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(split.status).toBe("event");
    if (split.status !== "event") {
      return;
    }
    const splitLogger = createMemoryLogger();
    const deleted = await screenTelegramEvent(split.event, {
      logger: splitLogger,
      moderator: createMemoryModerator(),
    });
    expect(deleted.decision.action).toBe("delete");
    expect(deleted.decision.reasons).toContain("short_link");
    expect(JSON.stringify(deleted.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const deletedDump = JSON.stringify({
      result: deleted,
      logs: splitLogger.entries,
    });
    expect(deletedDump).not.toContain(path);
    expect(deletedDump).not.toContain("from150");
    expect(deletedDump).not.toContain("机密群名");
  });

  it("allows a bridged label Android keeps and deletes the trailing mark it splits", async () => {
    const path = "offer151";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2219,
        message: {
          message_id: 2219,
          date: 1761955200,
          chat: { id: -1008177, type: "supergroup", title: "机密群名" },
          from: { id: 151, first_name: "Ada" },
          text: `例_foo.com/http://bit.ly/${path}`,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("allow");
    expect(moderator.deleted).toEqual([]);
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain("bit.ly");
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const split = await normalizeUpdate({
      update: {
        update_id: 2220,
        message: {
          message_id: 2220,
          date: 1761955200,
          chat: { id: -1008178, type: "supergroup", title: "机密群名" },
          from: { id: 151, first_name: "https://tinyurl.com/from151" },
          text: `例_.com/http://bit.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(split.status).toBe("event");
    if (split.status !== "event") {
      return;
    }
    const splitLogger = createMemoryLogger();
    const deleted = await screenTelegramEvent(split.event, {
      logger: splitLogger,
      moderator: createMemoryModerator(),
    });
    expect(deleted.decision.action).toBe("delete");
    expect(deleted.decision.reasons).toContain("short_link");
    expect(JSON.stringify(deleted.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const deletedDump = JSON.stringify({
      result: deleted,
      logs: splitLogger.entries,
    });
    expect(deletedDump).not.toContain(path);
    expect(deletedDump).not.toContain("from151");
    expect(deletedDump).not.toContain("机密群名");
  });

  it("allows a schemed letter Android keeps and deletes the bare letter it splits", async () => {
    const path = "offer152";
    const letter = "\u03b1";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2221,
        message: {
          message_id: 2221,
          date: 1761955200,
          chat: { id: -1008179, type: "supergroup", title: "机密群名" },
          from: { id: 152, first_name: "Ada" },
          text: `http://example.com${letter}/http://bit.ly/${path}`,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("allow");
    expect(moderator.deleted).toEqual([]);
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain("bit.ly");
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const split = await normalizeUpdate({
      update: {
        update_id: 2222,
        message: {
          message_id: 2222,
          date: 1761955200,
          chat: { id: -1008180, type: "supergroup", title: "机密群名" },
          from: { id: 152, first_name: "https://tinyurl.com/from152" },
          text: `example.com${letter}/http://bit.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(split.status).toBe("event");
    if (split.status !== "event") {
      return;
    }
    const splitLogger = createMemoryLogger();
    const deleted = await screenTelegramEvent(split.event, {
      logger: splitLogger,
      moderator: createMemoryModerator(),
    });
    expect(deleted.decision.action).toBe("delete");
    expect(deleted.decision.reasons).toContain("short_link");
    expect(JSON.stringify(deleted.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const deletedDump = JSON.stringify({
      result: deleted,
      logs: splitLogger.entries,
    });
    expect(deletedDump).not.toContain(path);
    expect(deletedDump).not.toContain("from152");
    expect(deletedDump).not.toContain("机密群名");
  });

  it("allows a schemed dot lookalike Android keeps and deletes the bare one it splits", async () => {
    const path = "offer153";
    const mark = "\uFF0E";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2223,
        message: {
          message_id: 2223,
          date: 1761955200,
          chat: { id: -1008181, type: "supergroup", title: "机密群名" },
          from: { id: 153, first_name: "Ada" },
          text: `http://example.com.${mark}/http://bit.ly/${path}`,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("allow");
    expect(moderator.deleted).toEqual([]);
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain("bit.ly");
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const split = await normalizeUpdate({
      update: {
        update_id: 2224,
        message: {
          message_id: 2224,
          date: 1761955200,
          chat: { id: -1008182, type: "supergroup", title: "机密群名" },
          from: { id: 153, first_name: "https://tinyurl.com/from153" },
          text: `example.com.${mark}http://bit.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(split.status).toBe("event");
    if (split.status !== "event") {
      return;
    }
    const splitLogger = createMemoryLogger();
    const deleted = await screenTelegramEvent(split.event, {
      logger: splitLogger,
      moderator: createMemoryModerator(),
    });
    expect(deleted.decision.action).toBe("delete");
    expect(deleted.decision.reasons).toContain("short_link");
    expect(JSON.stringify(deleted.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const deletedDump = JSON.stringify({
      result: deleted,
      logs: splitLogger.entries,
    });
    expect(deletedDump).not.toContain(path);
    expect(deletedDump).not.toContain("from153");
    expect(deletedDump).not.toContain("机密群名");
  });

  it("allows a label after @ and deletes the mark that opens the next url", async () => {
    const path = "offer154";
    const han = "\u4f8b";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2225,
        message: {
          message_id: 2225,
          date: 1761955200,
          chat: { id: -1008183, type: "supergroup", title: "机密群名" },
          from: { id: 154, first_name: "Ada" },
          text: `http://example.com@${han}http://bit.ly/${path}`,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("allow");
    expect(moderator.deleted).toEqual([]);
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain("bit.ly");
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const split = await normalizeUpdate({
      update: {
        update_id: 2226,
        message: {
          message_id: 2226,
          date: 1761955200,
          chat: { id: -1008184, type: "supergroup", title: "机密群名" },
          from: { id: 154, first_name: "https://tinyurl.com/from154" },
          text: `http://example.com@!http://bit.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(split.status).toBe("event");
    if (split.status !== "event") {
      return;
    }
    const splitLogger = createMemoryLogger();
    const deleted = await screenTelegramEvent(split.event, {
      logger: splitLogger,
      moderator: createMemoryModerator(),
    });
    expect(deleted.decision.action).toBe("delete");
    expect(deleted.decision.reasons).toContain("short_link");
    expect(JSON.stringify(deleted.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const deletedDump = JSON.stringify({
      result: deleted,
      logs: splitLogger.entries,
    });
    expect(deletedDump).not.toContain(path);
    expect(deletedDump).not.toContain("from154");
    expect(deletedDump).not.toContain("机密群名");
  });

  it("allows a real dot before @ and deletes the lookalike that opens the next url", async () => {
    const path = "offer155";
    const mark = "\uFF0E";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2227,
        message: {
          message_id: 2227,
          date: 1761955200,
          chat: { id: -1008185, type: "supergroup", title: "机密群名" },
          from: { id: 155, first_name: "Ada" },
          text: `http://example.com.@http://bit.ly/${path}`,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("allow");
    expect(moderator.deleted).toEqual([]);
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain("bit.ly");
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const split = await normalizeUpdate({
      update: {
        update_id: 2228,
        message: {
          message_id: 2228,
          date: 1761955200,
          chat: { id: -1008186, type: "supergroup", title: "机密群名" },
          from: { id: 155, first_name: "https://tinyurl.com/from155" },
          text: `http://example.com${mark}@http://bit.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(split.status).toBe("event");
    if (split.status !== "event") {
      return;
    }
    const splitLogger = createMemoryLogger();
    const deleted = await screenTelegramEvent(split.event, {
      logger: splitLogger,
      moderator: createMemoryModerator(),
    });
    expect(deleted.decision.action).toBe("delete");
    expect(deleted.decision.reasons).toContain("short_link");
    expect(JSON.stringify(deleted.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const deletedDump = JSON.stringify({
      result: deleted,
      logs: splitLogger.entries,
    });
    expect(deletedDump).not.toContain(path);
    expect(deletedDump).not.toContain("from155");
    expect(deletedDump).not.toContain("机密群名");
  });

  it("allows a schemed lookalike host and deletes the bare one that opens the next url", async () => {
    const path = "offer156";
    const mark = "\uFF0E";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2229,
        message: {
          message_id: 2229,
          date: 1761955200,
          chat: { id: -1008187, type: "supergroup", title: "机密群名" },
          from: { id: 156, first_name: "Ada" },
          text: `http://bit${mark}ly${mark}com/http://t.co/${path}`,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("allow");
    expect(moderator.deleted).toEqual([]);
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain("t.co");
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const split = await normalizeUpdate({
      update: {
        update_id: 2230,
        message: {
          message_id: 2230,
          date: 1761955200,
          chat: { id: -1008188, type: "supergroup", title: "机密群名" },
          from: { id: 156, first_name: "https://tinyurl.com/from156" },
          text: `bit${mark}ly${mark}com/http://t.co/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(split.status).toBe("event");
    if (split.status !== "event") {
      return;
    }
    const splitLogger = createMemoryLogger();
    const deleted = await screenTelegramEvent(split.event, {
      logger: splitLogger,
      moderator: createMemoryModerator(),
    });
    expect(deleted.decision.action).toBe("delete");
    expect(deleted.decision.reasons).toContain("short_link");
    expect(JSON.stringify(deleted.decision.evidence)).toContain(
      "short_link:t.co",
    );
    const deletedDump = JSON.stringify({
      result: deleted,
      logs: splitLogger.entries,
    });
    expect(deletedDump).not.toContain(path);
    expect(deletedDump).not.toContain("from156");
    expect(deletedDump).not.toContain("机密群名");
  });

  it("allows a schemed lookalike letter and deletes the bare host before the scheme", async () => {
    const path = "offer157";
    const mark = "\u0410";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2231,
        message: {
          message_id: 2231,
          date: 1761955200,
          chat: { id: -1008189, type: "supergroup", title: "机密群名" },
          from: { id: 157, first_name: "Ada" },
          text: `http://example.com${mark}http://bit.ly/${path}`,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("allow");
    expect(moderator.deleted).toEqual([]);
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain("bit.ly");
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const split = await normalizeUpdate({
      update: {
        update_id: 2232,
        message: {
          message_id: 2232,
          date: 1761955200,
          chat: { id: -1008190, type: "supergroup", title: "机密群名" },
          from: { id: 157, first_name: "https://tinyurl.com/from157" },
          text: `example.com${mark}http://bit.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(split.status).toBe("event");
    if (split.status !== "event") {
      return;
    }
    const splitLogger = createMemoryLogger();
    const deleted = await screenTelegramEvent(split.event, {
      logger: splitLogger,
      moderator: createMemoryModerator(),
    });
    expect(deleted.decision.action).toBe("delete");
    expect(deleted.decision.reasons).toContain("short_link");
    expect(JSON.stringify(deleted.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const deletedDump = JSON.stringify({
      result: deleted,
      logs: splitLogger.entries,
    });
    expect(deletedDump).not.toContain(path);
    expect(deletedDump).not.toContain("from157");
    expect(deletedDump).not.toContain("机密群名");
    expect(deletedDump).not.toContain(mark);
  });

  it("allows a bare host glued by a combining mark and deletes the link after the slash", async () => {
    const path = "offer158";
    const mark = "\u0300";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2233,
        message: {
          message_id: 2233,
          date: 1761955200,
          chat: { id: -1008191, type: "supergroup", title: "机密群名" },
          from: { id: 158, first_name: "Ada" },
          text: `example.com${mark}http://bit.ly/${path}`,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("allow");
    expect(moderator.deleted).toEqual([]);
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain("bit.ly");
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");
    expect(dumped).not.toContain(mark);

    const split = await normalizeUpdate({
      update: {
        update_id: 2234,
        message: {
          message_id: 2234,
          date: 1761955200,
          chat: { id: -1008192, type: "supergroup", title: "机密群名" },
          from: { id: 158, first_name: "https://tinyurl.com/from158" },
          text: `example.com${mark}/http://bit.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(split.status).toBe("event");
    if (split.status !== "event") {
      return;
    }
    const splitLogger = createMemoryLogger();
    const deleted = await screenTelegramEvent(split.event, {
      logger: splitLogger,
      moderator: createMemoryModerator(),
    });
    expect(deleted.decision.action).toBe("delete");
    expect(deleted.decision.reasons).toContain("short_link");
    expect(JSON.stringify(deleted.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const deletedDump = JSON.stringify({
      result: deleted,
      logs: splitLogger.entries,
    });
    expect(deletedDump).not.toContain(path);
    expect(deletedDump).not.toContain("from158");
    expect(deletedDump).not.toContain("机密群名");
    expect(deletedDump).not.toContain(mark);
  });

  it("allows a percent-encoded dot glued to a scheme and deletes a real dot", async () => {
    const path = "offer159";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2235,
        message: {
          message_id: 2235,
          date: 1761955200,
          chat: { id: -1008193, type: "supergroup", title: "机密群名" },
          from: { id: 159, first_name: "Ada" },
          text: `example.com%2Ehttp://bit.ly/${path}`,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("allow");
    expect(moderator.deleted).toEqual([]);
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain("bit.ly");
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const split = await normalizeUpdate({
      update: {
        update_id: 2236,
        message: {
          message_id: 2236,
          date: 1761955200,
          chat: { id: -1008194, type: "supergroup", title: "机密群名" },
          from: { id: 159, first_name: "https://tinyurl.com/from159" },
          text: `example.com.http://bit.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(split.status).toBe("event");
    if (split.status !== "event") {
      return;
    }
    const splitLogger = createMemoryLogger();
    const deleted = await screenTelegramEvent(split.event, {
      logger: splitLogger,
      moderator: createMemoryModerator(),
    });
    expect(deleted.decision.action).toBe("delete");
    expect(deleted.decision.reasons).toContain("short_link");
    expect(JSON.stringify(deleted.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const deletedDump = JSON.stringify({
      result: deleted,
      logs: splitLogger.entries,
    });
    expect(deletedDump).not.toContain(path);
    expect(deletedDump).not.toContain("from159");
    expect(deletedDump).not.toContain("机密群名");
  });

  it("allows a percent-encoded plus glued to a scheme and deletes a real plus", async () => {
    const path = "offer160";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2237,
        message: {
          message_id: 2237,
          date: 1761955200,
          chat: { id: -1008195, type: "supergroup", title: "机密群名" },
          from: { id: 160, first_name: "Ada" },
          text: `example.com%2Bhttp://bit.ly/${path}`,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("allow");
    expect(moderator.deleted).toEqual([]);
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain("bit.ly");
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const split = await normalizeUpdate({
      update: {
        update_id: 2238,
        message: {
          message_id: 2238,
          date: 1761955200,
          chat: { id: -1008196, type: "supergroup", title: "机密群名" },
          from: { id: 160, first_name: "https://tinyurl.com/from160" },
          text: `example.com+http://bit.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(split.status).toBe("event");
    if (split.status !== "event") {
      return;
    }
    const splitLogger = createMemoryLogger();
    const deleted = await screenTelegramEvent(split.event, {
      logger: splitLogger,
      moderator: createMemoryModerator(),
    });
    expect(deleted.decision.action).toBe("delete");
    expect(deleted.decision.reasons).toContain("short_link");
    expect(JSON.stringify(deleted.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const deletedDump = JSON.stringify({
      result: deleted,
      logs: splitLogger.entries,
    });
    expect(deletedDump).not.toContain(path);
    expect(deletedDump).not.toContain("from160");
    expect(deletedDump).not.toContain("机密群名");
  });

  it("allows a percent-encoded hyphen glued to a scheme and deletes a real hyphen", async () => {
    const path = "offer161";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2239,
        message: {
          message_id: 2239,
          date: 1761955200,
          chat: { id: -1008197, type: "supergroup", title: "机密群名" },
          from: { id: 161, first_name: "Ada" },
          text: `example.com%2Dhttp://bit.ly/${path}`,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("allow");
    expect(moderator.deleted).toEqual([]);
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain("bit.ly");
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const split = await normalizeUpdate({
      update: {
        update_id: 2240,
        message: {
          message_id: 2240,
          date: 1761955200,
          chat: { id: -1008198, type: "supergroup", title: "机密群名" },
          from: { id: 161, first_name: "https://tinyurl.com/from161" },
          text: `example.com-http://bit.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(split.status).toBe("event");
    if (split.status !== "event") {
      return;
    }
    const splitLogger = createMemoryLogger();
    const deleted = await screenTelegramEvent(split.event, {
      logger: splitLogger,
      moderator: createMemoryModerator(),
    });
    expect(deleted.decision.action).toBe("delete");
    expect(deleted.decision.reasons).toContain("short_link");
    expect(JSON.stringify(deleted.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const deletedDump = JSON.stringify({
      result: deleted,
      logs: splitLogger.entries,
    });
    expect(deletedDump).not.toContain(path);
    expect(deletedDump).not.toContain("from161");
    expect(deletedDump).not.toContain("机密群名");
  });

  it("allows a percent-encoded scheme and deletes a literal scheme", async () => {
    const path = "offer162";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2241,
        message: {
          message_id: 2241,
          date: 1761955200,
          chat: { id: -1008199, type: "supergroup", title: "机密群名" },
          from: { id: 162, first_name: "Ada" },
          text: `%68ttp://bit.ly/${path}`,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("allow");
    expect(moderator.deleted).toEqual([]);
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain("bit.ly");
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const split = await normalizeUpdate({
      update: {
        update_id: 2242,
        message: {
          message_id: 2242,
          date: 1761955200,
          chat: { id: -1008200, type: "supergroup", title: "机密群名" },
          from: { id: 162, first_name: "https://tinyurl.com/from162" },
          text: `http://bit.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(split.status).toBe("event");
    if (split.status !== "event") {
      return;
    }
    const splitLogger = createMemoryLogger();
    const deleted = await screenTelegramEvent(split.event, {
      logger: splitLogger,
      moderator: createMemoryModerator(),
    });
    expect(deleted.decision.action).toBe("delete");
    expect(deleted.decision.reasons).toContain("short_link");
    expect(JSON.stringify(deleted.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const deletedDump = JSON.stringify({
      result: deleted,
      logs: splitLogger.entries,
    });
    expect(deletedDump).not.toContain(path);
    expect(deletedDump).not.toContain("from162");
    expect(deletedDump).not.toContain("机密群名");
  });

  it("allows a percent-encoded slash scheme and deletes a real slash", async () => {
    const path = "offer163";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2243,
        message: {
          message_id: 2243,
          date: 1761955200,
          chat: { id: -1008201, type: "supergroup", title: "机密群名" },
          from: { id: 163, first_name: "Ada" },
          text: `%2Fhttp://bit.ly/${path}`,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("allow");
    expect(moderator.deleted).toEqual([]);
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain("bit.ly");
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const split = await normalizeUpdate({
      update: {
        update_id: 2244,
        message: {
          message_id: 2244,
          date: 1761955200,
          chat: { id: -1008202, type: "supergroup", title: "机密群名" },
          from: { id: 163, first_name: "https://tinyurl.com/from163" },
          text: `http:%2F/bit.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(split.status).toBe("event");
    if (split.status !== "event") {
      return;
    }
    const splitLogger = createMemoryLogger();
    const deleted = await screenTelegramEvent(split.event, {
      logger: splitLogger,
      moderator: createMemoryModerator(),
    });
    expect(deleted.decision.action).toBe("delete");
    expect(deleted.decision.reasons).toContain("short_link");
    expect(JSON.stringify(deleted.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const deletedDump = JSON.stringify({
      result: deleted,
      logs: splitLogger.entries,
    });
    expect(deletedDump).not.toContain(path);
    expect(deletedDump).not.toContain("from163");
    expect(deletedDump).not.toContain("机密群名");
  });

  it("allows a percent-encoded plus host and deletes a real plus", async () => {
    const path = "offer164";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2245,
        message: {
          message_id: 2245,
          date: 1761955200,
          chat: { id: -1008203, type: "supergroup", title: "机密群名" },
          from: { id: 164, first_name: "Ada" },
          text: `%2Bbit.ly/${path}`,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("allow");
    expect(moderator.deleted).toEqual([]);
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain("bit.ly");
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const split = await normalizeUpdate({
      update: {
        update_id: 2246,
        message: {
          message_id: 2246,
          date: 1761955200,
          chat: { id: -1008204, type: "supergroup", title: "机密群名" },
          from: { id: 164, first_name: "https://tinyurl.com/from164" },
          text: `example.com+bit.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(split.status).toBe("event");
    if (split.status !== "event") {
      return;
    }
    const splitLogger = createMemoryLogger();
    const deleted = await screenTelegramEvent(split.event, {
      logger: splitLogger,
      moderator: createMemoryModerator(),
    });
    expect(deleted.decision.action).toBe("delete");
    expect(deleted.decision.reasons).toContain("short_link");
    expect(JSON.stringify(deleted.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const deletedDump = JSON.stringify({
      result: deleted,
      logs: splitLogger.entries,
    });
    expect(deletedDump).not.toContain(path);
    expect(deletedDump).not.toContain("from164");
    expect(deletedDump).not.toContain("机密群名");
  });

  it("allows a percent-encoded slash host and deletes a real slash", async () => {
    const path = "offer165";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2247,
        message: {
          message_id: 2247,
          date: 1761955200,
          chat: { id: -1008205, type: "supergroup", title: "机密群名" },
          from: { id: 165, first_name: "Ada" },
          text: `%2Fbit.ly/${path}`,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("allow");
    expect(moderator.deleted).toEqual([]);
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain("bit.ly");
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const split = await normalizeUpdate({
      update: {
        update_id: 2248,
        message: {
          message_id: 2248,
          date: 1761955200,
          chat: { id: -1008206, type: "supergroup", title: "机密群名" },
          from: { id: 165, first_name: "https://tinyurl.com/from165" },
          text: `example.com%2F/bit.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(split.status).toBe("event");
    if (split.status !== "event") {
      return;
    }
    const splitLogger = createMemoryLogger();
    const deleted = await screenTelegramEvent(split.event, {
      logger: splitLogger,
      moderator: createMemoryModerator(),
    });
    expect(deleted.decision.action).toBe("delete");
    expect(deleted.decision.reasons).toContain("short_link");
    expect(JSON.stringify(deleted.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const deletedDump = JSON.stringify({
      result: deleted,
      logs: splitLogger.entries,
    });
    expect(deletedDump).not.toContain(path);
    expect(deletedDump).not.toContain("from165");
    expect(deletedDump).not.toContain("机密群名");
  });

  it("allows a percent-encoded hyphen host and deletes a real hyphen", async () => {
    const path = "offer166";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2249,
        message: {
          message_id: 2249,
          date: 1761955200,
          chat: { id: -1008207, type: "supergroup", title: "机密群名" },
          from: { id: 166, first_name: "Ada" },
          text: `%2Dbit.ly/${path}`,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("allow");
    expect(moderator.deleted).toEqual([]);
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain("bit.ly");
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const split = await normalizeUpdate({
      update: {
        update_id: 2250,
        message: {
          message_id: 2250,
          date: 1761955200,
          chat: { id: -1008208, type: "supergroup", title: "机密群名" },
          from: { id: 166, first_name: "https://tinyurl.com/from166" },
          text: `-bit.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(split.status).toBe("event");
    if (split.status !== "event") {
      return;
    }
    const splitLogger = createMemoryLogger();
    const deleted = await screenTelegramEvent(split.event, {
      logger: splitLogger,
      moderator: createMemoryModerator(),
    });
    expect(deleted.decision.action).toBe("delete");
    expect(deleted.decision.reasons).toContain("short_link");
    expect(JSON.stringify(deleted.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const deletedDump = JSON.stringify({
      result: deleted,
      logs: splitLogger.entries,
    });
    expect(deletedDump).not.toContain(path);
    expect(deletedDump).not.toContain("from166");
    expect(deletedDump).not.toContain("机密群名");
  });

  it("allows an encoded host body and deletes a real encoded letter", async () => {
    const path = "offer167";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2251,
        message: {
          message_id: 2251,
          date: 1761955200,
          chat: { id: -1008209, type: "supergroup", title: "机密群名" },
          from: { id: 167, first_name: "Ada" },
          text: `%2Bb%69t.ly/${path}`,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("allow");
    expect(moderator.deleted).toEqual([]);
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain("bit.ly");
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const split = await normalizeUpdate({
      update: {
        update_id: 2252,
        message: {
          message_id: 2252,
          date: 1761955200,
          chat: { id: -1008210, type: "supergroup", title: "机密群名" },
          from: { id: 167, first_name: "https://tinyurl.com/from167" },
          text: `b%69t.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(split.status).toBe("event");
    if (split.status !== "event") {
      return;
    }
    const splitLogger = createMemoryLogger();
    const deleted = await screenTelegramEvent(split.event, {
      logger: splitLogger,
      moderator: createMemoryModerator(),
    });
    expect(deleted.decision.action).toBe("delete");
    expect(deleted.decision.reasons).toContain("short_link");
    expect(JSON.stringify(deleted.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const deletedDump = JSON.stringify({
      result: deleted,
      logs: splitLogger.entries,
    });
    expect(deletedDump).not.toContain(path);
    expect(deletedDump).not.toContain("from167");
    expect(deletedDump).not.toContain("机密群名");
  });

  it("allows a percent-encoded bracket host and deletes a bracket inside the label", async () => {
    const path = "offer171";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2259,
        message: {
          message_id: 2259,
          date: 1761955200,
          chat: { id: -1008217, type: "supergroup", title: "机密群名" },
          from: { id: 171, first_name: "Ada" },
          text: `%5B.%5Dbit.ly/${path}`,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("allow");
    expect(moderator.deleted).toEqual([]);
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain("bit.ly");
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const split = await normalizeUpdate({
      update: {
        update_id: 2260,
        message: {
          message_id: 2260,
          date: 1761955200,
          chat: { id: -1008218, type: "supergroup", title: "机密群名" },
          from: { id: 171, first_name: "https://tinyurl.com/from171" },
          text: `bit%5B.%5Dly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(split.status).toBe("event");
    if (split.status !== "event") {
      return;
    }
    const splitLogger = createMemoryLogger();
    const deleted = await screenTelegramEvent(split.event, {
      logger: splitLogger,
      moderator: createMemoryModerator(),
    });
    expect(deleted.decision.action).toBe("delete");
    expect(deleted.decision.reasons).toContain("short_link");
    expect(JSON.stringify(deleted.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const deletedDump = JSON.stringify({
      result: deleted,
      logs: splitLogger.entries,
    });
    expect(deletedDump).not.toContain(path);
    expect(deletedDump).not.toContain("from171");
    expect(deletedDump).not.toContain("机密群名");
  });

  it("allows a percent-encoded dot mark and deletes a dot inside the label", async () => {
    const path = "offer170";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2257,
        message: {
          message_id: 2257,
          date: 1761955200,
          chat: { id: -1008215, type: "supergroup", title: "机密群名" },
          from: { id: 170, first_name: "Ada" },
          text: `%2Ebit.ly/${path}`,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("allow");
    expect(moderator.deleted).toEqual([]);
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain("bit.ly");
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const split = await normalizeUpdate({
      update: {
        update_id: 2258,
        message: {
          message_id: 2258,
          date: 1761955200,
          chat: { id: -1008216, type: "supergroup", title: "机密群名" },
          from: { id: 170, first_name: "https://tinyurl.com/from170" },
          text: `bit%2Ely/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(split.status).toBe("event");
    if (split.status !== "event") {
      return;
    }
    const splitLogger = createMemoryLogger();
    const deleted = await screenTelegramEvent(split.event, {
      logger: splitLogger,
      moderator: createMemoryModerator(),
    });
    expect(deleted.decision.action).toBe("delete");
    expect(deleted.decision.reasons).toContain("short_link");
    expect(JSON.stringify(deleted.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const deletedDump = JSON.stringify({
      result: deleted,
      logs: splitLogger.entries,
    });
    expect(deletedDump).not.toContain(path);
    expect(deletedDump).not.toContain("from170");
    expect(deletedDump).not.toContain("机密群名");
  });

  it("allows a percent-encoded dot host and deletes a dot inside the label", async () => {
    const path = "offer169";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2255,
        message: {
          message_id: 2255,
          date: 1761955200,
          chat: { id: -1008213, type: "supergroup", title: "机密群名" },
          from: { id: 169, first_name: "Ada" },
          text: `%C2%B7bit.ly/${path}`,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("allow");
    expect(moderator.deleted).toEqual([]);
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain("bit.ly");
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const split = await normalizeUpdate({
      update: {
        update_id: 2256,
        message: {
          message_id: 2256,
          date: 1761955200,
          chat: { id: -1008214, type: "supergroup", title: "机密群名" },
          from: { id: 169, first_name: "https://tinyurl.com/from169" },
          text: `bit%C2%B7ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(split.status).toBe("event");
    if (split.status !== "event") {
      return;
    }
    const splitLogger = createMemoryLogger();
    const deleted = await screenTelegramEvent(split.event, {
      logger: splitLogger,
      moderator: createMemoryModerator(),
    });
    expect(deleted.decision.action).toBe("delete");
    expect(deleted.decision.reasons).toContain("short_link");
    expect(JSON.stringify(deleted.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const deletedDump = JSON.stringify({
      result: deleted,
      logs: splitLogger.entries,
    });
    expect(deletedDump).not.toContain(path);
    expect(deletedDump).not.toContain("from169");
    expect(deletedDump).not.toContain("机密群名");
  });

  it("allows a percent-encoded gap host and deletes a gap inside the label", async () => {
    const path = "offer168";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2253,
        message: {
          message_id: 2253,
          date: 1761955200,
          chat: { id: -1008211, type: "supergroup", title: "机密群名" },
          from: { id: 168, first_name: "Ada" },
          text: `%0Abit.ly/${path}`,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("allow");
    expect(moderator.deleted).toEqual([]);
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain("bit.ly");
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const split = await normalizeUpdate({
      update: {
        update_id: 2254,
        message: {
          message_id: 2254,
          date: 1761955200,
          chat: { id: -1008212, type: "supergroup", title: "机密群名" },
          from: { id: 168, first_name: "https://tinyurl.com/from168" },
          text: `bit%E2%80%8B.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(split.status).toBe("event");
    if (split.status !== "event") {
      return;
    }
    const splitLogger = createMemoryLogger();
    const deleted = await screenTelegramEvent(split.event, {
      logger: splitLogger,
      moderator: createMemoryModerator(),
    });
    expect(deleted.decision.action).toBe("delete");
    expect(deleted.decision.reasons).toContain("short_link");
    expect(JSON.stringify(deleted.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const deletedDump = JSON.stringify({
      result: deleted,
      logs: splitLogger.entries,
    });
    expect(deletedDump).not.toContain(path);
    expect(deletedDump).not.toContain("from168");
    expect(deletedDump).not.toContain("机密群名");
  });

  it("allows a label Android keeps together and deletes a leading label", async () => {
    const path = "offer172";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2261,
        message: {
          message_id: 2261,
          date: 1761955200,
          chat: { id: -1008219, type: "supergroup", title: "机密群名" },
          from: { id: 172, first_name: "Ada" },
          text: `example.com\u70B9bit.ly/${path}`,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("allow");
    expect(moderator.deleted).toEqual([]);
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain("bit.ly");
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const split = await normalizeUpdate({
      update: {
        update_id: 2262,
        message: {
          message_id: 2262,
          date: 1761955200,
          chat: { id: -1008220, type: "supergroup", title: "机密群名" },
          from: { id: 172, first_name: "https://tinyurl.com/from172" },
          text: `\u70B9\u51FBbit.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(split.status).toBe("event");
    if (split.status !== "event") {
      return;
    }
    const splitLogger = createMemoryLogger();
    const deleted = await screenTelegramEvent(split.event, {
      logger: splitLogger,
      moderator: createMemoryModerator(),
    });
    expect(deleted.decision.action).toBe("delete");
    expect(deleted.decision.reasons).toContain("short_link");
    expect(JSON.stringify(deleted.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const deletedDump = JSON.stringify({
      result: deleted,
      logs: splitLogger.entries,
    });
    expect(deletedDump).not.toContain(path);
    expect(deletedDump).not.toContain("from172");
    expect(deletedDump).not.toContain("机密群名");
  });

  it("allows a mapped letter that changes the host and deletes one inside it", async () => {
    const path = "offer173";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2263,
        message: {
          message_id: 2263,
          date: 1761955200,
          chat: { id: -1008221, type: "supergroup", title: "机密群名" },
          from: { id: 173, first_name: "Ada" },
          text: `b\u017Fit.ly/${path}`,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("allow");
    expect(moderator.deleted).toEqual([]);
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain("bit.ly");
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const split = await normalizeUpdate({
      update: {
        update_id: 2264,
        message: {
          message_id: 2264,
          date: 1761955200,
          chat: { id: -1008222, type: "supergroup", title: "机密群名" },
          from: { id: 173, first_name: "https://tinyurl.com/from173" },
          text: `b\u2139t.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(split.status).toBe("event");
    if (split.status !== "event") {
      return;
    }
    const splitLogger = createMemoryLogger();
    const deleted = await screenTelegramEvent(split.event, {
      logger: splitLogger,
      moderator: createMemoryModerator(),
    });
    expect(deleted.decision.action).toBe("delete");
    expect(deleted.decision.reasons).toContain("short_link");
    expect(JSON.stringify(deleted.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const deletedDump = JSON.stringify({
      result: deleted,
      logs: splitLogger.entries,
    });
    expect(deletedDump).not.toContain(path);
    expect(deletedDump).not.toContain("from173");
    expect(deletedDump).not.toContain("机密群名");
  });

  it("allows a joiner after a dot and deletes one inside a short link", async () => {
    const path = "offer174";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2265,
        message: {
          message_id: 2265,
          date: 1761955200,
          chat: { id: -1008223, type: "supergroup", title: "机密群名" },
          from: { id: 174, first_name: "Ada" },
          text: `bit.\u034Fly/${path}`,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("allow");
    expect(moderator.deleted).toEqual([]);
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain("bit.ly");
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const split = await normalizeUpdate({
      update: {
        update_id: 2266,
        message: {
          message_id: 2266,
          date: 1761955200,
          chat: { id: -1008224, type: "supergroup", title: "机密群名" },
          from: { id: 174, first_name: "https://tinyurl.com/from174" },
          text: `bi\u034Ft.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(split.status).toBe("event");
    if (split.status !== "event") {
      return;
    }
    const splitLogger = createMemoryLogger();
    const deleted = await screenTelegramEvent(split.event, {
      logger: splitLogger,
      moderator: createMemoryModerator(),
    });
    expect(deleted.decision.action).toBe("delete");
    expect(deleted.decision.reasons).toContain("short_link");
    expect(JSON.stringify(deleted.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const deletedDump = JSON.stringify({
      result: deleted,
      logs: splitLogger.entries,
    });
    expect(deletedDump).not.toContain(path);
    expect(deletedDump).not.toContain("from174");
    expect(deletedDump).not.toContain("机密群名");
  });

  it("allows a multi-byte percent encoding and deletes an encoded letter", async () => {
    const path = "offer175";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2267,
        message: {
          message_id: 2267,
          date: 1761955200,
          chat: { id: -1008225, type: "supergroup", title: "机密群名" },
          from: { id: 175, first_name: "Ada" },
          text: `http://b%E2%85%A0t.ly/${path}`,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("allow");
    expect(moderator.deleted).toEqual([]);
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain("bit.ly");
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const split = await normalizeUpdate({
      update: {
        update_id: 2268,
        message: {
          message_id: 2268,
          date: 1761955200,
          chat: { id: -1008226, type: "supergroup", title: "机密群名" },
          from: { id: 175, first_name: "https://tinyurl.com/from175" },
          text: `http://b%69t.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(split.status).toBe("event");
    if (split.status !== "event") {
      return;
    }
    const splitLogger = createMemoryLogger();
    const deleted = await screenTelegramEvent(split.event, {
      logger: splitLogger,
      moderator: createMemoryModerator(),
    });
    expect(deleted.decision.action).toBe("delete");
    expect(deleted.decision.reasons).toContain("short_link");
    expect(JSON.stringify(deleted.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const deletedDump = JSON.stringify({
      result: deleted,
      logs: splitLogger.entries,
    });
    expect(deletedDump).not.toContain(path);
    expect(deletedDump).not.toContain("from175");
    expect(deletedDump).not.toContain("机密群名");
  });

  it("allows script punctuation and deletes the short link after it", async () => {
    const path = "offer176";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2269,
        message: {
          message_id: 2269,
          date: 1761955200,
          chat: { id: -1008227, type: "supergroup", title: "机密群名" },
          from: { id: 176, first_name: "Ada" },
          text: `b\u055Ait.ly/${path}`,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("allow");
    expect(moderator.deleted).toEqual([]);
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain("bit.ly");
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const split = await normalizeUpdate({
      update: {
        update_id: 2270,
        message: {
          message_id: 2270,
          date: 1761955200,
          chat: { id: -1008228, type: "supergroup", title: "机密群名" },
          from: { id: 176, first_name: "https://tinyurl.com/from176" },
          text: `example.com\u055Ahttp://bit.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(split.status).toBe("event");
    if (split.status !== "event") {
      return;
    }
    const splitLogger = createMemoryLogger();
    const deleted = await screenTelegramEvent(split.event, {
      logger: splitLogger,
      moderator: createMemoryModerator(),
    });
    expect(deleted.decision.action).toBe("delete");
    expect(deleted.decision.reasons).toContain("short_link");
    expect(JSON.stringify(deleted.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const deletedDump = JSON.stringify({
      result: deleted,
      logs: splitLogger.entries,
    });
    expect(deletedDump).not.toContain(path);
    expect(deletedDump).not.toContain("from176");
    expect(deletedDump).not.toContain("机密群名");
  });

  it("allows a division slash in the host and deletes the short link before @", async () => {
    const path = "offer177";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2271,
        message: {
          message_id: 2271,
          date: 1761955200,
          chat: { id: -1008229, type: "supergroup", title: "机密群名" },
          from: { id: 177, first_name: "Ada" },
          text: `http://\u2215bit.ly/${path}`,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("allow");
    expect(moderator.deleted).toEqual([]);
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain("bit.ly");
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const split = await normalizeUpdate({
      update: {
        update_id: 2272,
        message: {
          message_id: 2272,
          date: 1761955200,
          chat: { id: -1008230, type: "supergroup", title: "机密群名" },
          from: { id: 177, first_name: "https://tinyurl.com/from177" },
          text: `http://bit.ly\u2215@example.com/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(split.status).toBe("event");
    if (split.status !== "event") {
      return;
    }
    const splitLogger = createMemoryLogger();
    const deleted = await screenTelegramEvent(split.event, {
      logger: splitLogger,
      moderator: createMemoryModerator(),
    });
    expect(deleted.decision.action).toBe("delete");
    expect(deleted.decision.reasons).toContain("short_link");
    expect(JSON.stringify(deleted.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const deletedDump = JSON.stringify({
      result: deleted,
      logs: splitLogger.entries,
    });
    expect(deletedDump).not.toContain(path);
    expect(deletedDump).not.toContain("from177");
    expect(deletedDump).not.toContain("机密群名");
  });

  it("allows an empty authority query and deletes a collapsed host", async () => {
    const path = "offer178";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2273,
        message: {
          message_id: 2273,
          date: 1761955200,
          chat: { id: -1008231, type: "supergroup", title: "机密群名" },
          from: { id: 178, first_name: "Ada" },
          text: `http://?bit.ly/${path}`,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("allow");
    expect(moderator.deleted).toEqual([]);
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain("bit.ly");
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const split = await normalizeUpdate({
      update: {
        update_id: 2274,
        message: {
          message_id: 2274,
          date: 1761955200,
          chat: { id: -1008232, type: "supergroup", title: "机密群名" },
          from: { id: 178, first_name: "https://tinyurl.com/from178" },
          text: `http:///bit.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(split.status).toBe("event");
    if (split.status !== "event") {
      return;
    }
    const splitLogger = createMemoryLogger();
    const deleted = await screenTelegramEvent(split.event, {
      logger: splitLogger,
      moderator: createMemoryModerator(),
    });
    expect(deleted.decision.action).toBe("delete");
    expect(deleted.decision.reasons).toContain("short_link");
    expect(JSON.stringify(deleted.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const deletedDump = JSON.stringify({
      result: deleted,
      logs: splitLogger.entries,
    });
    expect(deletedDump).not.toContain(path);
    expect(deletedDump).not.toContain("from178");
    expect(deletedDump).not.toContain("机密群名");
  });

  it("allows a hostless port and deletes a six-digit port", async () => {
    const path = "offer179";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2275,
        message: {
          message_id: 2275,
          date: 1761955200,
          chat: { id: -1008233, type: "supergroup", title: "机密群名" },
          from: { id: 179, first_name: "Ada" },
          text: `http://:80/bit.ly/${path}`,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("allow");
    expect(moderator.deleted).toEqual([]);
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain("bit.ly");
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const split = await normalizeUpdate({
      update: {
        update_id: 2276,
        message: {
          message_id: 2276,
          date: 1761955200,
          chat: { id: -1008234, type: "supergroup", title: "机密群名" },
          from: { id: 179, first_name: "https://tinyurl.com/from179" },
          text: `http://:999999/bit.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(split.status).toBe("event");
    if (split.status !== "event") {
      return;
    }
    const splitLogger = createMemoryLogger();
    const deleted = await screenTelegramEvent(split.event, {
      logger: splitLogger,
      moderator: createMemoryModerator(),
    });
    expect(deleted.decision.action).toBe("delete");
    expect(deleted.decision.reasons).toContain("short_link");
    expect(JSON.stringify(deleted.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const deletedDump = JSON.stringify({
      result: deleted,
      logs: splitLogger.entries,
    });
    expect(deletedDump).not.toContain(path);
    expect(deletedDump).not.toContain("from179");
    expect(deletedDump).not.toContain("机密群名");
  });

  it("allows a schemed label character and deletes the host before @", async () => {
    const path = "offer180";
    const mark = "\u4e00";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2277,
        message: {
          message_id: 2277,
          date: 1761955200,
          chat: { id: -1008235, type: "supergroup", title: "机密群名" },
          from: { id: 180, first_name: "Ada" },
          text: `http://bit.ly${mark}/${path}`,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("allow");
    expect(moderator.deleted).toEqual([]);
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain("bit.ly");
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const split = await normalizeUpdate({
      update: {
        update_id: 2278,
        message: {
          message_id: 2278,
          date: 1761955200,
          chat: { id: -1008236, type: "supergroup", title: "机密群名" },
          from: { id: 180, first_name: "https://tinyurl.com/from180" },
          text: `http://bit.ly${mark}@evil.com/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(split.status).toBe("event");
    if (split.status !== "event") {
      return;
    }
    const splitLogger = createMemoryLogger();
    const deleted = await screenTelegramEvent(split.event, {
      logger: splitLogger,
      moderator: createMemoryModerator(),
    });
    expect(deleted.decision.action).toBe("delete");
    expect(deleted.decision.reasons).toContain("short_link");
    expect(JSON.stringify(deleted.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const deletedDump = JSON.stringify({
      result: deleted,
      logs: splitLogger.entries,
    });
    expect(deletedDump).not.toContain(path);
    expect(deletedDump).not.toContain("from180");
    expect(deletedDump).not.toContain("机密群名");
  });

  it("allows a supplementary label character and deletes the host before @", async () => {
    const path = "offer181";
    const ext = "\u{20000}";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2279,
        message: {
          message_id: 2279,
          date: 1761955200,
          chat: { id: -1008237, type: "supergroup", title: "机密群名" },
          from: { id: 181, first_name: "Ada" },
          text: `http://bit.ly${ext}/${path}`,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("allow");
    expect(moderator.deleted).toEqual([]);
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain("bit.ly");
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const split = await normalizeUpdate({
      update: {
        update_id: 2280,
        message: {
          message_id: 2280,
          date: 1761955200,
          chat: { id: -1008238, type: "supergroup", title: "机密群名" },
          from: { id: 181, first_name: "https://tinyurl.com/from181" },
          text: `http://bit.ly${ext}@evil.com/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(split.status).toBe("event");
    if (split.status !== "event") {
      return;
    }
    const splitLogger = createMemoryLogger();
    const deleted = await screenTelegramEvent(split.event, {
      logger: splitLogger,
      moderator: createMemoryModerator(),
    });
    expect(deleted.decision.action).toBe("delete");
    expect(deleted.decision.reasons).toContain("short_link");
    expect(JSON.stringify(deleted.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const deletedDump = JSON.stringify({
      result: deleted,
      logs: splitLogger.entries,
    });
    expect(deletedDump).not.toContain(path);
    expect(deletedDump).not.toContain("from181");
    expect(deletedDump).not.toContain("机密群名");
  });

  it("deletes a mapped letter after a finished host and keeps the schemed one", async () => {
    const path = "offer182";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2281,
        message: {
          message_id: 2281,
          date: 1761955200,
          chat: { id: -1008239, type: "supergroup", title: "机密群名" },
          from: { id: 182, first_name: "Ada" },
          text: `bit.ly\u00AA/${path}`,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toContain("short_link");
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const kept = await normalizeUpdate({
      update: {
        update_id: 2282,
        message: {
          message_id: 2282,
          date: 1761955200,
          chat: { id: -1008240, type: "supergroup", title: "机密群名" },
          from: { id: 182, first_name: "https://tinyurl.com/from182" },
          text: `http://bit.ly\u00AA/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(kept.status).toBe("event");
    if (kept.status !== "event") {
      return;
    }
    const keptLogger = createMemoryLogger();
    const keptModerator = createMemoryModerator();
    const allowed = await screenTelegramEvent(kept.event, {
      logger: keptLogger,
      moderator: keptModerator,
    });
    expect(allowed.decision.action).toBe("allow");
    expect(keptModerator.deleted).toEqual([]);
    const allowedDump = JSON.stringify({
      result: allowed,
      logs: keptLogger.entries,
    });
    expect(allowedDump).not.toContain("bit.ly");
    expect(allowedDump).not.toContain(path);
    expect(allowedDump).not.toContain("from182");
    expect(allowedDump).not.toContain("机密群名");
  });

  it("joins an ideographic stop between hosts and keeps the short link before a path", async () => {
    const path = "offer183";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2283,
        message: {
          message_id: 2283,
          date: 1761955200,
          chat: { id: -1008241, type: "supergroup", title: "机密群名" },
          from: { id: 183, first_name: "Ada" },
          text: `example.com\u3002bit.ly/${path}`,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toContain("short_link");
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:example.com.bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const kept = await normalizeUpdate({
      update: {
        update_id: 2284,
        message: {
          message_id: 2284,
          date: 1761955200,
          chat: { id: -1008242, type: "supergroup", title: "机密群名" },
          from: { id: 183, first_name: "https://tinyurl.com/from183" },
          text: `bit.ly\u3002evil.com/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(kept.status).toBe("event");
    if (kept.status !== "event") {
      return;
    }
    const keptLogger = createMemoryLogger();
    const keptModerator = createMemoryModerator();
    const allowed = await screenTelegramEvent(kept.event, {
      logger: keptLogger,
      moderator: keptModerator,
    });
    expect(allowed.decision.action).toBe("allow");
    expect(keptModerator.deleted).toEqual([]);
    const allowedDump = JSON.stringify({
      result: allowed,
      logs: keptLogger.entries,
    });
    expect(allowedDump).not.toContain("bit.ly");
    expect(allowedDump).not.toContain(path);
    expect(allowedDump).not.toContain("from183");
    expect(allowedDump).not.toContain("机密群名");
  });

  it("joins a dot lookalike between hosts and keeps the short link before a path", async () => {
    const path = "offer184";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2285,
        message: {
          message_id: 2285,
          date: 1761955200,
          chat: { id: -1008243, type: "supergroup", title: "机密群名" },
          from: { id: 184, first_name: "Ada" },
          text: `example.com\u00B7bit.ly/${path}`,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toContain("short_link");
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:example.com.bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const kept = await normalizeUpdate({
      update: {
        update_id: 2286,
        message: {
          message_id: 2286,
          date: 1761955200,
          chat: { id: -1008244, type: "supergroup", title: "机密群名" },
          from: { id: 184, first_name: "https://tinyurl.com/from184" },
          text: `bit.ly\u00B7evil.com/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(kept.status).toBe("event");
    if (kept.status !== "event") {
      return;
    }
    const keptLogger = createMemoryLogger();
    const keptModerator = createMemoryModerator();
    const allowed = await screenTelegramEvent(kept.event, {
      logger: keptLogger,
      moderator: keptModerator,
    });
    expect(allowed.decision.action).toBe("allow");
    expect(keptModerator.deleted).toEqual([]);
    const allowedDump = JSON.stringify({
      result: allowed,
      logs: keptLogger.entries,
    });
    expect(allowedDump).not.toContain("bit.ly");
    expect(allowedDump).not.toContain(path);
    expect(allowedDump).not.toContain("from184");
    expect(allowedDump).not.toContain("机密群名");
  });

  it("deletes a bare address after a mapped letter and keeps one inside a url", async () => {
    const path = "offer185";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2287,
        message: {
          message_id: 2287,
          date: 1761955200,
          chat: { id: -1008245, type: "supergroup", title: "机密群名" },
          from: { id: 185, first_name: "Ada" },
          text: `a\u00AA203.0.113.10/${path}`,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toContain("ip_host");
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "ip_host:203.0.113.10",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const kept = await normalizeUpdate({
      update: {
        update_id: 2288,
        message: {
          message_id: 2288,
          date: 1761955200,
          chat: { id: -1008246, type: "supergroup", title: "机密群名" },
          from: { id: 185, first_name: "https://tinyurl.com/from185" },
          text: `http://\u00AA203.0.113.10/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(kept.status).toBe("event");
    if (kept.status !== "event") {
      return;
    }
    const keptLogger = createMemoryLogger();
    const keptModerator = createMemoryModerator();
    const allowed = await screenTelegramEvent(kept.event, {
      logger: keptLogger,
      moderator: keptModerator,
    });
    expect(allowed.decision.action).toBe("allow");
    expect(keptModerator.deleted).toEqual([]);
    const allowedDump = JSON.stringify({
      result: allowed,
      logs: keptLogger.entries,
    });
    expect(allowedDump).not.toContain("203.0.113.10");
    expect(allowedDump).not.toContain(path);
    expect(allowedDump).not.toContain("from185");
    expect(allowedDump).not.toContain("机密群名");
  });

  it("deletes a short link before a label tail and keeps one inside a url", async () => {
    const path = "offer186";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2289,
        message: {
          message_id: 2289,
          date: 1761955200,
          chat: { id: -1008247, type: "supergroup", title: "机密群名" },
          from: { id: 186, first_name: "Ada" },
          text: `bit.ly\u70B9203.0.113.10/${path}`,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link", "ip_host"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "ip_host:203.0.113.10",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const kept = await normalizeUpdate({
      update: {
        update_id: 2290,
        message: {
          message_id: 2290,
          date: 1761955200,
          chat: { id: -1008248, type: "supergroup", title: "机密群名" },
          from: { id: 186, first_name: "https://tinyurl.com/from186" },
          text: `http://bit.ly\u70B9203.0.113.10/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(kept.status).toBe("event");
    if (kept.status !== "event") {
      return;
    }
    const keptLogger = createMemoryLogger();
    const keptModerator = createMemoryModerator();
    const allowed = await screenTelegramEvent(kept.event, {
      logger: keptLogger,
      moderator: keptModerator,
    });
    expect(allowed.decision.action).toBe("allow");
    expect(keptModerator.deleted).toEqual([]);
    const allowedDump = JSON.stringify({
      result: allowed,
      logs: keptLogger.entries,
    });
    expect(allowedDump).not.toContain("bit.ly");
    expect(allowedDump).not.toContain("203.0.113.10");
    expect(allowedDump).not.toContain(path);
    expect(allowedDump).not.toContain("from186");
    expect(allowedDump).not.toContain("机密群名");
  });

  it("keeps a mixed label on one host and still deletes the short suffix", async () => {
    const path = "offer187";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2291,
        message: {
          message_id: 2291,
          date: 1761955200,
          chat: { id: -1008249, type: "supergroup", title: "机密群名" },
          from: { id: 187, first_name: "Ada" },
          text: `example.com\u70B9.bit.ly/${path}`,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:example.comx.bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const kept = await normalizeUpdate({
      update: {
        update_id: 2292,
        message: {
          message_id: 2292,
          date: 1761955200,
          chat: { id: -1008250, type: "supergroup", title: "机密群名" },
          from: { id: 187, first_name: "https://tinyurl.com/from187" },
          text: `bit.ly\u70B9\u65E5\u672C.com/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(kept.status).toBe("event");
    if (kept.status !== "event") {
      return;
    }
    const keptLogger = createMemoryLogger();
    const keptModerator = createMemoryModerator();
    const allowed = await screenTelegramEvent(kept.event, {
      logger: keptLogger,
      moderator: keptModerator,
    });
    expect(allowed.decision.action).toBe("allow");
    expect(keptModerator.deleted).toEqual([]);
    const allowedDump = JSON.stringify({
      result: allowed,
      logs: keptLogger.entries,
    });
    expect(allowedDump).not.toContain("bit.ly");
    expect(allowedDump).not.toContain(path);
    expect(allowedDump).not.toContain("from187");
    expect(allowedDump).not.toContain("机密群名");
  });

  it("keeps a unicode label after the dot and still deletes a fake tail", async () => {
    const path = "offer188";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2293,
        message: {
          message_id: 2293,
          date: 1761955200,
          chat: { id: -1008251, type: "supergroup", title: "机密群名" },
          from: { id: 188, first_name: "Ada" },
          text: `bit.ly\u70B9.\u65E5\u672C.notarealtld/${path}`,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const kept = await normalizeUpdate({
      update: {
        update_id: 2294,
        message: {
          message_id: 2294,
          date: 1761955200,
          chat: { id: -1008252, type: "supergroup", title: "机密群名" },
          from: { id: 188, first_name: "https://tinyurl.com/from188" },
          text: `bit.ly\u70B9.\u65E5\u672C.com/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(kept.status).toBe("event");
    if (kept.status !== "event") {
      return;
    }
    const keptLogger = createMemoryLogger();
    const keptModerator = createMemoryModerator();
    const allowed = await screenTelegramEvent(kept.event, {
      logger: keptLogger,
      moderator: keptModerator,
    });
    expect(allowed.decision.action).toBe("allow");
    expect(keptModerator.deleted).toEqual([]);
    const allowedDump = JSON.stringify({
      result: allowed,
      logs: keptLogger.entries,
    });
    expect(allowedDump).not.toContain("bit.ly");
    expect(allowedDump).not.toContain(path);
    expect(allowedDump).not.toContain("from188");
    expect(allowedDump).not.toContain("机密群名");
  });

  it("keeps a unicode label after an ideographic stop", async () => {
    const path = "offer189";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2295,
        message: {
          message_id: 2295,
          date: 1761955200,
          chat: { id: -1008253, type: "supergroup", title: "机密群名" },
          from: { id: 189, first_name: "Ada" },
          text: `bit.ly\u3002com/${path}`,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const kept = await normalizeUpdate({
      update: {
        update_id: 2296,
        message: {
          message_id: 2296,
          date: 1761955200,
          chat: { id: -1008254, type: "supergroup", title: "机密群名" },
          from: { id: 189, first_name: "https://tinyurl.com/from189" },
          text: `bit.ly\u3002\u65E5\u672C.com/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(kept.status).toBe("event");
    if (kept.status !== "event") {
      return;
    }
    const keptLogger = createMemoryLogger();
    const keptModerator = createMemoryModerator();
    const allowed = await screenTelegramEvent(kept.event, {
      logger: keptLogger,
      moderator: keptModerator,
    });
    expect(allowed.decision.action).toBe("allow");
    expect(keptModerator.deleted).toEqual([]);
    const allowedDump = JSON.stringify({
      result: allowed,
      logs: keptLogger.entries,
    });
    expect(allowedDump).not.toContain("bit.ly");
    expect(allowedDump).not.toContain(path);
    expect(allowedDump).not.toContain("from189");
    expect(allowedDump).not.toContain("机密群名");
  });

  it("keeps a dot lookalike inside a schemed label", async () => {
    const path = "offer190";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2297,
        message: {
          message_id: 2297,
          date: 1761955200,
          chat: { id: -1008255, type: "supergroup", title: "机密群名" },
          from: { id: 190, first_name: "Ada" },
          text: `bit.ly\u00B7/${path}`,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const kept = await normalizeUpdate({
      update: {
        update_id: 2298,
        message: {
          message_id: 2298,
          date: 1761955200,
          chat: { id: -1008256, type: "supergroup", title: "机密群名" },
          from: { id: 190, first_name: "https://tinyurl.com/from190" },
          text: `http://bit.ly\u00B7/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(kept.status).toBe("event");
    if (kept.status !== "event") {
      return;
    }
    const keptLogger = createMemoryLogger();
    const keptModerator = createMemoryModerator();
    const allowed = await screenTelegramEvent(kept.event, {
      logger: keptLogger,
      moderator: keptModerator,
    });
    expect(allowed.decision.action).toBe("allow");
    expect(keptModerator.deleted).toEqual([]);
    const allowedDump = JSON.stringify({
      result: allowed,
      logs: keptLogger.entries,
    });
    expect(allowedDump).not.toContain("bit.ly");
    expect(allowedDump).not.toContain(path);
    expect(allowedDump).not.toContain("from190");
    expect(allowedDump).not.toContain("机密群名");
  });

  it("keeps a schemed script letter inside the host", async () => {
    const path = "offer191";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2299,
        message: {
          message_id: 2299,
          date: 1761955200,
          chat: { id: -1008257, type: "supergroup", title: "机密群名" },
          from: { id: 191, first_name: "Ada" },
          text: `bit.ly\u03B1/${path}`,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const kept = await normalizeUpdate({
      update: {
        update_id: 2300,
        message: {
          message_id: 2300,
          date: 1761955200,
          chat: { id: -1008258, type: "supergroup", title: "机密群名" },
          from: { id: 191, first_name: "https://tinyurl.com/from191" },
          text: `http://bit.ly\u03B1/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(kept.status).toBe("event");
    if (kept.status !== "event") {
      return;
    }
    const keptLogger = createMemoryLogger();
    const keptModerator = createMemoryModerator();
    const allowed = await screenTelegramEvent(kept.event, {
      logger: keptLogger,
      moderator: keptModerator,
    });
    expect(allowed.decision.action).toBe("allow");
    expect(keptModerator.deleted).toEqual([]);
    const allowedDump = JSON.stringify({
      result: allowed,
      logs: keptLogger.entries,
    });
    expect(allowedDump).not.toContain("bit.ly");
    expect(allowedDump).not.toContain(path);
    expect(allowedDump).not.toContain("from191");
    expect(allowedDump).not.toContain("机密群名");
  });

  it("keeps a dotted script label on a schemed host", async () => {
    const path = "offer192";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2301,
        message: {
          message_id: 2301,
          date: 1761955200,
          chat: { id: -1008259, type: "supergroup", title: "机密群名" },
          from: { id: 192, first_name: "Ada" },
          text: `bit.ly.\u03B1/${path}`,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const kept = await normalizeUpdate({
      update: {
        update_id: 2302,
        message: {
          message_id: 2302,
          date: 1761955200,
          chat: { id: -1008260, type: "supergroup", title: "机密群名" },
          from: { id: 192, first_name: "https://tinyurl.com/from192" },
          text: `http://bit.ly.\u03B1/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(kept.status).toBe("event");
    if (kept.status !== "event") {
      return;
    }
    const keptLogger = createMemoryLogger();
    const keptModerator = createMemoryModerator();
    const allowed = await screenTelegramEvent(kept.event, {
      logger: keptLogger,
      moderator: keptModerator,
    });
    expect(allowed.decision.action).toBe("allow");
    expect(keptModerator.deleted).toEqual([]);
    const allowedDump = JSON.stringify({
      result: allowed,
      logs: keptLogger.entries,
    });
    expect(allowedDump).not.toContain("bit.ly");
    expect(allowedDump).not.toContain(path);
    expect(allowedDump).not.toContain("from192");
    expect(allowedDump).not.toContain("机密群名");
  });

  it("keeps a script letter after a schemed ideographic dot", async () => {
    const path = "offer193";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2303,
        message: {
          message_id: 2303,
          date: 1761955200,
          chat: { id: -1008261, type: "supergroup", title: "机密群名" },
          from: { id: 193, first_name: "Ada" },
          text: `bit.ly\u3002\u03B1/${path}`,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const kept = await normalizeUpdate({
      update: {
        update_id: 2304,
        message: {
          message_id: 2304,
          date: 1761955200,
          chat: { id: -1008262, type: "supergroup", title: "机密群名" },
          from: { id: 193, first_name: "https://tinyurl.com/from193" },
          text: `http://bit.ly\u3002\u03B1/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(kept.status).toBe("event");
    if (kept.status !== "event") {
      return;
    }
    const keptLogger = createMemoryLogger();
    const keptModerator = createMemoryModerator();
    const allowed = await screenTelegramEvent(kept.event, {
      logger: keptLogger,
      moderator: keptModerator,
    });
    expect(allowed.decision.action).toBe("allow");
    expect(keptModerator.deleted).toEqual([]);
    const allowedDump = JSON.stringify({
      result: allowed,
      logs: keptLogger.entries,
    });
    expect(allowedDump).not.toContain("bit.ly");
    expect(allowedDump).not.toContain(path);
    expect(allowedDump).not.toContain("from193");
    expect(allowedDump).not.toContain("机密群名");
  });

  it("keeps a script letter after an ignored schemed mark", async () => {
    const path = "offer194";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2305,
        message: {
          message_id: 2305,
          date: 1761955200,
          chat: { id: -1008263, type: "supergroup", title: "机密群名" },
          from: { id: 194, first_name: "Ada" },
          text: `bit.ly\u200B\u03B1/${path}`,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const kept = await normalizeUpdate({
      update: {
        update_id: 2306,
        message: {
          message_id: 2306,
          date: 1761955200,
          chat: { id: -1008264, type: "supergroup", title: "机密群名" },
          from: { id: 194, first_name: "https://tinyurl.com/from194" },
          text: `http://bit.ly\u200B\u03B1/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(kept.status).toBe("event");
    if (kept.status !== "event") {
      return;
    }
    const keptLogger = createMemoryLogger();
    const keptModerator = createMemoryModerator();
    const allowed = await screenTelegramEvent(kept.event, {
      logger: keptLogger,
      moderator: keptModerator,
    });
    expect(allowed.decision.action).toBe("allow");
    expect(keptModerator.deleted).toEqual([]);
    const allowedDump = JSON.stringify({
      result: allowed,
      logs: keptLogger.entries,
    });
    expect(allowedDump).not.toContain("bit.ly");
    expect(allowedDump).not.toContain(path);
    expect(allowedDump).not.toContain("from194");
    expect(allowedDump).not.toContain("机密群名");
  });

  it("keeps a script letter after a buried schemed mark", async () => {
    const path = "offer195";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2307,
        message: {
          message_id: 2307,
          date: 1761955200,
          chat: { id: -1008265, type: "supergroup", title: "机密群名" },
          from: { id: 195, first_name: "Ada" },
          text: `bit\u200B.ly\u03B1/${path}`,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const kept = await normalizeUpdate({
      update: {
        update_id: 2308,
        message: {
          message_id: 2308,
          date: 1761955200,
          chat: { id: -1008266, type: "supergroup", title: "机密群名" },
          from: { id: 195, first_name: "https://tinyurl.com/from195" },
          text: `http://bit\u200B.ly\u03B1/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(kept.status).toBe("event");
    if (kept.status !== "event") {
      return;
    }
    const keptLogger = createMemoryLogger();
    const keptModerator = createMemoryModerator();
    const allowed = await screenTelegramEvent(kept.event, {
      logger: keptLogger,
      moderator: keptModerator,
    });
    expect(allowed.decision.action).toBe("allow");
    expect(keptModerator.deleted).toEqual([]);
    const allowedDump = JSON.stringify({
      result: allowed,
      logs: keptLogger.entries,
    });
    expect(allowedDump).not.toContain("bit.ly");
    expect(allowedDump).not.toContain(path);
    expect(allowedDump).not.toContain("from195");
    expect(allowedDump).not.toContain("机密群名");
  });

  it("keeps a script letter after a buried nonspacing mark", async () => {
    const path = "offer196";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2309,
        message: {
          message_id: 2309,
          date: 1761955200,
          chat: { id: -1008267, type: "supergroup", title: "机密群名" },
          from: { id: 196, first_name: "Ada" },
          text: `bit\u034F.ly\u03B1/${path}`,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const kept = await normalizeUpdate({
      update: {
        update_id: 2310,
        message: {
          message_id: 2310,
          date: 1761955200,
          chat: { id: -1008268, type: "supergroup", title: "机密群名" },
          from: { id: 196, first_name: "https://tinyurl.com/from196" },
          text: `http://bit\u034F.ly\u03B1/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(kept.status).toBe("event");
    if (kept.status !== "event") {
      return;
    }
    const keptLogger = createMemoryLogger();
    const keptModerator = createMemoryModerator();
    const allowed = await screenTelegramEvent(kept.event, {
      logger: keptLogger,
      moderator: keptModerator,
    });
    expect(allowed.decision.action).toBe("allow");
    expect(keptModerator.deleted).toEqual([]);
    const allowedDump = JSON.stringify({
      result: allowed,
      logs: keptLogger.entries,
    });
    expect(allowedDump).not.toContain("bit.ly");
    expect(allowedDump).not.toContain(path);
    expect(allowedDump).not.toContain("from196");
    expect(allowedDump).not.toContain("机密群名");
  });

  it("keeps a script letter after a schemed hyphen", async () => {
    const path = "offer197";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2311,
        message: {
          message_id: 2311,
          date: 1761955200,
          chat: { id: -1008269, type: "supergroup", title: "机密群名" },
          from: { id: 197, first_name: "Ada" },
          text: `bit.ly-\u03B1/${path}`,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const kept = await normalizeUpdate({
      update: {
        update_id: 2312,
        message: {
          message_id: 2312,
          date: 1761955200,
          chat: { id: -1008270, type: "supergroup", title: "机密群名" },
          from: { id: 197, first_name: "https://tinyurl.com/from197" },
          text: `http://bit.ly-\u03B1/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(kept.status).toBe("event");
    if (kept.status !== "event") {
      return;
    }
    const keptLogger = createMemoryLogger();
    const keptModerator = createMemoryModerator();
    const allowed = await screenTelegramEvent(kept.event, {
      logger: keptLogger,
      moderator: keptModerator,
    });
    expect(allowed.decision.action).toBe("allow");
    expect(keptModerator.deleted).toEqual([]);
    const allowedDump = JSON.stringify({
      result: allowed,
      logs: keptLogger.entries,
    });
    expect(allowedDump).not.toContain("bit.ly");
    expect(allowedDump).not.toContain(path);
    expect(allowedDump).not.toContain("from197");
    expect(allowedDump).not.toContain("机密群名");
  });

  it("reads a call username draft and leaves a group call slug", async () => {
    const path = "offer198";
    const slug = "room198";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2313,
        message: {
          message_id: 2313,
          date: 1761955200,
          chat: { id: -1008271, type: "supergroup", title: "机密群名" },
          from: { id: 198, first_name: "Ada" },
          text: `https://t.me/call?text=https://bit.ly/${path}`,
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
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const kept = await normalizeUpdate({
      update: {
        update_id: 2314,
        message: {
          message_id: 2314,
          date: 1761955200,
          chat: { id: -1008272, type: "supergroup", title: "机密群名" },
          from: { id: 198, first_name: "https://tinyurl.com/from198" },
          text: `https://t.me/call/${slug}?text=https://bit.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(kept.status).toBe("event");
    if (kept.status !== "event") {
      return;
    }
    const keptLogger = createMemoryLogger();
    const keptModerator = createMemoryModerator();
    const allowed = await screenTelegramEvent(kept.event, {
      logger: keptLogger,
      moderator: keptModerator,
    });
    expect(allowed.decision.action).toBe("allow");
    expect(keptModerator.deleted).toEqual([]);
    const allowedDump = JSON.stringify({
      result: allowed,
      logs: keptLogger.entries,
    });
    expect(allowedDump).not.toContain("bit.ly");
    expect(allowedDump).not.toContain(path);
    expect(allowedDump).not.toContain(slug);
    expect(allowedDump).not.toContain("from198");
    expect(allowedDump).not.toContain("机密群名");
  });

  it("skips a profile link and still reads an overridden draft", async () => {
    const path = "offer199";
    const opened = await normalizeUpdate({
      update: {
        update_id: 2315,
        message: {
          message_id: 2315,
          date: 1761955200,
          chat: { id: -1008273, type: "supergroup", title: "机密群名" },
          from: { id: 199, first_name: "Ada" },
          text: `https://t.me/durov?profile=0&text=https://bit.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(opened.status).toBe("event");
    if (opened.status !== "event") {
      return;
    }
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(opened.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const kept = await normalizeUpdate({
      update: {
        update_id: 2316,
        message: {
          message_id: 2316,
          date: 1761955200,
          chat: { id: -1008274, type: "supergroup", title: "机密群名" },
          from: { id: 199, first_name: "https://tinyurl.com/from199" },
          text: `https://t.me/durov?profile=1&text=https://bit.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(kept.status).toBe("event");
    if (kept.status !== "event") {
      return;
    }
    const keptLogger = createMemoryLogger();
    const keptModerator = createMemoryModerator();
    const allowed = await screenTelegramEvent(kept.event, {
      logger: keptLogger,
      moderator: keptModerator,
    });
    expect(allowed.decision.action).toBe("allow");
    expect(keptModerator.deleted).toEqual([]);
    const allowedDump = JSON.stringify({
      result: allowed,
      logs: keptLogger.entries,
    });
    expect(allowedDump).not.toContain("bit.ly");
    expect(allowedDump).not.toContain(path);
    expect(allowedDump).not.toContain("durov");
    expect(allowedDump).not.toContain("from199");
    expect(allowedDump).not.toContain("机密群名");
  });

  it("skips a resolve story and still reads a web story query", async () => {
    const path = "offer200";
    const opened = await normalizeUpdate({
      update: {
        update_id: 2317,
        message: {
          message_id: 2317,
          date: 1761955200,
          chat: { id: -1008275, type: "supergroup", title: "机密群名" },
          from: { id: 200, first_name: "Ada" },
          text: `https://t.me/durov?story=5&text=https://bit.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(opened.status).toBe("event");
    if (opened.status !== "event") {
      return;
    }
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(opened.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const kept = await normalizeUpdate({
      update: {
        update_id: 2318,
        message: {
          message_id: 2318,
          date: 1761955200,
          chat: { id: -1008276, type: "supergroup", title: "机密群名" },
          from: { id: 200, first_name: "https://tinyurl.com/from200" },
          text: `tg://resolve?domain=durov&story=5&text=https://bit.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(kept.status).toBe("event");
    if (kept.status !== "event") {
      return;
    }
    const keptLogger = createMemoryLogger();
    const keptModerator = createMemoryModerator();
    const allowed = await screenTelegramEvent(kept.event, {
      logger: keptLogger,
      moderator: keptModerator,
    });
    expect(allowed.decision.action).toBe("allow");
    expect(keptModerator.deleted).toEqual([]);
    const allowedDump = JSON.stringify({
      result: allowed,
      logs: keptLogger.entries,
    });
    expect(allowedDump).not.toContain("bit.ly");
    expect(allowedDump).not.toContain(path);
    expect(allowedDump).not.toContain("durov");
    expect(allowedDump).not.toContain("from200");
    expect(allowedDump).not.toContain("机密群名");
  });

  it("reads an addstyle username draft and leaves a style slug", async () => {
    const path = "offer201";
    const slug = "tone201";
    const opened = await normalizeUpdate({
      update: {
        update_id: 2319,
        message: {
          message_id: 2319,
          date: 1761955200,
          chat: { id: -1008277, type: "supergroup", title: "机密群名" },
          from: { id: 201, first_name: "Ada" },
          text: `https://t.me/addstyle?text=https://bit.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(opened.status).toBe("event");
    if (opened.status !== "event") {
      return;
    }
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(opened.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const kept = await normalizeUpdate({
      update: {
        update_id: 2320,
        message: {
          message_id: 2320,
          date: 1761955200,
          chat: { id: -1008278, type: "supergroup", title: "机密群名" },
          from: { id: 201, first_name: "https://tinyurl.com/from201" },
          text: `https://t.me/addstyle/${slug}?text=https://bit.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(kept.status).toBe("event");
    if (kept.status !== "event") {
      return;
    }
    const keptLogger = createMemoryLogger();
    const keptModerator = createMemoryModerator();
    const allowed = await screenTelegramEvent(kept.event, {
      logger: keptLogger,
      moderator: keptModerator,
    });
    expect(allowed.decision.action).toBe("allow");
    expect(keptModerator.deleted).toEqual([]);
    const allowedDump = JSON.stringify({
      result: allowed,
      logs: keptLogger.entries,
    });
    expect(allowedDump).not.toContain("bit.ly");
    expect(allowedDump).not.toContain(path);
    expect(allowedDump).not.toContain(slug);
    expect(allowedDump).not.toContain("from201");
    expect(allowedDump).not.toContain("机密群名");
  });

  it("reads an invoice username draft and leaves an invoice slug", async () => {
    const path = "offer202";
    const slug = "pay202";
    const opened = await normalizeUpdate({
      update: {
        update_id: 2321,
        message: {
          message_id: 2321,
          date: 1761955200,
          chat: { id: -1008279, type: "supergroup", title: "机密群名" },
          from: { id: 202, first_name: "Ada" },
          text: `https://t.me/invoice?text=https://bit.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(opened.status).toBe("event");
    if (opened.status !== "event") {
      return;
    }
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(opened.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const kept = await normalizeUpdate({
      update: {
        update_id: 2322,
        message: {
          message_id: 2322,
          date: 1761955200,
          chat: { id: -1008280, type: "supergroup", title: "机密群名" },
          from: { id: 202, first_name: "https://tinyurl.com/from202" },
          text: `https://t.me/invoice/${slug}?text=https://bit.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(kept.status).toBe("event");
    if (kept.status !== "event") {
      return;
    }
    const keptLogger = createMemoryLogger();
    const keptModerator = createMemoryModerator();
    const allowed = await screenTelegramEvent(kept.event, {
      logger: keptLogger,
      moderator: keptModerator,
    });
    expect(allowed.decision.action).toBe("allow");
    expect(keptModerator.deleted).toEqual([]);
    const allowedDump = JSON.stringify({
      result: allowed,
      logs: keptLogger.entries,
    });
    expect(allowedDump).not.toContain("bit.ly");
    expect(allowedDump).not.toContain(path);
    expect(allowedDump).not.toContain(slug);
    expect(allowedDump).not.toContain("from202");
    expect(allowedDump).not.toContain("机密群名");
  });

  it("reads an addemoji username draft and leaves an emoji set", async () => {
    const path = "offer203";
    const slug = "pack203";
    const opened = await normalizeUpdate({
      update: {
        update_id: 2323,
        message: {
          message_id: 2323,
          date: 1761955200,
          chat: { id: -1008281, type: "supergroup", title: "机密群名" },
          from: { id: 203, first_name: "Ada" },
          text: `https://t.me/addemoji?text=https://bit.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(opened.status).toBe("event");
    if (opened.status !== "event") {
      return;
    }
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(opened.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const kept = await normalizeUpdate({
      update: {
        update_id: 2324,
        message: {
          message_id: 2324,
          date: 1761955200,
          chat: { id: -1008282, type: "supergroup", title: "机密群名" },
          from: { id: 203, first_name: "https://tinyurl.com/from203" },
          text: `https://t.me/addemoji/${slug}?text=https://bit.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(kept.status).toBe("event");
    if (kept.status !== "event") {
      return;
    }
    const keptLogger = createMemoryLogger();
    const keptModerator = createMemoryModerator();
    const allowed = await screenTelegramEvent(kept.event, {
      logger: keptLogger,
      moderator: keptModerator,
    });
    expect(allowed.decision.action).toBe("allow");
    expect(keptModerator.deleted).toEqual([]);
    const allowedDump = JSON.stringify({
      result: allowed,
      logs: keptLogger.entries,
    });
    expect(allowedDump).not.toContain("bit.ly");
    expect(allowedDump).not.toContain(path);
    expect(allowedDump).not.toContain(slug);
    expect(allowedDump).not.toContain("from203");
    expect(allowedDump).not.toContain("机密群名");
  });

  it("reads an addstickers username draft and leaves a sticker set", async () => {
    const path = "offer204";
    const slug = "pack204";
    const opened = await normalizeUpdate({
      update: {
        update_id: 2325,
        message: {
          message_id: 2325,
          date: 1761955200,
          chat: { id: -1008283, type: "supergroup", title: "机密群名" },
          from: { id: 204, first_name: "Ada" },
          text: `https://t.me/addstickers?text=https://bit.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(opened.status).toBe("event");
    if (opened.status !== "event") {
      return;
    }
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(opened.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const kept = await normalizeUpdate({
      update: {
        update_id: 2326,
        message: {
          message_id: 2326,
          date: 1761955200,
          chat: { id: -1008284, type: "supergroup", title: "机密群名" },
          from: { id: 204, first_name: "https://tinyurl.com/from204" },
          text: `https://t.me/addstickers/${slug}?text=https://bit.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(kept.status).toBe("event");
    if (kept.status !== "event") {
      return;
    }
    const keptLogger = createMemoryLogger();
    const keptModerator = createMemoryModerator();
    const allowed = await screenTelegramEvent(kept.event, {
      logger: keptLogger,
      moderator: keptModerator,
    });
    expect(allowed.decision.action).toBe("allow");
    expect(keptModerator.deleted).toEqual([]);
    const allowedDump = JSON.stringify({
      result: allowed,
      logs: keptLogger.entries,
    });
    expect(allowedDump).not.toContain("bit.ly");
    expect(allowedDump).not.toContain(path);
    expect(allowedDump).not.toContain(slug);
    expect(allowedDump).not.toContain("from204");
    expect(allowedDump).not.toContain("机密群名");
  });

  it("reads an addtheme username draft and leaves a theme slug", async () => {
    const path = "offer205";
    const slug = "theme205";
    const opened = await normalizeUpdate({
      update: {
        update_id: 2327,
        message: {
          message_id: 2327,
          date: 1761955200,
          chat: { id: -1008285, type: "supergroup", title: "机密群名" },
          from: { id: 205, first_name: "Ada" },
          text: `https://t.me/addtheme?text=https://bit.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(opened.status).toBe("event");
    if (opened.status !== "event") {
      return;
    }
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(opened.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const kept = await normalizeUpdate({
      update: {
        update_id: 2328,
        message: {
          message_id: 2328,
          date: 1761955200,
          chat: { id: -1008286, type: "supergroup", title: "机密群名" },
          from: { id: 205, first_name: "https://tinyurl.com/from205" },
          text: `https://t.me/addtheme/${slug}?text=https://bit.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(kept.status).toBe("event");
    if (kept.status !== "event") {
      return;
    }
    const keptLogger = createMemoryLogger();
    const keptModerator = createMemoryModerator();
    const allowed = await screenTelegramEvent(kept.event, {
      logger: keptLogger,
      moderator: keptModerator,
    });
    expect(allowed.decision.action).toBe("allow");
    expect(keptModerator.deleted).toEqual([]);
    const allowedDump = JSON.stringify({
      result: allowed,
      logs: keptLogger.entries,
    });
    expect(allowedDump).not.toContain("bit.ly");
    expect(allowedDump).not.toContain(path);
    expect(allowedDump).not.toContain(slug);
    expect(allowedDump).not.toContain("from205");
    expect(allowedDump).not.toContain("机密群名");
  });

  it("reads a setlanguage username draft and leaves a language pack", async () => {
    const path = "offer206";
    const slug = "lang206";
    const opened = await normalizeUpdate({
      update: {
        update_id: 2329,
        message: {
          message_id: 2329,
          date: 1761955200,
          chat: { id: -1008287, type: "supergroup", title: "机密群名" },
          from: { id: 206, first_name: "Ada" },
          text: `https://t.me/setlanguage?text=https://bit.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(opened.status).toBe("event");
    if (opened.status !== "event") {
      return;
    }
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(opened.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const kept = await normalizeUpdate({
      update: {
        update_id: 2330,
        message: {
          message_id: 2330,
          date: 1761955200,
          chat: { id: -1008288, type: "supergroup", title: "机密群名" },
          from: { id: 206, first_name: "https://tinyurl.com/from206" },
          text: `https://t.me/setlanguage/${slug}?text=https://bit.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(kept.status).toBe("event");
    if (kept.status !== "event") {
      return;
    }
    const keptLogger = createMemoryLogger();
    const keptModerator = createMemoryModerator();
    const allowed = await screenTelegramEvent(kept.event, {
      logger: keptLogger,
      moderator: keptModerator,
    });
    expect(allowed.decision.action).toBe("allow");
    expect(keptModerator.deleted).toEqual([]);
    const allowedDump = JSON.stringify({
      result: allowed,
      logs: keptLogger.entries,
    });
    expect(allowedDump).not.toContain("bit.ly");
    expect(allowedDump).not.toContain(path);
    expect(allowedDump).not.toContain(slug);
    expect(allowedDump).not.toContain("from206");
    expect(allowedDump).not.toContain("机密群名");
  });

  it("reads an nft username draft and leaves a gift slug", async () => {
    const path = "offer207";
    const slug = "gift207";
    const opened = await normalizeUpdate({
      update: {
        update_id: 2331,
        message: {
          message_id: 2331,
          date: 1761955200,
          chat: { id: -1008289, type: "supergroup", title: "机密群名" },
          from: { id: 207, first_name: "Ada" },
          text: `https://t.me/nft?text=https://bit.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(opened.status).toBe("event");
    if (opened.status !== "event") {
      return;
    }
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(opened.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const kept = await normalizeUpdate({
      update: {
        update_id: 2332,
        message: {
          message_id: 2332,
          date: 1761955200,
          chat: { id: -1008290, type: "supergroup", title: "机密群名" },
          from: { id: 207, first_name: "https://tinyurl.com/from207" },
          text: `https://t.me/nft/${slug}?text=https://bit.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(kept.status).toBe("event");
    if (kept.status !== "event") {
      return;
    }
    const keptLogger = createMemoryLogger();
    const keptModerator = createMemoryModerator();
    const allowed = await screenTelegramEvent(kept.event, {
      logger: keptLogger,
      moderator: keptModerator,
    });
    expect(allowed.decision.action).toBe("allow");
    expect(keptModerator.deleted).toEqual([]);
    const allowedDump = JSON.stringify({
      result: allowed,
      logs: keptLogger.entries,
    });
    expect(allowedDump).not.toContain("bit.ly");
    expect(allowedDump).not.toContain(path);
    expect(allowedDump).not.toContain(slug);
    expect(allowedDump).not.toContain("from207");
    expect(allowedDump).not.toContain("机密群名");
  });

  it("reads an auction username draft and leaves an auction slug", async () => {
    const path = "offer208";
    const slug = "lot208";
    const opened = await normalizeUpdate({
      update: {
        update_id: 2333,
        message: {
          message_id: 2333,
          date: 1761955200,
          chat: { id: -1008291, type: "supergroup", title: "机密群名" },
          from: { id: 208, first_name: "Ada" },
          text: `https://t.me/auction?text=https://bit.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(opened.status).toBe("event");
    if (opened.status !== "event") {
      return;
    }
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(opened.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const kept = await normalizeUpdate({
      update: {
        update_id: 2334,
        message: {
          message_id: 2334,
          date: 1761955200,
          chat: { id: -1008292, type: "supergroup", title: "机密群名" },
          from: { id: 208, first_name: "https://tinyurl.com/from208" },
          text: `https://t.me/auction/${slug}?text=https://bit.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(kept.status).toBe("event");
    if (kept.status !== "event") {
      return;
    }
    const keptLogger = createMemoryLogger();
    const keptModerator = createMemoryModerator();
    const allowed = await screenTelegramEvent(kept.event, {
      logger: keptLogger,
      moderator: keptModerator,
    });
    expect(allowed.decision.action).toBe("allow");
    expect(keptModerator.deleted).toEqual([]);
    const allowedDump = JSON.stringify({
      result: allowed,
      logs: keptLogger.entries,
    });
    expect(allowedDump).not.toContain("bit.ly");
    expect(allowedDump).not.toContain(path);
    expect(allowedDump).not.toContain(slug);
    expect(allowedDump).not.toContain("from208");
    expect(allowedDump).not.toContain("机密群名");
  });

  it("reads a bg username draft and leaves a wallpaper slug", async () => {
    const path = "offer209";
    const slug = "paper209";
    const opened = await normalizeUpdate({
      update: {
        update_id: 2335,
        message: {
          message_id: 2335,
          date: 1761955200,
          chat: { id: -1008293, type: "supergroup", title: "机密群名" },
          from: { id: 209, first_name: "Ada" },
          text: `https://t.me/bg?text=https://bit.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(opened.status).toBe("event");
    if (opened.status !== "event") {
      return;
    }
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(opened.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const kept = await normalizeUpdate({
      update: {
        update_id: 2336,
        message: {
          message_id: 2336,
          date: 1761955200,
          chat: { id: -1008294, type: "supergroup", title: "机密群名" },
          from: { id: 209, first_name: "https://tinyurl.com/from209" },
          text: `https://t.me/bg/${slug}?text=https://bit.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(kept.status).toBe("event");
    if (kept.status !== "event") {
      return;
    }
    const keptLogger = createMemoryLogger();
    const keptModerator = createMemoryModerator();
    const allowed = await screenTelegramEvent(kept.event, {
      logger: keptLogger,
      moderator: keptModerator,
    });
    expect(allowed.decision.action).toBe("allow");
    expect(keptModerator.deleted).toEqual([]);
    const allowedDump = JSON.stringify({
      result: allowed,
      logs: keptLogger.entries,
    });
    expect(allowedDump).not.toContain("bit.ly");
    expect(allowedDump).not.toContain(path);
    expect(allowedDump).not.toContain(slug);
    expect(allowedDump).not.toContain("from209");
    expect(allowedDump).not.toContain("机密群名");
  });

  it("reads a contact username draft and leaves a contact token", async () => {
    const path = "offer210";
    const slug = "token210";
    const opened = await normalizeUpdate({
      update: {
        update_id: 2337,
        message: {
          message_id: 2337,
          date: 1761955200,
          chat: { id: -1008295, type: "supergroup", title: "机密群名" },
          from: { id: 210, first_name: "Ada" },
          text: `https://t.me/contact?text=https://bit.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(opened.status).toBe("event");
    if (opened.status !== "event") {
      return;
    }
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(opened.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const kept = await normalizeUpdate({
      update: {
        update_id: 2338,
        message: {
          message_id: 2338,
          date: 1761955200,
          chat: { id: -1008296, type: "supergroup", title: "机密群名" },
          from: { id: 210, first_name: "https://tinyurl.com/from210" },
          text: `https://t.me/contact/${slug}?text=https://bit.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(kept.status).toBe("event");
    if (kept.status !== "event") {
      return;
    }
    const keptLogger = createMemoryLogger();
    const keptModerator = createMemoryModerator();
    const allowed = await screenTelegramEvent(kept.event, {
      logger: keptLogger,
      moderator: keptModerator,
    });
    expect(allowed.decision.action).toBe("allow");
    expect(keptModerator.deleted).toEqual([]);
    const allowedDump = JSON.stringify({
      result: allowed,
      logs: keptLogger.entries,
    });
    expect(allowedDump).not.toContain("bit.ly");
    expect(allowedDump).not.toContain(path);
    expect(allowedDump).not.toContain(slug);
    expect(allowedDump).not.toContain("from210");
    expect(allowedDump).not.toContain("机密群名");
  });

  it("reads a login username draft including a login code", async () => {
    const path = "offer211";
    const slug = "code211";
    const opened = await normalizeUpdate({
      update: {
        update_id: 2339,
        message: {
          message_id: 2339,
          date: 1761955200,
          chat: { id: -1008297, type: "supergroup", title: "机密群名" },
          from: { id: 211, first_name: "Ada" },
          text: `https://t.me/login?text=https://bit.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(opened.status).toBe("event");
    if (opened.status !== "event") {
      return;
    }
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(opened.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const coded = await normalizeUpdate({
      update: {
        update_id: 2340,
        message: {
          message_id: 2340,
          date: 1761955200,
          chat: { id: -1008298, type: "supergroup", title: "机密群名" },
          from: { id: 211, first_name: "https://tinyurl.com/from211" },
          text: `https://t.me/login/${slug}?text=https://bit.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(coded.status).toBe("event");
    if (coded.status !== "event") {
      return;
    }
    const codedLogger = createMemoryLogger();
    const codedModerator = createMemoryModerator();
    const deleted = await screenTelegramEvent(coded.event, {
      logger: codedLogger,
      moderator: codedModerator,
    });
    expect(deleted.decision.action).toBe("delete");
    expect(deleted.decision.reasons).toEqual(["short_link"]);
    const codedDump = JSON.stringify({
      result: deleted,
      logs: codedLogger.entries,
    });
    expect(codedDump).not.toContain(path);
    expect(codedDump).not.toContain(slug);
    expect(codedDump).not.toContain("from211");
    expect(codedDump).not.toContain("机密群名");
  });

  it("reads a newbot username draft and leaves a managed bot", async () => {
    const path = "offer212";
    const slug = "manager212";
    const opened = await normalizeUpdate({
      update: {
        update_id: 2341,
        message: {
          message_id: 2341,
          date: 1761955200,
          chat: { id: -1008299, type: "supergroup", title: "机密群名" },
          from: { id: 212, first_name: "Ada" },
          text: `https://t.me/newbot?text=https://bit.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(opened.status).toBe("event");
    if (opened.status !== "event") {
      return;
    }
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(opened.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const kept = await normalizeUpdate({
      update: {
        update_id: 2342,
        message: {
          message_id: 2342,
          date: 1761955200,
          chat: { id: -1008300, type: "supergroup", title: "机密群名" },
          from: { id: 212, first_name: "https://tinyurl.com/from212" },
          text: `https://t.me/newbot/${slug}?text=https://bit.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(kept.status).toBe("event");
    if (kept.status !== "event") {
      return;
    }
    const keptLogger = createMemoryLogger();
    const keptModerator = createMemoryModerator();
    const allowed = await screenTelegramEvent(kept.event, {
      logger: keptLogger,
      moderator: keptModerator,
    });
    expect(allowed.decision.action).toBe("allow");
    expect(keptModerator.deleted).toEqual([]);
    const allowedDump = JSON.stringify({
      result: allowed,
      logs: keptLogger.entries,
    });
    expect(allowedDump).not.toContain("bit.ly");
    expect(allowedDump).not.toContain(path);
    expect(allowedDump).not.toContain(slug);
    expect(allowedDump).not.toContain("from212");
    expect(allowedDump).not.toContain("机密群名");
  });

  it("reads a gift preview username draft including a preview slug", async () => {
    const path = "offer213";
    const slug = "slug213";
    const opened = await normalizeUpdate({
      update: {
        update_id: 2343,
        message: {
          message_id: 2343,
          date: 1761955200,
          chat: { id: -1008301, type: "supergroup", title: "机密群名" },
          from: { id: 213, first_name: "Ada" },
          text: `https://t.me/stargift_preview?text=https://bit.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(opened.status).toBe("event");
    if (opened.status !== "event") {
      return;
    }
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(opened.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const previewed = await normalizeUpdate({
      update: {
        update_id: 2344,
        message: {
          message_id: 2344,
          date: 1761955200,
          chat: { id: -1008302, type: "supergroup", title: "机密群名" },
          from: { id: 213, first_name: "https://tinyurl.com/from213" },
          text: `https://t.me/stargift_preview/${slug}?text=https://bit.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(previewed.status).toBe("event");
    if (previewed.status !== "event") {
      return;
    }
    const previewLogger = createMemoryLogger();
    const previewModerator = createMemoryModerator();
    const deleted = await screenTelegramEvent(previewed.event, {
      logger: previewLogger,
      moderator: previewModerator,
    });
    expect(deleted.decision.action).toBe("delete");
    expect(deleted.decision.reasons).toEqual(["short_link"]);
    const previewDump = JSON.stringify({
      result: deleted,
      logs: previewLogger.entries,
    });
    expect(previewDump).not.toContain(path);
    expect(previewDump).not.toContain(slug);
    expect(previewDump).not.toContain("from213");
    expect(previewDump).not.toContain("机密群名");
  });

  it("reads a gift auction username draft including an auction slug", async () => {
    const path = "offer214";
    const slug = "slug214";
    const opened = await normalizeUpdate({
      update: {
        update_id: 2345,
        message: {
          message_id: 2345,
          date: 1761955200,
          chat: { id: -1008303, type: "supergroup", title: "机密群名" },
          from: { id: 214, first_name: "Ada" },
          text: `https://t.me/stargift_auction?text=https://bit.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(opened.status).toBe("event");
    if (opened.status !== "event") {
      return;
    }
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(opened.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const auctioned = await normalizeUpdate({
      update: {
        update_id: 2346,
        message: {
          message_id: 2346,
          date: 1761955200,
          chat: { id: -1008304, type: "supergroup", title: "机密群名" },
          from: { id: 214, first_name: "https://tinyurl.com/from214" },
          text: `https://t.me/stargift_auction/${slug}?text=https://bit.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(auctioned.status).toBe("event");
    if (auctioned.status !== "event") {
      return;
    }
    const auctionLogger = createMemoryLogger();
    const auctionModerator = createMemoryModerator();
    const deleted = await screenTelegramEvent(auctioned.event, {
      logger: auctionLogger,
      moderator: auctionModerator,
    });
    expect(deleted.decision.action).toBe("delete");
    expect(deleted.decision.reasons).toEqual(["short_link"]);
    const auctionDump = JSON.stringify({
      result: deleted,
      logs: auctionLogger.entries,
    });
    expect(auctionDump).not.toContain(path);
    expect(auctionDump).not.toContain(slug);
    expect(auctionDump).not.toContain("from214");
    expect(auctionDump).not.toContain("机密群名");
  });

  it("reads a boost username draft and leaves a boosted channel", async () => {
    const path = "offer215";
    const slug = "name215";
    const opened = await normalizeUpdate({
      update: {
        update_id: 2347,
        message: {
          message_id: 2347,
          date: 1761955200,
          chat: { id: -1008305, type: "supergroup", title: "机密群名" },
          from: { id: 215, first_name: "Ada" },
          text: `https://t.me/boost?text=https://bit.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(opened.status).toBe("event");
    if (opened.status !== "event") {
      return;
    }
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(opened.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const boosted = await normalizeUpdate({
      update: {
        update_id: 2348,
        message: {
          message_id: 2348,
          date: 1761955200,
          chat: { id: -1008306, type: "supergroup", title: "机密群名" },
          from: { id: 215, first_name: "https://tinyurl.com/from215" },
          text: `https://t.me/boost/${slug}?text=https://bit.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(boosted.status).toBe("event");
    if (boosted.status !== "event") {
      return;
    }
    const boostedLogger = createMemoryLogger();
    const boostedModerator = createMemoryModerator();
    const allowed = await screenTelegramEvent(boosted.event, {
      logger: boostedLogger,
      moderator: boostedModerator,
    });
    expect(allowed.decision.action).toBe("allow");
    expect(boostedModerator.deleted).toEqual([]);
    const allowedDump = JSON.stringify({
      result: allowed,
      logs: boostedLogger.entries,
    });
    expect(allowedDump).not.toContain("bit.ly");
    expect(allowedDump).not.toContain(path);
    expect(allowedDump).not.toContain(slug);
    expect(allowedDump).not.toContain("from215");
    expect(allowedDump).not.toContain("机密群名");
  });

  it("reads a web username draft including an app name", async () => {
    const path = "offer216";
    const slug = "slug216";
    const opened = await normalizeUpdate({
      update: {
        update_id: 2349,
        message: {
          message_id: 2349,
          date: 1761955200,
          chat: { id: -1008307, type: "supergroup", title: "机密群名" },
          from: { id: 216, first_name: "Ada" },
          text: `https://t.me/web?text=https://bit.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(opened.status).toBe("event");
    if (opened.status !== "event") {
      return;
    }
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(opened.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const openedApp = await normalizeUpdate({
      update: {
        update_id: 2350,
        message: {
          message_id: 2350,
          date: 1761955200,
          chat: { id: -1008308, type: "supergroup", title: "机密群名" },
          from: { id: 216, first_name: "https://tinyurl.com/from216" },
          text: `https://t.me/web/${slug}?text=https://bit.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(openedApp.status).toBe("event");
    if (openedApp.status !== "event") {
      return;
    }
    const appLogger = createMemoryLogger();
    const appModerator = createMemoryModerator();
    const deleted = await screenTelegramEvent(openedApp.event, {
      logger: appLogger,
      moderator: appModerator,
    });
    expect(deleted.decision.action).toBe("delete");
    expect(deleted.decision.reasons).toEqual(["short_link"]);
    const appDump = JSON.stringify({
      result: deleted,
      logs: appLogger.entries,
    });
    expect(appDump).not.toContain(path);
    expect(appDump).not.toContain(slug);
    expect(appDump).not.toContain("from216");
    expect(appDump).not.toContain("机密群名");
  });

  it("reads a msg username draft including an app name", async () => {
    const path = "offer217";
    const slug = "slug217";
    const opened = await normalizeUpdate({
      update: {
        update_id: 2351,
        message: {
          message_id: 2351,
          date: 1761955200,
          chat: { id: -1008309, type: "supergroup", title: "机密群名" },
          from: { id: 217, first_name: "Ada" },
          text: `https://t.me/msg?text=https://bit.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(opened.status).toBe("event");
    if (opened.status !== "event") {
      return;
    }
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(opened.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const openedApp = await normalizeUpdate({
      update: {
        update_id: 2352,
        message: {
          message_id: 2352,
          date: 1761955200,
          chat: { id: -1008310, type: "supergroup", title: "机密群名" },
          from: { id: 217, first_name: "https://tinyurl.com/from217" },
          text: `https://t.me/msg/${slug}?text=https://bit.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(openedApp.status).toBe("event");
    if (openedApp.status !== "event") {
      return;
    }
    const appLogger = createMemoryLogger();
    const appModerator = createMemoryModerator();
    const deleted = await screenTelegramEvent(openedApp.event, {
      logger: appLogger,
      moderator: appModerator,
    });
    expect(deleted.decision.action).toBe("delete");
    expect(deleted.decision.reasons).toEqual(["short_link"]);
    const appDump = JSON.stringify({
      result: deleted,
      logs: appLogger.entries,
    });
    expect(appDump).not.toContain(path);
    expect(appDump).not.toContain(slug);
    expect(appDump).not.toContain("from217");
    expect(appDump).not.toContain("机密群名");
  });

  it("reads a share username draft including an app name", async () => {
    const path = "offer218";
    const slug = "slug218";
    const opened = await normalizeUpdate({
      update: {
        update_id: 2353,
        message: {
          message_id: 2353,
          date: 1761955200,
          chat: { id: -1008311, type: "supergroup", title: "机密群名" },
          from: { id: 218, first_name: "Ada" },
          text: `https://t.me/share?text=https://bit.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(opened.status).toBe("event");
    if (opened.status !== "event") {
      return;
    }
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(opened.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const openedApp = await normalizeUpdate({
      update: {
        update_id: 2354,
        message: {
          message_id: 2354,
          date: 1761955200,
          chat: { id: -1008312, type: "supergroup", title: "机密群名" },
          from: { id: 218, first_name: "https://tinyurl.com/from218" },
          text: `https://t.me/share/${slug}?text=https://bit.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(openedApp.status).toBe("event");
    if (openedApp.status !== "event") {
      return;
    }
    const appLogger = createMemoryLogger();
    const appModerator = createMemoryModerator();
    const deleted = await screenTelegramEvent(openedApp.event, {
      logger: appLogger,
      moderator: appModerator,
    });
    expect(deleted.decision.action).toBe("delete");
    expect(deleted.decision.reasons).toEqual(["short_link"]);
    const appDump = JSON.stringify({
      result: deleted,
      logs: appLogger.entries,
    });
    expect(appDump).not.toContain(path);
    expect(appDump).not.toContain(slug);
    expect(appDump).not.toContain("from218");
    expect(appDump).not.toContain("机密群名");
  });
});
