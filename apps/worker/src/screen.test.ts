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
});
