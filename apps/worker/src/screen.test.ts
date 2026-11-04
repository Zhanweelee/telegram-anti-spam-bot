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
  createMemoryWarnStore,
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
import { createAlbumWatch } from "./album.js";
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
    claimAudit: (record) => storage.claimAudit(record),
    putAuditsIfAbsent: (records) => storage.putAuditsIfAbsent(records),
    listAudits: (query) => storage.listAudits(query),
    getAudit: (tenantId, chatId, eventId) =>
      storage.getAudit(tenantId, chatId, eventId),
    exportAudits: (scope) => storage.exportAudits(scope),
    countAudits: (scope) => storage.countAudits(scope),
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
  it("deletes the other known photos once one album message is removed", async () => {
    const phrase = "请免费领取礼品";
    const albumId = "12532140322504850";
    const watch = createAlbumWatch();
    const moderator = createMemoryModerator();
    const logger = createMemoryLogger();
    const storage = createMemoryStorage();
    const chatId = "-100880";

    async function photo(
      id: string,
      messageId: string,
      text: string,
      extra: { readonly paid?: true; readonly audienceId?: string } = {},
    ) {
      return parseEvent({
        id,
        tenantId: "local",
        chatId,
        kind: "message",
        occurredAt: "2026-11-01T00:00:00.000Z",
        actor: { id: "8805", isAdmin: false },
        message: {
          id: messageId,
          text,
          textSha256: await sha256Hex(text),
          albumId,
          ...(extra.paid ? { paid: true as const } : {}),
          ...(extra.audienceId ? { audienceId: extra.audienceId } : {}),
        },
      });
    }

    const clean = await screenTelegramEvent(
      await photo("tg_album_880_11", "11", "今天站会"),
      { logger, moderator, storage, albumWatch: watch },
    );
    expect(clean.decision.action).toBe("allow");
    expect(moderator.deleted).toEqual([]);
    await screenTelegramEvent(await photo("tg_album_880_15", "15", "明早见"), {
      logger,
      moderator,
      storage,
      albumWatch: watch,
    });

    const spam = await screenTelegramEvent(
      await photo("tg_album_880_12", "12", phrase),
      { logger, moderator, storage, albumWatch: watch },
    );
    expect(spam.decision.action).toBe("delete");
    expect(moderator.deleted.map((item) => item.messageId)).toEqual(["12"]);
    expect(moderator.deletedMessages).toEqual([
      {
        tenantId: "local",
        chatId,
        messageIds: ["11", "15"],
      },
    ]);

    const later = await screenTelegramEvent(
      await photo("tg_album_880_13", "13", "下周见"),
      { logger, moderator, storage, albumWatch: watch },
    );
    expect(later.decision.action).toBe("allow");
    expect(moderator.deleted.map((item) => item.messageId)).toEqual(["12"]);
    expect(moderator.deletedMessages).toEqual([
      {
        tenantId: "local",
        chatId,
        messageIds: ["11", "15"],
      },
      {
        tenantId: "local",
        chatId,
        messageIds: ["13"],
      },
    ]);

    const paid = await screenTelegramEvent(
      await photo("tg_album_880_14", "14", phrase, { paid: true }),
      { logger, moderator, storage, albumWatch: watch },
    );
    expect(paid.actionResults).toContainEqual({
      actionId: "delete",
      status: "skipped",
      detail: "paid_post",
    });
    expect(moderator.deleted.map((item) => item.messageId)).not.toContain("14");

    const other = await screenTelegramEvent(
      await parseEvent({
        id: "tg_album_880_21",
        tenantId: "local",
        chatId,
        kind: "message",
        occurredAt: "2026-11-01T00:00:00.000Z",
        actor: { id: "8805", isAdmin: false },
        message: {
          id: "21",
          text: "下午对一下",
          textSha256: await sha256Hex("下午对一下"),
          albumId: "12532140322504851",
        },
      }),
      { logger, moderator, storage, albumWatch: watch },
    );
    expect(other.decision.action).toBe("allow");
    expect(moderator.deleted.map((item) => item.messageId)).not.toContain("21");

    const dumped = JSON.stringify({
      logs: logger.entries,
      deleted: moderator.deleted,
    });
    expect(dumped).not.toContain(phrase);
    expect(dumped).not.toContain(albumId);
    expect(dumped).not.toContain("bit.ly");
  });

  it("keeps a paid album photo and does not condemn the group from it", async () => {
    const phrase = "请免费领取礼品";
    const albumId = "12532140322504852";
    const watch = createAlbumWatch();
    const moderator = createMemoryModerator();
    const storage = createMemoryStorage();
    const chatId = "-100882";

    async function photo(
      id: string,
      messageId: string,
      text: string,
      paid = false,
    ) {
      return parseEvent({
        id,
        tenantId: "local",
        chatId,
        kind: "message",
        occurredAt: "2026-11-01T00:00:00.000Z",
        actor: { id: "8806", isAdmin: false },
        message: {
          id: messageId,
          text,
          textSha256: await sha256Hex(text),
          albumId,
          ...(paid ? { paid: true as const } : {}),
        },
      });
    }

    await screenTelegramEvent(
      await photo("tg_album_882_14", "14", phrase, true),
      {
        moderator,
        storage,
        albumWatch: watch,
      },
    );
    await screenTelegramEvent(
      await photo("tg_album_882_11", "11", "今天站会"),
      { moderator, storage, albumWatch: watch },
    );
    expect(moderator.deleted).toEqual([]);

    await screenTelegramEvent(await photo("tg_album_882_12", "12", phrase), {
      moderator,
      storage,
      albumWatch: watch,
    });
    expect(moderator.deleted.map((item) => item.messageId)).toEqual(["12"]);
    expect(moderator.deletedMessages).toEqual([
      {
        tenantId: "local",
        chatId,
        messageIds: ["11"],
      },
    ]);
  });

  it("does not condemn an album during dry-run", async () => {
    const phrase = "请免费领取礼品";
    const watch = createAlbumWatch();
    const moderator = createMemoryModerator();
    const storage = createMemoryStorage();
    const runtime = createMemoryRuntimeStore();
    const chatId = "-100881";
    await runtime.setDryRun("local", chatId, true);

    async function photo(id: string, messageId: string, text: string) {
      return parseEvent({
        id,
        tenantId: "local",
        chatId,
        kind: "message",
        occurredAt: "2026-11-01T00:00:00.000Z",
        actor: { id: "8807", isAdmin: false },
        message: {
          id: messageId,
          text,
          textSha256: await sha256Hex(text),
          albumId: "12532140322504853",
        },
      });
    }

    const spam = await screenTelegramEvent(
      await photo("tg_album_881_12", "12", phrase),
      { moderator, storage, runtime, albumWatch: watch },
    );
    expect(spam.dryRun).toBe(true);
    expect(spam.decision.action).toBe("delete");
    expect(moderator.deleted).toEqual([]);
    expect(moderator.deletedMessages).toEqual([]);

    const runtimeOff = createMemoryRuntimeStore();
    const clean = await screenTelegramEvent(
      await photo("tg_album_881_13", "13", "今天站会"),
      {
        moderator,
        storage,
        runtime: runtimeOff,
        albumWatch: watch,
      },
    );
    expect(clean.dryRun).toBe(false);
    expect(clean.decision.action).toBe("allow");
    expect(moderator.deleted).toEqual([]);
    expect(moderator.deletedMessages).toEqual([]);
  });

  it("keeps album deletes inside one chat and retries a sibling after a failure", async () => {
    const phrase = "请免费领取礼品";
    const albumId = "12532140322504854";
    const watch = createAlbumWatch();
    const moderator = createMemoryModerator();
    const logger = createMemoryLogger();
    const storage = createMemoryStorage();

    async function photo(
      id: string,
      messageId: string,
      chatId: string,
      text: string,
    ) {
      return parseEvent({
        id,
        tenantId: "local",
        chatId,
        kind: "message",
        occurredAt: "2026-11-01T00:00:00.000Z",
        actor: { id: "8808", isAdmin: false },
        message: {
          id: messageId,
          text,
          textSha256: await sha256Hex(text),
          albumId,
          audienceId: "7",
        },
      });
    }

    await screenTelegramEvent(
      await photo("tg_album_884_11", "11", "-100884", "今天站会"),
      { logger, moderator, storage, albumWatch: watch },
    );
    const throwing = {
      ...moderator,
      async deleteMessage(target: {
        readonly tenantId: string;
        readonly chatId: string;
        readonly messageId: string;
        readonly audienceId?: string;
      }) {
        if (target.messageId === "11") {
          throw new Error(phrase);
        }
        await moderator.deleteMessage(target);
      },
    };
    const spam = await screenTelegramEvent(
      await photo("tg_album_884_12", "12", "-100884", phrase),
      { logger, moderator: throwing, storage, albumWatch: watch },
    );
    expect(spam.decision.action).toBe("delete");
    expect(spam.actionResults).toContainEqual({
      actionId: "delete",
      status: "executed",
    });
    expect(moderator.deleted).toEqual([
      {
        tenantId: "local",
        chatId: "-100884",
        messageId: "12",
        audienceId: "7",
      },
    ]);
    const failed = JSON.stringify(logger.entries);
    expect(failed).toContain("album_delete_failed");
    expect(failed).not.toContain(phrase);
    expect(failed).not.toContain(albumId);
    expect(failed).not.toContain("bit.ly");

    await screenTelegramEvent(
      await photo("tg_album_885_31", "31", "-100885", "今天站会"),
      { logger, moderator, storage, albumWatch: watch },
    );
    await screenTelegramEvent(
      await photo("tg_album_884_13", "13", "-100884", "今天站会"),
      { logger, moderator, storage, albumWatch: watch },
    );
    expect(moderator.deleted.map((item) => item.messageId)).toEqual([
      "12",
      "13",
      "11",
    ]);
    expect(moderator.deletedMessages).toEqual([]);
    expect(moderator.deleted.map((item) => item.messageId)).not.toContain("31");

    const again = await screenTelegramEvent(
      await photo("tg_album_884_12", "12", "-100884", phrase),
      { logger, moderator, storage, albumWatch: watch },
    );
    expect(again.actionResults).toContainEqual({
      actionId: "delete",
      status: "skipped",
      detail: "duplicate",
    });
    expect(moderator.deleted.map((item) => item.messageId)).toEqual([
      "12",
      "13",
      "11",
    ]);
    expect(moderator.deletedMessages).toEqual([]);
  });

  it("retries a public album in one deleteMessages call", async () => {
    const phrase = "请免费领取礼品";
    const albumId = "12532140322504856";
    const watch = createAlbumWatch();
    const moderator = createMemoryModerator();
    const logger = createMemoryLogger();
    const storage = createMemoryStorage();
    const chatId = "-100887";

    async function photo(id: string, messageId: string, text: string) {
      return parseEvent({
        id,
        tenantId: "local",
        chatId,
        kind: "message",
        occurredAt: "2026-11-01T00:00:00.000Z",
        actor: { id: "8810", isAdmin: false },
        message: {
          id: messageId,
          text,
          textSha256: await sha256Hex(text),
          albumId,
        },
      });
    }

    await screenTelegramEvent(
      await photo("tg_album_887_11", "11", "今天站会"),
      {
        logger,
        moderator,
        storage,
        albumWatch: watch,
      },
    );
    await screenTelegramEvent(await photo("tg_album_887_15", "15", "明早见"), {
      logger,
      moderator,
      storage,
      albumWatch: watch,
    });
    const throwing = {
      ...moderator,
      async deleteMessages() {
        throw new Error(phrase);
      },
    };
    const spam = await screenTelegramEvent(
      await photo("tg_album_887_12", "12", phrase),
      { logger, moderator: throwing, storage, albumWatch: watch },
    );
    expect(spam.decision.action).toBe("delete");
    expect(moderator.deleted.map((item) => item.messageId)).toEqual(["12"]);
    expect(moderator.deletedMessages).toEqual([]);
    const failed = JSON.stringify(logger.entries);
    expect(failed).toContain("album_delete_failed");
    expect(failed.split("album_delete_failed")).toHaveLength(2);
    expect(failed).not.toContain(phrase);
    expect(failed).not.toContain(albumId);

    await screenTelegramEvent(await photo("tg_album_887_13", "13", "下周见"), {
      logger,
      moderator,
      storage,
      albumWatch: watch,
    });
    expect(moderator.deletedMessages).toEqual([
      {
        tenantId: "local",
        chatId,
        messageIds: ["13", "11", "15"],
      },
    ]);
    expect(moderator.deleted.map((item) => item.messageId)).toEqual(["12"]);
  });

  it("leaves a phrase-shaped message id out of the album list", async () => {
    const phrase = "请免费领取礼品";
    const watch = createAlbumWatch();
    const moderator = createMemoryModerator();
    const logger = createMemoryLogger();
    const storage = createMemoryStorage();
    const chatId = "-100886";
    const albumId = "12532140322504855";

    await screenTelegramEvent(
      await parseEvent({
        id: "tg_album_886_bad",
        tenantId: "local",
        chatId,
        kind: "message",
        occurredAt: "2026-11-01T00:00:00.000Z",
        actor: { id: "8809", isAdmin: false },
        message: {
          id: phrase,
          text: "今天站会",
          textSha256: await sha256Hex("今天站会"),
          albumId,
        },
      }),
      { logger, moderator, storage, albumWatch: watch },
    );
    await screenTelegramEvent(
      await parseEvent({
        id: "tg_album_886_12",
        tenantId: "local",
        chatId,
        kind: "message",
        occurredAt: "2026-11-01T00:00:00.000Z",
        actor: { id: "8809", isAdmin: false },
        message: {
          id: "12",
          text: phrase,
          textSha256: await sha256Hex(phrase),
          albumId,
        },
      }),
      { logger, moderator, storage, albumWatch: watch },
    );
    expect(moderator.deleted.map((item) => item.messageId)).toEqual(["12"]);
    expect(JSON.stringify(logger.entries)).not.toContain(phrase);
  });

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

  it("uses one private rule action and keeps the file action for other chats", async () => {
    const text = "请免费领取礼品";
    const runtime = createMemoryRuntimeStore();
    let overridden = true;
    const screened = {
      ...runtime,
      async listRuleActions(_tenantId: string, chatId: string) {
        if (!overridden || chatId !== "-100") {
          return [];
        }
        return [{ ruleId: "spam_keywords", action: "warn" as const }];
      },
    };
    const warnedLog = createMemoryLogger();
    const warned = await screenTelegramEvent(await event(text), {
      logger: warnedLog,
      runtime: screened,
      storage: createMemoryStorage(),
      warnStore: createMemoryWarnStore(),
    });
    expect(warned.decision.action).toBe("warn");
    expect(JSON.stringify(warnedLog.entries)).not.toContain(text);
    overridden = false;
    const restored = await screenTelegramEvent(
      await event(text, false, "-100"),
      {
        runtime: screened,
        storage: createMemoryStorage(),
        cache: createMemoryCache(),
      },
    );
    expect(restored.decision.action).toBe("delete");
    const other = await screenTelegramEvent(await event(text, false, "-200"), {
      runtime: screened,
      storage: createMemoryStorage(),
    });
    expect(other.decision.action).toBe("delete");
    const brokenLog = createMemoryLogger();
    const broken = await screenTelegramEvent(await event(text, false, "-300"), {
      logger: brokenLog,
      storage: createMemoryStorage(),
      runtime: {
        ...runtime,
        async listRuleActions() {
          throw new Error(text);
        },
      },
    });
    expect(broken.decision.action).toBe("delete");
    expect(JSON.stringify(brokenLog.entries)).toContain("runtime_failed");
    expect(JSON.stringify(brokenLog.entries)).not.toContain(text);
  });

  it("runs mute and ban from chat rules without deleting", async () => {
    const text = "请免费领取礼品";
    const cache = createMemoryCache();
    const storage = createMemoryStorage();
    const mute = await screenTelegramEvent(await event(text), {
      cache,
      storage,
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
      storage,
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

  it("warns on an opt-in rule and bans the third hit", async () => {
    const text = "请免费领取礼品";
    const warns = createMemoryWarnStore();
    const moderator = createMemoryModerator();
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
              id: "caution",
              enabled: true,
              detectorIds: ["keyword"],
              threshold: 1,
              actions: ["warn"],
            },
          ],
        };
      },
    };
    for (const step of [1, 2, 3, 4]) {
      const result = await screenTelegramEvent(
        await parseEvent({
          id: `tg_warn_${step}`,
          tenantId: "local",
          chatId: "-100",
          kind: "message",
          occurredAt: "2026-11-01T00:00:00.000Z",
          actor: { id: "5", isAdmin: false },
          message: {
            id: String(step),
            text,
            textSha256: await sha256Hex(text),
          },
        }),
        {
          cache: createMemoryCache(),
          storage: createMemoryStorage(),
          source,
          moderator,
          warnStore: warns,
          logger: createMemoryLogger(),
        },
      );
      expect(result.decision.action, String(step)).toBe("warn");
      expect(result.actionResults).toEqual([
        { actionId: "warn", status: "executed" },
      ]);
      expect(JSON.stringify(result)).not.toContain(text);
    }
    expect(moderator.deleted.map((item) => item.messageId)).toEqual([
      "1",
      "2",
      "3",
      "4",
    ]);
    expect(moderator.banned).toEqual([
      { tenantId: "local", chatId: "-100", actorId: "5" },
      { tenantId: "local", chatId: "-100", actorId: "5" },
    ]);
    expect(
      await warns.read({ tenantId: "local", chatId: "-100", actorId: "5" }),
    ).toBe(3);
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

  it("bans a member who changes a tag to a keyword", async () => {
    const name = "广告员";
    const tag = "请免费领取礼品";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2074,
        chat_member: {
          chat: { id: -100689, type: "supergroup", title: "机密群名" },
          from: { id: 79, first_name: name },
          date: 1761955200,
          old_chat_member: {
            user: { id: 79, first_name: name },
            status: "member",
            tag: "旧标签",
          },
          new_chat_member: {
            user: { id: 79, first_name: name },
            status: "member",
            tag,
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
      { tenantId: "local", chatId: "-100689", actorId: "79" },
    ]);
    expect(moderator.restricted).toEqual([]);
    expect(await captchaStore.get("local", "-100689", "79")).toBeNull();
    const logged = JSON.stringify(logger.entries);
    expect(logged).not.toContain(name);
    expect(logged).not.toContain(tag);
    expect(logged).not.toContain("机密群名");
    expect(JSON.stringify(result.decision.evidence)).not.toContain(tag);
    const audit = await workerStorage.listAudits({
      tenantId: "local",
      chatId: "-100689",
      limit: 5,
    });
    expect(audit[0]?.textSha256).toBe(outcome.event.profile?.textSha256);
    expect(JSON.stringify(audit)).not.toContain(name);
    expect(JSON.stringify(audit)).not.toContain(tag);
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

  it("answers a guarded join request and queues a clean one", async () => {
    const phrase = "请免费领取礼品";
    const clean = await normalizeUpdate({
      update: {
        update_id: 6891,
        chat_join_request: {
          chat: { id: -1006891, type: "supergroup", title: "机密群名" },
          from: { id: 83, first_name: phrase },
          date: 1761955200,
          bio: "https://example.com/ok89",
          query_id: "query89",
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
    expect(cleanModerator.deferred).toEqual([
      {
        tenantId: "local",
        chatId: "-1006891",
        actorId: "83",
        queryId: "query89",
      },
    ]);

    const spam = await normalizeUpdate({
      update: {
        update_id: 6892,
        chat_join_request: {
          chat: { id: -1006892, type: "supergroup", title: "机密群名" },
          from: { id: 83, first_name: "Ada" },
          date: 1761955200,
          bio: `${phrase} https://bit.ly/bio89`,
          query_id: "query90",
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(spam.status).toBe("event");
    if (spam.status !== "event") {
      return;
    }
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(spam.event, {
      logger,
      moderator,
    });
    expect(result.decision.action).toBe("decline");
    expect(moderator.declined).toEqual([
      {
        tenantId: "local",
        chatId: "-1006892",
        actorId: "83",
        queryId: "query90",
      },
    ]);
    expect(moderator.deferred).toEqual([]);
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(phrase);
    expect(dumped).not.toContain("bio89");
    expect(dumped).not.toContain("query90");
    expect(dumped).not.toContain("机密群名");

    const runtime = createMemoryRuntimeStore();
    await runtime.setDryRun("local", "-1006893", true);
    const dryModerator = createMemoryModerator();
    const dryResult = await screenTelegramEvent(
      { ...spam.event, id: "tg_6893", chatId: "-1006893" },
      {
        logger: createMemoryLogger(),
        moderator: dryModerator,
        runtime,
      },
    );
    expect(dryResult.dryRun).toBe(true);
    expect(dryResult.decision.action).toBe("decline");
    expect(dryModerator.declined).toEqual([]);
    expect(dryModerator.deferred).toEqual([]);

    const admin = await normalizeUpdate({
      update: {
        update_id: 6894,
        chat_join_request: {
          chat: { id: -1006894, type: "supergroup" },
          from: { id: 83, first_name: "Ada" },
          date: 1761955200,
          bio: phrase,
          query_id: "query91",
        },
      },
      tenantId: "local",
      adminUserIds: ["83"],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(admin.status).toBe("event");
    if (admin.status !== "event") {
      return;
    }
    const adminModerator = createMemoryModerator();
    const adminResult = await screenTelegramEvent(admin.event, {
      logger: createMemoryLogger(),
      moderator: adminModerator,
    });
    expect(adminResult.outcome).toBe("exempt");
    expect(adminModerator.declined).toEqual([]);
    expect(adminModerator.deferred).toEqual([
      {
        tenantId: "local",
        chatId: "-1006894",
        actorId: "83",
        queryId: "query91",
      },
    ]);

    const failedModerator = createMemoryModerator();
    const failed = await screenTelegramEvent(
      { ...spam.event, id: "tg_6895", chatId: "-1006895" },
      {
        logger: createMemoryLogger(),
        moderator: {
          ...failedModerator,
          async declineJoin() {
            throw new Error("decline_failed");
          },
        },
      },
    );
    expect(failed.decision.action).toBe("decline");
    expect(failedModerator.deferred).toEqual([]);

    const warnLogger = createMemoryLogger();
    const warnModerator = createMemoryModerator();
    const warned = await screenTelegramEvent(clean.event, {
      logger: warnLogger,
      moderator: {
        ...warnModerator,
        async deferJoin() {
          throw new Error(phrase);
        },
      },
    });
    expect(warned.decision.action).toBe("allow");
    expect(warnModerator.deferred).toEqual([]);
    const warnedDump = JSON.stringify(warnLogger.entries);
    expect(warnedDump).toContain("join_query_defer_failed");
    expect(warnedDump).not.toContain(phrase);
    expect(warnedDump).not.toContain("query89");
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

  it("keeps a folder-invite join on captcha until a chat enables the ban", async () => {
    const link = "https://t.me/addlist/SecretFolder";
    const name = "文件夹广告";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 2060,
        chat_member: {
          chat: { id: -100592, type: "supergroup", title: name },
          from: { id: 1, first_name: name },
          date: 1761955200,
          invite_link: { invite_link: link, name },
          via_chat_folder_invite_link: true,
          old_chat_member: {
            user: { id: 91, first_name: name },
            status: "left",
          },
          new_chat_member: {
            user: { id: 91, first_name: name },
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
    expect(outcome.event.folderInvite).toBe(true);
    expect(outcome.event.membership).toBe("join");
    const logger = createMemoryLogger();
    const idle = await screenTelegramEvent(outcome.event, {
      logger,
      moderator: createMemoryModerator(),
      rateWindow: createMemoryRateWindow(),
      captchaStore: createMemoryCaptchaStore(),
      createNonce: () => "0123456789abcdef",
    });
    expect(idle.decision.action).toBe("captcha");
    expect(idle.decision.reasons).not.toContain("folder_joined");
    const source: RuleSource = {
      async loadChat() {
        return {
          version: 1,
          aggregate: "max",
          rules: [
            {
              id: "folder_join",
              enabled: true,
              when: { eventKind: "chat_member" },
              detectorIds: ["folder"],
              threshold: 1,
              actions: ["ban"],
            },
          ],
        };
      },
      async loadDefault() {
        return { version: 1, aggregate: "max", rules: [] };
      },
    };
    const enabled = await screenTelegramEvent(
      { ...outcome.event, id: "tg_2061", chatId: "-100593" },
      {
        logger: createMemoryLogger(),
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: createMemoryModerator(),
      },
    );
    expect(enabled.decision.action).toBe("ban");
    expect(enabled.decision.reasons).toContain("folder_joined");
    expect(enabled.decision.ruleIds).toContain("folder_join");
    expect(JSON.stringify(enabled.decision.evidence)).toContain(
      "folder:invite",
    );
    const dumped = JSON.stringify({
      decision: enabled.decision,
      logs: logger.entries,
    });
    expect(dumped).not.toContain(link);
    expect(dumped).not.toContain("SecretFolder");
    expect(dumped).not.toContain(name);
  });

  it("keeps join and leave notices until a chat asks to delete them", async () => {
    const name = "干净名字";
    const joined = await normalizeUpdate({
      update: {
        update_id: 2070,
        message: {
          message_id: 70,
          date: 1761955200,
          chat: { id: -100594, type: "supergroup", title: name },
          from: { id: 92, first_name: name },
          new_chat_members: [{ id: 9201, first_name: name }],
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
    expect(joined.event.message?.notice).toBe("join");
    const idle = await screenTelegramEvent(joined.event, {
      moderator: createMemoryModerator(),
      rateWindow: createMemoryRateWindow(),
    });
    expect(idle.decision.action).toBe("allow");
    expect(idle.decision.reasons).not.toContain("service_notice");
    const source: RuleSource = {
      async loadChat() {
        return {
          version: 1,
          aggregate: "max",
          rules: [
            {
              id: "service_notice",
              enabled: true,
              when: { eventKind: "message" },
              detectorIds: ["notice"],
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
    const removed = await screenTelegramEvent(
      { ...joined.event, id: "tg_2071", chatId: "-100595" },
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: createMemoryModerator(),
      },
    );
    expect(removed.decision.action).toBe("delete");
    expect(removed.decision.reasons).toContain("service_notice");
    expect(removed.decision.ruleIds).toContain("service_notice");
    expect(JSON.stringify(removed.decision.evidence)).toContain("notice:join");
    const left = await normalizeUpdate({
      update: {
        update_id: 2072,
        message: {
          message_id: 72,
          date: 1761955200,
          chat: { id: -100596, type: "supergroup" },
          from: { id: 93 },
          left_chat_member: { id: 9301, first_name: name },
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(left.status).toBe("event");
    if (left.status !== "event") {
      return;
    }
    expect(left.event.message?.notice).toBe("leave");
    expect(left.event.message?.text).toBe("");
    const dropped = await screenTelegramEvent(left.event, {
      source,
      cache: createMemoryCache(),
      rateWindow: createMemoryRateWindow(),
      moderator: createMemoryModerator(),
    });
    expect(dropped.decision.action).toBe("delete");
    expect(JSON.stringify(dropped.decision.evidence)).toContain("notice:leave");
    const dumped = JSON.stringify({
      removed: removed.decision,
      dropped: dropped.decision,
    });
    expect(dumped).not.toContain(name);
    expect(JSON.stringify(joined.event)).not.toContain("9201");
    expect(JSON.stringify(left.event)).not.toContain("9301");
    expect(JSON.stringify(left.event)).not.toContain(name);
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

  it("counts one update once against the free quota", async () => {
    const runtime = createMemoryRuntimeStore();
    expect(
      await runtime.setRuleSwitch("local", "-100598", "via_inline", true),
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
      id: "tg_2017",
      tenantId: "local",
      chatId: "-100598",
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
    const second = await screenTelegramEvent(viaEvent, {
      runtime,
      quota,
      cache: createMemoryCache(),
      rateWindow: createMemoryRateWindow(),
    });
    expect(first.decision.action).toBe("delete");
    expect(second.decision.action).toBe("delete");
    expect(second.decision.reasons).toContain("via_bot");
    expect(
      await quota.store.read({
        tenantId: "local",
        chatId: "-100598",
        atIso: "2026-11-01T00:00:00.000Z",
        policy: quota.policy,
      }),
    ).toMatchObject({ used: 1, degraded: false });
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

  it("deletes the second message when that chat's flood count is 2", async () => {
    const runtime = createMemoryRuntimeStore();
    expect(
      await runtime.setFloodPolicy("local", "-100rate", {
        threshold: 2,
        windowSeconds: 10,
      }),
    ).toBe(true);
    const window = createMemoryRateWindow();
    const base = Date.parse("2026-11-01T00:00:00.000Z");
    async function at(index: number, chatId: string) {
      const text = `note-${chatId}-${index}`;
      return parseEvent({
        id: `flood_policy_${chatId}_${index}`,
        tenantId: "local",
        chatId,
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
    const first = await screenTelegramEvent(await at(0, "-100rate"), {
      runtime,
      rateWindow: window,
    });
    expect(first.decision.action).toBe("allow");
    const second = await screenTelegramEvent(await at(1, "-100rate"), {
      runtime,
      rateWindow: window,
    });
    expect(second.decision.action).toBe("delete");
    expect(second.decision.reasons).toContain("flood");
    expect(JSON.stringify(second)).not.toContain("note-");
    const other = await screenTelegramEvent(await at(0, "-200rate"), {
      runtime,
      rateWindow: window,
    });
    expect(other.decision.action).toBe("allow");
    const otherSecond = await screenTelegramEvent(await at(1, "-200rate"), {
      runtime,
      rateWindow: window,
    });
    expect(otherSecond.decision.action).toBe("allow");

    const phrase = "请免费领取礼品";
    const logger = createMemoryLogger();
    const broken = createMemoryRuntimeStore();
    const failed = await screenTelegramEvent(await at(3, "-300rate"), {
      logger,
      rateWindow: createMemoryRateWindow(),
      runtime: {
        ...broken,
        async getFloodPolicy() {
          throw new Error(phrase);
        },
      },
    });
    expect(failed.decision.action).toBe("allow");
    expect(JSON.stringify(logger.entries)).toContain("runtime_failed");
    expect(JSON.stringify(logger.entries)).not.toContain(phrase);
  });

  it("deletes a message that matches one chat's extra keyword", async () => {
    const runtime = createMemoryRuntimeStore();
    expect(await runtime.addKeyword("local", "-100kw", "发票")).toBe(true);
    const text = "请开发票";
    const hit = await screenTelegramEvent(
      await parseEvent({
        id: "kw_hit",
        tenantId: "local",
        chatId: "-100kw",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00.000Z",
        actor: { id: "9", isAdmin: false },
        message: {
          id: "1",
          text,
          textSha256: await sha256Hex(text),
        },
      }),
      { runtime },
    );
    expect(hit.decision.action).toBe("delete");
    expect(hit.decision.reasons).toContain("keyword_match");
    expect(JSON.stringify(hit)).not.toContain(text);
    const other = await screenTelegramEvent(
      await parseEvent({
        id: "kw_other",
        tenantId: "local",
        chatId: "-200kw",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00.000Z",
        actor: { id: "9", isAdmin: false },
        message: {
          id: "2",
          text,
          textSha256: await sha256Hex(text),
        },
      }),
      { runtime },
    );
    expect(other.decision.action).toBe("allow");
    const phrase = "请免费领取礼品";
    const logger = createMemoryLogger();
    const broken = createMemoryRuntimeStore();
    const failed = await screenTelegramEvent(
      await parseEvent({
        id: "kw_fail",
        tenantId: "local",
        chatId: "-300kw",
        kind: "message",
        occurredAt: "2026-11-01T00:00:00.000Z",
        actor: { id: "9", isAdmin: false },
        message: {
          id: "3",
          text,
          textSha256: await sha256Hex(text),
        },
      }),
      {
        logger,
        runtime: {
          ...broken,
          async listKeywords() {
            throw new Error(phrase);
          },
        },
      },
    );
    expect(failed.decision.action).toBe("allow");
    expect(JSON.stringify(logger.entries)).toContain("runtime_failed");
    expect(JSON.stringify(logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(logger.entries)).not.toContain(text);
  });

  it("keeps one chat's allowed short-link host", async () => {
    const runtime = createMemoryRuntimeStore();
    expect(await runtime.addAllowHost("local", "-100host", "bit.ly")).toBe(
      true,
    );
    async function message(id: string, chatId: string, text: string) {
      return parseEvent({
        id,
        tenantId: "local",
        chatId,
        kind: "message",
        occurredAt: "2026-11-01T00:00:00.000Z",
        actor: { id: "9", isAdmin: false },
        message: {
          id,
          text,
          textSha256: await sha256Hex(text),
        },
      });
    }
    const kept = await screenTelegramEvent(
      await message("host_keep", "-100host", "https://bit.ly/docs"),
      { runtime },
    );
    expect(kept.decision.action).toBe("allow");
    const otherHost = await screenTelegramEvent(
      await message("host_other_link", "-100host", "https://tinyurl.com/x"),
      { runtime },
    );
    expect(otherHost.decision.action).toBe("delete");
    expect(otherHost.decision.reasons).toContain("short_link");
    const both = await screenTelegramEvent(
      await message(
        "host_both",
        "-100host",
        "https://bit.ly/docs https://tinyurl.com/x",
      ),
      { runtime },
    );
    expect(both.decision.action).toBe("delete");
    const otherChat = await screenTelegramEvent(
      await message("host_other_chat", "-200host", "https://bit.ly/docs"),
      { runtime },
    );
    expect(otherChat.decision.action).toBe("delete");
    expect(JSON.stringify(kept)).not.toContain("docs");
    const phrase = "请免费领取礼品";
    const logger = createMemoryLogger();
    const broken = createMemoryRuntimeStore();
    const failed = await screenTelegramEvent(
      await message("host_fail", "-300host", "https://bit.ly/docs"),
      {
        logger,
        runtime: {
          ...broken,
          async listAllowHosts() {
            throw new Error(phrase);
          },
        },
      },
    );
    expect(failed.decision.action).toBe("delete");
    expect(JSON.stringify(logger.entries)).toContain("runtime_failed");
    expect(JSON.stringify(logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(logger.entries)).not.toContain("docs");
  });

  it("deletes the second copy when that chat's repeat count is 2", async () => {
    const runtime = createMemoryRuntimeStore();
    expect(
      await runtime.setRepeatPolicy("local", "-100rep", {
        threshold: 2,
        windowSeconds: 60,
      }),
    ).toBe(true);
    const window = createMemoryRateWindow();
    const base = Date.parse("2026-11-01T00:00:00.000Z");
    async function copy(index: number, chatId: string, text: string) {
      return parseEvent({
        id: `repeat_policy_${chatId}_${index}`,
        tenantId: "local",
        chatId,
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
    const first = await screenTelegramEvent(
      await copy(0, "-100rep", "same-line"),
      {
        runtime,
        rateWindow: window,
      },
    );
    expect(first.decision.action).toBe("allow");
    const second = await screenTelegramEvent(
      await copy(1, "-100rep", "same-line"),
      { runtime, rateWindow: window },
    );
    expect(second.decision.action).toBe("delete");
    expect(second.decision.reasons).toContain("repeat");
    expect(JSON.stringify(second)).not.toContain("same-line");
    const other = await screenTelegramEvent(
      await copy(0, "-200rep", "other-line"),
      { runtime, rateWindow: window },
    );
    expect(other.decision.action).toBe("allow");
    const otherSecond = await screenTelegramEvent(
      await copy(1, "-200rep", "other-line"),
      { runtime, rateWindow: window },
    );
    expect(otherSecond.decision.action).toBe("allow");

    const phrase = "请免费领取礼品";
    const logger = createMemoryLogger();
    const broken = createMemoryRuntimeStore();
    const failedWindow = createMemoryRateWindow();
    const failedRuntime = {
      ...broken,
      async getRepeatPolicy() {
        throw new Error(phrase);
      },
    };
    const failedFirst = await screenTelegramEvent(
      await copy(0, "-300rep", "quiet-line"),
      { logger, rateWindow: failedWindow, runtime: failedRuntime },
    );
    expect(failedFirst.decision.action).toBe("allow");
    const failedSecond = await screenTelegramEvent(
      await copy(1, "-300rep", "quiet-line"),
      { logger, rateWindow: failedWindow, runtime: failedRuntime },
    );
    expect(failedSecond.decision.action).toBe("allow");
    expect(JSON.stringify(logger.entries)).toContain("runtime_failed");
    expect(JSON.stringify(logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(logger.entries)).not.toContain("quiet-line");
  });

  it("mutes for one chat's rule duration and leaves the other chat at one hour", async () => {
    const runtime = createMemoryRuntimeStore();
    expect(await runtime.setMuteDuration("local", "-100mute", 120)).toBe(true);
    const text = "请免费领取礼品";
    const source = {
      async loadChat() {
        return null;
      },
      async loadDefault() {
        return {
          version: 1,
          aggregate: "max" as const,
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
    const moderator = createMemoryModerator();
    const hit = await screenTelegramEvent(
      await event(text, false, "-100mute"),
      {
        runtime,
        source,
        moderator,
        storage: createMemoryStorage(),
        cache: createMemoryCache(),
      },
    );
    expect(hit.decision.action).toBe("mute");
    expect(moderator.muted).toEqual([
      expect.objectContaining({
        chatId: "-100mute",
        actorId: "5",
        durationSeconds: 120,
      }),
    ]);
    expect(JSON.stringify(hit)).not.toContain(text);
    const otherMod = createMemoryModerator();
    const other = await screenTelegramEvent(
      await event(text, false, "-200mute"),
      {
        runtime,
        source,
        moderator: otherMod,
        storage: createMemoryStorage(),
        cache: createMemoryCache(),
      },
    );
    expect(other.decision.action).toBe("mute");
    expect(otherMod.muted).toEqual([
      expect.objectContaining({ durationSeconds: 3600 }),
    ]);
    const logger = createMemoryLogger();
    const broken = createMemoryRuntimeStore();
    const failedMod = createMemoryModerator();
    const failed = await screenTelegramEvent(
      await event(text, false, "-300mute"),
      {
        logger,
        source,
        moderator: failedMod,
        storage: createMemoryStorage(),
        cache: createMemoryCache(),
        runtime: {
          ...broken,
          async getMuteDuration() {
            throw new Error(text);
          },
        },
      },
    );
    expect(failed.decision.action).toBe("mute");
    expect(failedMod.muted).toEqual([
      expect.objectContaining({ durationSeconds: 3600 }),
    ]);
    expect(JSON.stringify(logger.entries)).toContain("runtime_failed");
    expect(JSON.stringify(logger.entries)).not.toContain(text);
  });

  it("restricts a new member for that chat's verification window", async () => {
    const runtime = createMemoryRuntimeStore();
    expect(await runtime.setCaptchaTtl("local", "-100cap", 120)).toBe(true);
    function join(chatId: string, id: string) {
      return parseEvent({
        id,
        tenantId: "local",
        chatId,
        kind: "chat_member",
        occurredAt: "2026-11-01T00:00:00.000Z",
        actor: { id: "77", isAdmin: false },
        membership: "join",
      });
    }
    const moderator = createMemoryModerator();
    const hit = await screenTelegramEvent(await join("-100cap", "cap_1"), {
      runtime,
      moderator,
      captchaStore: createMemoryCaptchaStore(),
      createNonce: () => "ab".repeat(8),
      storage: createMemoryStorage(),
      cache: createMemoryCache(),
    });
    expect(hit.decision.action).toBe("captcha");
    expect(moderator.restricted).toEqual([
      expect.objectContaining({
        chatId: "-100cap",
        actorId: "77",
        durationSeconds: 120,
      }),
    ]);
    const otherMod = createMemoryModerator();
    const other = await screenTelegramEvent(await join("-200cap", "cap_2"), {
      runtime,
      moderator: otherMod,
      captchaStore: createMemoryCaptchaStore(),
      createNonce: () => "cd".repeat(8),
      storage: createMemoryStorage(),
      cache: createMemoryCache(),
    });
    expect(other.decision.action).toBe("captcha");
    expect(otherMod.restricted).toEqual([
      expect.objectContaining({ durationSeconds: 300 }),
    ]);
    const phrase = "请免费领取礼品";
    const logger = createMemoryLogger();
    const broken = createMemoryRuntimeStore();
    const failedMod = createMemoryModerator();
    const failed = await screenTelegramEvent(await join("-300cap", "cap_3"), {
      logger,
      moderator: failedMod,
      captchaStore: createMemoryCaptchaStore(),
      createNonce: () => "ef".repeat(8),
      storage: createMemoryStorage(),
      cache: createMemoryCache(),
      runtime: {
        ...broken,
        async getCaptchaTtl() {
          throw new Error(phrase);
        },
      },
    });
    expect(failed.decision.action).toBe("captcha");
    expect(failedMod.restricted).toEqual([
      expect.objectContaining({ durationSeconds: 300 }),
    ]);
    expect(JSON.stringify(logger.entries)).toContain("runtime_failed");
    expect(JSON.stringify(logger.entries)).not.toContain(phrase);
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

  it("keeps hidden, chat, and user forwards until that chat asks", async () => {
    const text = "今天站会改到三点";
    const title = "机密频道名";
    const hash = await sha256Hex(text);
    async function forwarded(
      id: string,
      chatId: string,
      forward: "hidden" | "chat" | "user" | "channel",
    ) {
      return parseEvent({
        id,
        tenantId: "local",
        chatId,
        kind: "message",
        occurredAt: "2026-11-01T00:00:00.000Z",
        actor: { id: "5", isAdmin: false },
        message: {
          id: "9",
          text,
          textSha256: hash,
          forward,
        },
      });
    }
    for (const kind of ["hidden", "chat", "user"] as const) {
      const idle = await screenTelegramEvent(
        await forwarded(`tg_${kind}`, `-100${kind.length}`, kind),
        { rateWindow: createMemoryRateWindow() },
      );
      expect(idle.decision.action, kind).toBe("allow");
    }
    function source(
      ids: readonly ("hidden_forward" | "chat_forward" | "user_forward")[],
    ): RuleSource {
      const detectorFor = {
        hidden_forward: "forward_hidden",
        chat_forward: "forward_chat",
        user_forward: "forward_user",
      } as const;
      return {
        async loadChat() {
          return {
            version: 1,
            aggregate: "max",
            rules: [
              {
                id: "channel_forward",
                enabled: true,
                when: { eventKind: "message" },
                detectorIds: ["forward"],
                threshold: 1,
                actions: ["delete"],
              },
              ...ids.map((id) => ({
                id,
                enabled: true as const,
                when: { eventKind: "message" as const },
                detectorIds: [detectorFor[id]],
                threshold: 1,
                actions: ["delete" as const],
              })),
            ],
          };
        },
        async loadDefault() {
          return { version: 1, aggregate: "max", rules: [] };
        },
      };
    }
    const hiddenOnly = source(["hidden_forward"]);
    const hidden = await screenTelegramEvent(
      await forwarded("tg_h1", "-100671", "hidden"),
      {
        source: hiddenOnly,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(hidden.decision.action).toBe("delete");
    expect(hidden.decision.reasons).toContain("forward_hidden");
    expect(hidden.decision.ruleIds).toContain("hidden_forward");
    expect(hidden.decision.evidence).toEqual([
      { kind: "feature", summary: "forward:hidden" },
    ]);
    const stillUser = await screenTelegramEvent(
      await forwarded("tg_h2", "-100672", "user"),
      {
        source: hiddenOnly,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(stillUser.decision.action).toBe("allow");
    const channel = await screenTelegramEvent(
      await forwarded("tg_h3", "-100673", "channel"),
      {
        source: hiddenOnly,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(channel.decision.action).toBe("delete");
    expect(channel.decision.reasons).toContain("forward_channel");
    const all = source(["hidden_forward", "chat_forward", "user_forward"]);
    const chat = await screenTelegramEvent(
      await forwarded("tg_c1", "-100674", "chat"),
      {
        source: all,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(chat.decision.evidence).toEqual([
      { kind: "feature", summary: "forward:chat" },
    ]);
    const person = await screenTelegramEvent(
      await forwarded("tg_u1", "-100675", "user"),
      {
        source: all,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(person.decision.evidence).toEqual([
      { kind: "feature", summary: "forward:user" },
    ]);
    const dumped = JSON.stringify({
      hidden: hidden.decision,
      chat: chat.decision,
      person: person.decision,
    });
    expect(dumped).not.toContain(title);
    expect(dumped).not.toContain(text);
  });

  it("keeps silent media until a chat locks that kind", async () => {
    const pack = "SecretPack";
    const emoji = "\u{1F3B0}";
    const kinds = [
      [
        "sticker",
        {
          sticker: {
            file_id: "f",
            file_unique_id: "STICK",
            set_name: pack,
            width: 1,
            height: 1,
          },
        },
      ],
      [
        "animation",
        {
          animation: {
            file_id: "f",
            file_unique_id: "GIF",
            file_name: "secret.gif",
            width: 1,
            height: 1,
            duration: 1,
          },
        },
      ],
      [
        "voice",
        { voice: { file_id: "f", file_unique_id: "VOICE", duration: 1 } },
      ],
      [
        "video_note",
        {
          video_note: {
            file_id: "f",
            file_unique_id: "NOTE",
            length: 1,
            duration: 1,
          },
        },
      ],
      ["dice", { dice: { emoji, value: 59 } }],
    ] as const;
    const events = [];
    for (const [index, [kind, body]] of kinds.entries()) {
      const normalized = await normalizeUpdate({
        update: {
          update_id: 6500 + index,
          message: {
            message_id: 650 + index,
            date: 1761955200,
            chat: { id: -100650 - index, type: "supergroup" },
            from: { id: 77 },
            ...body,
          },
        },
        tenantId: "local",
        adminUserIds: [],
        nowIso: "2026-11-01T00:00:00.000Z",
      });
      expect(normalized.status, kind).toBe("event");
      if (normalized.status !== "event") {
        return;
      }
      expect(normalized.event.message?.media, kind).toBe(kind);
      const idle = await screenTelegramEvent(normalized.event, {
        rateWindow: createMemoryRateWindow(),
      });
      expect(idle.decision.action, kind).toBe("allow");
      events.push(normalized.event);
    }
    function source(kind: (typeof kinds)[number][0]): RuleSource {
      return {
        async loadChat() {
          return {
            version: 1,
            aggregate: "max",
            rules: [
              {
                id: `media_${kind}`,
                enabled: true,
                when: { eventKind: "message" },
                detectorIds: [`media_${kind}`],
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
    }
    const sticker = events[0];
    if (!sticker) {
      return;
    }
    const moderator = createMemoryModerator();
    const removed = await screenTelegramEvent(
      { ...sticker, id: "tg_lock_sticker", chatId: "-100660" },
      {
        source: source("sticker"),
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator,
      },
    );
    expect(removed.decision.action).toBe("delete");
    expect(removed.decision.reasons).toContain("media_sticker");
    expect(removed.decision.ruleIds).toContain("media_sticker");
    expect(removed.decision.evidence).toEqual([
      { kind: "feature", summary: "media:sticker" },
    ]);
    expect(moderator.deleted.map((item) => item.messageId)).toEqual(["650"]);
    const animation = events[1];
    if (!animation) {
      return;
    }
    const kept = await screenTelegramEvent(
      { ...animation, id: "tg_lock_gif", chatId: "-100661" },
      {
        source: source("sticker"),
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: createMemoryModerator(),
      },
    );
    expect(kept.decision.action).toBe("allow");
    const paid = await normalizeUpdate({
      update: {
        update_id: 6510,
        message: {
          message_id: 651,
          date: 1761955200,
          chat: { id: -100662, type: "supergroup" },
          from: { id: 77 },
          is_paid_post: true,
          sticker: {
            file_id: "f",
            file_unique_id: "PAIDSTICK",
            set_name: pack,
            width: 1,
            height: 1,
          },
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(paid.status).toBe("event");
    if (paid.status !== "event") {
      return;
    }
    const paidModerator = createMemoryModerator();
    const skipped = await screenTelegramEvent(paid.event, {
      source: source("sticker"),
      cache: createMemoryCache(),
      rateWindow: createMemoryRateWindow(),
      moderator: paidModerator,
    });
    expect(skipped.actionResults).toContainEqual({
      actionId: "delete",
      status: "skipped",
      detail: "paid_post",
    });
    expect(paidModerator.deleted).toEqual([]);
    const dumped = JSON.stringify({
      removed: removed.decision,
      skipped: skipped.decision,
    });
    expect(dumped).not.toContain(pack);
    expect(dumped).not.toContain(emoji);
    expect(dumped).not.toContain("secret.gif");
    expect(dumped).not.toContain("STICK");
    expect(JSON.stringify(events[4])).not.toContain(emoji);
  });

  it("keeps other scripts until a chat locks that one", async () => {
    const arabic = "اشتر الآن مجانا اليوم";
    const cyrillic = "Бесплатно получите подарок";
    const chinese = "今天站会没有广告";
    async function posted(
      updateId: number,
      chatId: number,
      text: string,
      paid = false,
    ) {
      const normalized = await normalizeUpdate({
        update: {
          update_id: updateId,
          message: {
            message_id: updateId,
            date: 1761955200,
            chat: { id: chatId, type: "supergroup" },
            from: { id: 77 },
            text,
            ...(paid ? { is_paid_post: true } : {}),
          },
        },
        tenantId: "local",
        adminUserIds: [],
        nowIso: "2026-11-01T00:00:00.000Z",
      });
      expect(normalized.status).toBe("event");
      if (normalized.status !== "event") {
        throw new Error("expected event");
      }
      return normalized.event;
    }
    for (const [text, chatId] of [
      [arabic, -100680],
      [cyrillic, -100681],
      [chinese, -100682],
    ] as const) {
      const idle = await screenTelegramEvent(
        await posted(6800 + Math.abs(chatId), chatId, text),
        { rateWindow: createMemoryRateWindow() },
      );
      expect(idle.decision.action).toBe("allow");
    }
    function source(id: "script_arabic" | "script_cyrillic"): RuleSource {
      return {
        async loadChat() {
          return {
            version: 1,
            aggregate: "max",
            rules: [
              {
                id,
                enabled: true,
                when: { eventKind: "message" },
                detectorIds: [id],
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
    }
    const arabicSource = source("script_arabic");
    const removed = await screenTelegramEvent(
      await posted(6810, -100683, arabic),
      {
        source: arabicSource,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: createMemoryModerator(),
      },
    );
    expect(removed.decision.action).toBe("delete");
    expect(removed.decision.reasons).toContain("script_arabic");
    expect(removed.decision.ruleIds).toContain("script_arabic");
    expect(removed.decision.evidence).toEqual([
      { kind: "feature", summary: "script:arabic" },
    ]);
    const keptRussian = await screenTelegramEvent(
      await posted(6811, -100684, cyrillic),
      {
        source: arabicSource,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(keptRussian.decision.action).toBe("allow");
    const keptTie = await screenTelegramEvent(
      await posted(6812, -100685, "hello مرحبا"),
      {
        source: arabicSource,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(keptTie.decision.action).toBe("allow");
    const russian = await screenTelegramEvent(
      await posted(6813, -100686, cyrillic),
      {
        source: source("script_cyrillic"),
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(russian.decision.evidence).toEqual([
      { kind: "feature", summary: "script:cyrillic" },
    ]);
    const paidModerator = createMemoryModerator();
    const skipped = await screenTelegramEvent(
      await posted(6814, -100687, arabic, true),
      {
        source: arabicSource,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: paidModerator,
      },
    );
    expect(skipped.decision.action).toBe("delete");
    expect(skipped.actionResults).toContainEqual({
      actionId: "delete",
      status: "skipped",
      detail: "paid_post",
    });
    expect(paidModerator.deleted).toEqual([]);
    const dumped = JSON.stringify({
      removed: removed.decision,
      russian: russian.decision,
      skipped: skipped.decision,
    });
    expect(dumped).not.toContain(arabic);
    expect(dumped).not.toContain(cyrillic);
    expect(dumped).not.toContain(chinese);
  });

  it("keeps messages sent as another channel until that chat asks", async () => {
    const title = "机密频道代发";
    const channelId = -100777001;
    async function posted(input: {
      updateId: number;
      chatId: number;
      senderId?: number;
      senderType?: string;
      automatic?: boolean;
      paid?: boolean;
      text?: string;
    }) {
      const normalized = await normalizeUpdate({
        update: {
          update_id: input.updateId,
          message: {
            message_id: input.updateId,
            date: 1761955200,
            chat: { id: input.chatId, type: "supergroup" },
            from: { id: 77 },
            text: input.text ?? "今天站会",
            ...(input.paid ? { is_paid_post: true } : {}),
            ...(input.automatic ? { is_automatic_forward: true } : {}),
            ...(input.senderId === undefined
              ? {}
              : {
                  sender_chat: {
                    id: input.senderId,
                    ...(input.senderType ? { type: input.senderType } : {}),
                    title,
                  },
                }),
          },
        },
        tenantId: "local",
        adminUserIds: [],
        nowIso: "2026-11-01T00:00:00.000Z",
      });
      expect(normalized.status).toBe("event");
      if (normalized.status !== "event") {
        throw new Error("expected event");
      }
      return normalized.event;
    }
    const idle = await posted({
      updateId: 6900,
      chatId: -100690,
      senderId: channelId,
      senderType: "channel",
    });
    expect(idle.message?.asChannel).toBe(true);
    expect(JSON.stringify(idle)).not.toContain(title);
    expect(JSON.stringify(idle)).not.toContain(String(channelId));
    const allowed = await screenTelegramEvent(idle, {
      rateWindow: createMemoryRateWindow(),
    });
    expect(allowed.decision.action).toBe("allow");
    const source: RuleSource = {
      async loadChat() {
        return {
          version: 1,
          aggregate: "max",
          rules: [
            {
              id: "channel_sender",
              enabled: true,
              when: { eventKind: "message" },
              detectorIds: ["channel_sender"],
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
    const removed = await screenTelegramEvent(
      await posted({
        updateId: 6901,
        chatId: -100691,
        senderId: channelId,
        senderType: "channel",
      }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: createMemoryModerator(),
      },
    );
    expect(removed.decision.action).toBe("delete");
    expect(removed.decision.reasons).toContain("channel_sender");
    expect(removed.decision.ruleIds).toContain("channel_sender");
    expect(removed.decision.evidence).toEqual([
      { kind: "feature", summary: "sender:channel" },
    ]);
    const mirror = await screenTelegramEvent(
      await posted({
        updateId: 6902,
        chatId: -100692,
        senderId: channelId,
        senderType: "channel",
        automatic: true,
      }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(mirror.decision.action).toBe("allow");
    const member = await screenTelegramEvent(
      await posted({ updateId: 6903, chatId: -100693 }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(member.decision.action).toBe("allow");
    const paidModerator = createMemoryModerator();
    const skipped = await screenTelegramEvent(
      await posted({
        updateId: 6904,
        chatId: -100694,
        senderId: channelId,
        senderType: "channel",
        paid: true,
      }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: paidModerator,
      },
    );
    expect(skipped.decision.action).toBe("delete");
    expect(skipped.actionResults).toContainEqual({
      actionId: "delete",
      status: "skipped",
      detail: "paid_post",
    });
    expect(paidModerator.deleted).toEqual([]);
    const dumped = JSON.stringify({
      removed: removed.decision,
      mirror: mirror.decision,
      skipped: skipped.decision,
    });
    expect(dumped).not.toContain(title);
    expect(dumped).not.toContain(String(channelId));
  });

  it("keeps a shared story until that chat asks", async () => {
    const title = "故事频道";
    const username = "storyposter440";
    const storyId = 880440;
    const posterId = -100777440;
    async function posted(input: {
      updateId: number;
      chatId: number;
      story?: boolean;
      reply?: boolean;
      paid?: boolean;
    }) {
      const card = {
        chat: { id: posterId, type: "channel", title, username },
        id: storyId,
      };
      const normalized = await normalizeUpdate({
        update: {
          update_id: input.updateId,
          message: {
            message_id: input.updateId,
            date: 1761955200,
            chat: { id: input.chatId, type: "supergroup" },
            from: { id: 81 },
            ...(input.reply ? { text: "今天站会" } : {}),
            ...(input.paid ? { is_paid_post: true } : {}),
            ...(input.story ? { story: card } : {}),
            ...(input.reply ? { reply_to_story: card } : {}),
          },
        },
        tenantId: "local",
        adminUserIds: [],
        nowIso: "2026-11-01T00:00:00.000Z",
      });
      expect(normalized.status).toBe("event");
      if (normalized.status !== "event") {
        throw new Error("expected event");
      }
      return normalized.event;
    }
    const idle = await posted({
      updateId: 7000,
      chatId: -100700,
      story: true,
    });
    expect(idle.message?.asStory).toBe(true);
    expect(idle.message?.text).toBe("");
    const idleDump = JSON.stringify(idle);
    expect(idleDump).not.toContain(title);
    expect(idleDump).not.toContain(username);
    expect(idleDump).not.toContain(String(storyId));
    expect(idleDump).not.toContain(String(posterId));
    const allowed = await screenTelegramEvent(idle, {
      rateWindow: createMemoryRateWindow(),
    });
    expect(allowed.decision.action).toBe("allow");
    const source: RuleSource = {
      async loadChat() {
        return {
          version: 1,
          aggregate: "max",
          rules: [
            {
              id: "shared_story",
              enabled: true,
              when: { eventKind: "message" },
              detectorIds: ["shared_story"],
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
    const removed = await screenTelegramEvent(
      await posted({ updateId: 7001, chatId: -100701, story: true }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: createMemoryModerator(),
      },
    );
    expect(removed.decision.action).toBe("delete");
    expect(removed.decision.reasons).toContain("shared_story");
    expect(removed.decision.ruleIds).toContain("shared_story");
    expect(removed.decision.evidence).toEqual([
      { kind: "feature", summary: "story:card" },
    ]);
    const reply = await screenTelegramEvent(
      await posted({ updateId: 7002, chatId: -100702, reply: true }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(reply.decision.action).toBe("allow");
    const member = await screenTelegramEvent(
      await posted({ updateId: 7003, chatId: -100703 }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(member.decision.action).toBe("allow");
    const paidModerator = createMemoryModerator();
    const skipped = await screenTelegramEvent(
      await posted({
        updateId: 7004,
        chatId: -100704,
        story: true,
        paid: true,
      }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: paidModerator,
      },
    );
    expect(skipped.decision.action).toBe("delete");
    expect(skipped.actionResults).toContainEqual({
      actionId: "delete",
      status: "skipped",
      detail: "paid_post",
    });
    expect(paidModerator.deleted).toEqual([]);
    const dumped = JSON.stringify({
      removed: removed.decision,
      reply: reply.decision,
      skipped: skipped.decision,
    });
    expect(dumped).not.toContain(title);
    expect(dumped).not.toContain(username);
    expect(dumped).not.toContain(String(storyId));
    expect(dumped).not.toContain(String(posterId));
  });

  it("keeps a bare location until that chat asks", async () => {
    const latitude = 23.1291;
    const longitude = 113.2644;
    const livePeriod = 90177;
    async function posted(input: {
      updateId: number;
      chatId: number;
      location?: boolean;
      venue?: boolean;
      paid?: boolean;
      text?: string;
    }) {
      const pin = { latitude, longitude, live_period: livePeriod };
      const normalized = await normalizeUpdate({
        update: {
          update_id: input.updateId,
          message: {
            message_id: input.updateId,
            date: 1761955200,
            chat: { id: input.chatId, type: "supergroup" },
            from: { id: 85 },
            ...(input.text ? { text: input.text } : {}),
            ...(input.paid ? { is_paid_post: true } : {}),
            ...(input.location ? { location: pin } : {}),
            ...(input.venue
              ? {
                  location: pin,
                  venue: {
                    location: pin,
                    title: "场馆名字",
                    address: "南京东路",
                  },
                }
              : {}),
          },
        },
        tenantId: "local",
        adminUserIds: [],
        nowIso: "2026-11-01T00:00:00.000Z",
      });
      expect(normalized.status).toBe("event");
      if (normalized.status !== "event") {
        throw new Error("expected event");
      }
      return normalized.event;
    }
    const idle = await posted({
      updateId: 7100,
      chatId: -100720,
      location: true,
    });
    expect(idle.message?.asLocation).toBe(true);
    expect(idle.message?.text).toBe("");
    const idleDump = JSON.stringify(idle);
    expect(idleDump).not.toContain(String(latitude));
    expect(idleDump).not.toContain(String(longitude));
    expect(idleDump).not.toContain(String(livePeriod));
    const allowed = await screenTelegramEvent(idle, {
      rateWindow: createMemoryRateWindow(),
    });
    expect(allowed.decision.action).toBe("allow");
    const source: RuleSource = {
      async loadChat() {
        return {
          version: 1,
          aggregate: "max",
          rules: [
            {
              id: "bare_location",
              enabled: true,
              when: { eventKind: "message" },
              detectorIds: ["bare_location"],
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
    const removed = await screenTelegramEvent(
      await posted({ updateId: 7101, chatId: -100721, location: true }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: createMemoryModerator(),
      },
    );
    expect(removed.decision.action).toBe("delete");
    expect(removed.decision.reasons).toContain("bare_location");
    expect(removed.decision.ruleIds).toContain("bare_location");
    expect(removed.decision.evidence).toEqual([
      { kind: "feature", summary: "location:pin" },
    ]);
    const venue = await screenTelegramEvent(
      await posted({ updateId: 7102, chatId: -100722, venue: true }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(venue.decision.action).toBe("allow");
    const member = await screenTelegramEvent(
      await posted({
        updateId: 7103,
        chatId: -100723,
        text: "今天站会",
      }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(member.decision.action).toBe("allow");
    const paidModerator = createMemoryModerator();
    const skipped = await screenTelegramEvent(
      await posted({
        updateId: 7104,
        chatId: -100724,
        location: true,
        paid: true,
      }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: paidModerator,
      },
    );
    expect(skipped.decision.action).toBe("delete");
    expect(skipped.actionResults).toContainEqual({
      actionId: "delete",
      status: "skipped",
      detail: "paid_post",
    });
    expect(paidModerator.deleted).toEqual([]);
    const dumped = JSON.stringify({
      removed: removed.decision,
      venue: venue.decision,
      skipped: skipped.decision,
    });
    expect(dumped).not.toContain(String(latitude));
    expect(dumped).not.toContain(String(longitude));
    expect(dumped).not.toContain(String(livePeriod));
    expect(dumped).not.toContain("场馆名字");
    expect(dumped).not.toContain("南京东路");
  });

  it("keeps a giveaway card until that chat asks", async () => {
    const title = "抽奖频道";
    const username = "giveawayposter441";
    const channelId = -100777441;
    const winnerCount = 90177;
    async function posted(input: {
      updateId: number;
      chatId: number;
      giveaway?: boolean;
      winners?: boolean;
      poll?: boolean;
      paid?: boolean;
      text?: string;
    }) {
      const channel = {
        id: channelId,
        type: "channel",
        title,
        username,
      };
      const normalized = await normalizeUpdate({
        update: {
          update_id: input.updateId,
          message: {
            message_id: input.updateId,
            date: 1761955200,
            chat: { id: input.chatId, type: "supergroup" },
            from: { id: 90 },
            ...(input.text ? { text: input.text } : {}),
            ...(input.paid ? { is_paid_post: true } : {}),
            ...(input.giveaway
              ? {
                  giveaway: {
                    chats: [channel],
                    winners_selection_date: 1700000001,
                    winner_count: winnerCount,
                  },
                }
              : {}),
            ...(input.winners
              ? {
                  giveaway_winners: {
                    chat: { ...channel, title: "结束频道" },
                    winners_selection_date: 1700000001,
                    winner_count: winnerCount,
                    winners: [{ id: 991441, first_name: "中奖的人" }],
                  },
                }
              : {}),
            ...(input.poll
              ? {
                  poll: {
                    id: "poll441",
                    question: "今天站会",
                    options: [{ text: title }],
                    total_voter_count: 1,
                    is_closed: false,
                    is_anonymous: true,
                    type: "regular",
                    allows_multiple_answers: false,
                  },
                }
              : {}),
          },
        },
        tenantId: "local",
        adminUserIds: [],
        nowIso: "2026-11-01T00:00:00.000Z",
      });
      expect(normalized.status).toBe("event");
      if (normalized.status !== "event") {
        throw new Error("expected event");
      }
      return normalized.event;
    }
    const idle = await posted({
      updateId: 7200,
      chatId: -100740,
      giveaway: true,
    });
    expect(idle.message?.asGiveaway).toBe(true);
    expect(idle.message?.text).toBe("");
    const idleDump = JSON.stringify(idle);
    expect(idleDump).not.toContain(title);
    expect(idleDump).not.toContain(username);
    expect(idleDump).not.toContain(String(channelId));
    expect(idleDump).not.toContain(String(winnerCount));
    const allowed = await screenTelegramEvent(idle, {
      rateWindow: createMemoryRateWindow(),
    });
    expect(allowed.decision.action).toBe("allow");
    const source: RuleSource = {
      async loadChat() {
        return {
          version: 1,
          aggregate: "max",
          rules: [
            {
              id: "giveaway_card",
              enabled: true,
              when: { eventKind: "message" },
              detectorIds: ["giveaway_card"],
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
    const removed = await screenTelegramEvent(
      await posted({ updateId: 7201, chatId: -100741, giveaway: true }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: createMemoryModerator(),
      },
    );
    expect(removed.decision.action).toBe("delete");
    expect(removed.decision.reasons).toContain("giveaway_card");
    expect(removed.decision.ruleIds).toContain("giveaway_card");
    expect(removed.decision.evidence).toEqual([
      { kind: "feature", summary: "giveaway:card" },
    ]);
    const finished = await screenTelegramEvent(
      await posted({ updateId: 7202, chatId: -100742, winners: true }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: createMemoryModerator(),
      },
    );
    expect(finished.decision.action).toBe("delete");
    expect(finished.decision.evidence).toEqual([
      { kind: "feature", summary: "giveaway:card" },
    ]);
    const poll = await screenTelegramEvent(
      await posted({ updateId: 7203, chatId: -100743, poll: true }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(poll.decision.action).toBe("allow");
    const paidModerator = createMemoryModerator();
    const skipped = await screenTelegramEvent(
      await posted({
        updateId: 7204,
        chatId: -100744,
        giveaway: true,
        paid: true,
      }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: paidModerator,
      },
    );
    expect(skipped.decision.action).toBe("delete");
    expect(skipped.actionResults).toContainEqual({
      actionId: "delete",
      status: "skipped",
      detail: "paid_post",
    });
    expect(paidModerator.deleted).toEqual([]);
    const dumped = JSON.stringify({
      removed: removed.decision,
      finished: finished.decision,
      poll: poll.decision,
      skipped: skipped.decision,
    });
    expect(dumped).not.toContain(title);
    expect(dumped).not.toContain(username);
    expect(dumped).not.toContain(String(channelId));
    expect(dumped).not.toContain(String(winnerCount));
    expect(dumped).not.toContain("结束频道");
    expect(dumped).not.toContain("中奖的人");
    expect(dumped).not.toContain("991441");
  });

  it("keeps a video-chat notice until that chat asks", async () => {
    const duration = 90177;
    const startDate = 1700000002;
    async function posted(input: {
      updateId: number;
      chatId: number;
      started?: boolean;
      ended?: boolean;
      scheduled?: boolean;
      invited?: boolean;
      paid?: boolean;
    }) {
      const normalized = await normalizeUpdate({
        update: {
          update_id: input.updateId,
          message: {
            message_id: input.updateId,
            date: 1761955200,
            chat: { id: input.chatId, type: "supergroup" },
            from: { id: 96 },
            ...(input.paid ? { is_paid_post: true } : {}),
            ...(input.started ? { video_chat_started: {} } : {}),
            ...(input.ended ? { video_chat_ended: { duration } } : {}),
            ...(input.scheduled
              ? { video_chat_scheduled: { start_date: startDate } }
              : {}),
            ...(input.invited
              ? {
                  video_chat_participants_invited: {
                    users: [{ id: 991442, first_name: "干净名字" }],
                  },
                }
              : {}),
          },
        },
        tenantId: "local",
        adminUserIds: [],
        nowIso: "2026-11-01T00:00:00.000Z",
      });
      expect(normalized.status).toBe("event");
      if (normalized.status !== "event") {
        throw new Error("expected event");
      }
      return normalized.event;
    }
    const idle = await posted({
      updateId: 7300,
      chatId: -100760,
      started: true,
    });
    expect(idle.message?.call).toBe("started");
    expect(idle.message?.text).toBe("");
    const allowed = await screenTelegramEvent(idle, {
      rateWindow: createMemoryRateWindow(),
    });
    expect(allowed.decision.action).toBe("allow");
    const source: RuleSource = {
      async loadChat() {
        return {
          version: 1,
          aggregate: "max",
          rules: [
            {
              id: "call_notice",
              enabled: true,
              when: { eventKind: "message" },
              detectorIds: ["call_notice"],
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
    const removed = await screenTelegramEvent(
      await posted({ updateId: 7301, chatId: -100761, started: true }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: createMemoryModerator(),
      },
    );
    expect(removed.decision.action).toBe("delete");
    expect(removed.decision.reasons).toContain("call_notice");
    expect(removed.decision.ruleIds).toContain("call_notice");
    expect(removed.decision.evidence).toEqual([
      { kind: "feature", summary: "call:started" },
    ]);
    const ended = await screenTelegramEvent(
      await posted({ updateId: 7302, chatId: -100762, ended: true }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: createMemoryModerator(),
      },
    );
    expect(ended.decision.action).toBe("delete");
    expect(ended.decision.evidence).toEqual([
      { kind: "feature", summary: "call:ended" },
    ]);
    const scheduled = await screenTelegramEvent(
      await posted({ updateId: 7303, chatId: -100763, scheduled: true }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: createMemoryModerator(),
      },
    );
    expect(scheduled.decision.action).toBe("delete");
    expect(scheduled.decision.evidence).toEqual([
      { kind: "feature", summary: "call:scheduled" },
    ]);
    const invited = await screenTelegramEvent(
      await posted({ updateId: 7304, chatId: -100764, invited: true }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(invited.decision.action).toBe("allow");
    const paidModerator = createMemoryModerator();
    const skipped = await screenTelegramEvent(
      await posted({
        updateId: 7305,
        chatId: -100765,
        ended: true,
        paid: true,
      }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: paidModerator,
      },
    );
    expect(skipped.decision.action).toBe("delete");
    expect(skipped.actionResults).toContainEqual({
      actionId: "delete",
      status: "skipped",
      detail: "paid_post",
    });
    expect(paidModerator.deleted).toEqual([]);
    const dumped = JSON.stringify({
      removed: removed.decision,
      ended: ended.decision,
      scheduled: scheduled.decision,
      invited: invited.decision,
      skipped: skipped.decision,
    });
    expect(dumped).not.toContain(String(duration));
    expect(dumped).not.toContain(String(startDate));
    expect(dumped).not.toContain("干净名字");
    expect(dumped).not.toContain("991442");
  });

  it("keeps a renamed chat until that chat asks", async () => {
    const title = "改名广告标题";
    async function posted(input: {
      updateId: number;
      chatId: number;
      renamed?: boolean;
      blank?: boolean;
      photo?: boolean;
      paid?: boolean;
    }) {
      const normalized = await normalizeUpdate({
        update: {
          update_id: input.updateId,
          message: {
            message_id: input.updateId,
            date: 1761955200,
            chat: { id: input.chatId, type: "supergroup" },
            from: { id: 96 },
            ...(input.paid ? { is_paid_post: true } : {}),
            ...(input.renamed ? { new_chat_title: title } : {}),
            ...(input.blank ? { new_chat_title: "" } : {}),
            ...(input.photo
              ? {
                  new_chat_photo: [
                    {
                      file_id: "wallfile4993",
                      file_unique_id: "uniq4993",
                      width: 1,
                      height: 1,
                    },
                  ],
                }
              : {}),
          },
        },
        tenantId: "local",
        adminUserIds: [],
        nowIso: "2026-11-01T00:00:00.000Z",
      });
      expect(normalized.status).toBe("event");
      if (normalized.status !== "event") {
        throw new Error("expected event");
      }
      return normalized.event;
    }
    const idle = await posted({
      updateId: 7400,
      chatId: -100770,
      renamed: true,
    });
    expect(idle.message?.asTitle).toBe(true);
    expect(idle.message?.text).toBe("");
    const allowed = await screenTelegramEvent(idle, {
      rateWindow: createMemoryRateWindow(),
    });
    expect(allowed.decision.action).toBe("allow");
    const source: RuleSource = {
      async loadChat() {
        return {
          version: 1,
          aggregate: "max",
          rules: [
            {
              id: "chat_title",
              enabled: true,
              when: { eventKind: "message" },
              detectorIds: ["chat_title"],
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
    const removed = await screenTelegramEvent(
      await posted({ updateId: 7401, chatId: -100771, renamed: true }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: createMemoryModerator(),
      },
    );
    expect(removed.decision.action).toBe("delete");
    expect(removed.decision.reasons).toContain("chat_title");
    expect(removed.decision.ruleIds).toContain("chat_title");
    expect(removed.decision.evidence).toEqual([
      { kind: "feature", summary: "title:rename" },
    ]);
    const blank = await screenTelegramEvent(
      await posted({ updateId: 7402, chatId: -100772, blank: true }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(blank.decision.action).toBe("allow");
    const photo = await screenTelegramEvent(
      await posted({ updateId: 7403, chatId: -100773, photo: true }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(photo.decision.action).toBe("allow");
    const paidModerator = createMemoryModerator();
    const skipped = await screenTelegramEvent(
      await posted({
        updateId: 7404,
        chatId: -100774,
        renamed: true,
        paid: true,
      }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: paidModerator,
      },
    );
    expect(skipped.decision.action).toBe("delete");
    expect(skipped.actionResults).toContainEqual({
      actionId: "delete",
      status: "skipped",
      detail: "paid_post",
    });
    expect(paidModerator.deleted).toEqual([]);
    const dumped = JSON.stringify({
      removed: removed.decision,
      blank: blank.decision,
      photo: photo.decision,
      skipped: skipped.decision,
    });
    expect(dumped).not.toContain(title);
    expect(dumped).not.toContain("wallfile4993");
    expect(dumped).not.toContain("uniq4993");
  });

  it("keeps a community notice until that chat asks", async () => {
    const name = "社区广告名字";
    const communityId = 880445991;
    async function posted(input: {
      updateId: number;
      chatId: number;
      added?: boolean;
      joined?: boolean;
      removed?: boolean;
      empty?: boolean;
      paid?: boolean;
    }) {
      const normalized = await normalizeUpdate({
        update: {
          update_id: input.updateId,
          message: {
            message_id: input.updateId,
            date: 1761955200,
            chat: { id: input.chatId, type: "supergroup" },
            from: { id: 96 },
            ...(input.paid ? { is_paid_post: true } : {}),
            ...(input.added
              ? {
                  community_chat_added: {
                    community: { id: communityId, name },
                  },
                }
              : {}),
            ...(input.joined
              ? {
                  community_chat_joined: {
                    community: { id: communityId, name },
                  },
                }
              : {}),
            ...(input.removed ? { community_chat_removed: {} } : {}),
            ...(input.empty ? { community_chat_added: {} } : {}),
          },
        },
        tenantId: "local",
        adminUserIds: [],
        nowIso: "2026-11-01T00:00:00.000Z",
      });
      expect(normalized.status).toBe("event");
      if (normalized.status !== "event") {
        throw new Error("expected event");
      }
      return normalized.event;
    }
    const idle = await posted({
      updateId: 7500,
      chatId: -100780,
      added: true,
    });
    expect(idle.message?.community).toBe("added");
    expect(idle.message?.text).toBe("");
    const allowed = await screenTelegramEvent(idle, {
      rateWindow: createMemoryRateWindow(),
    });
    expect(allowed.decision.action).toBe("allow");
    const source: RuleSource = {
      async loadChat() {
        return {
          version: 1,
          aggregate: "max",
          rules: [
            {
              id: "community_notice",
              enabled: true,
              when: { eventKind: "message" },
              detectorIds: ["community_notice"],
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
    const removed = await screenTelegramEvent(
      await posted({ updateId: 7501, chatId: -100781, added: true }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: createMemoryModerator(),
      },
    );
    expect(removed.decision.action).toBe("delete");
    expect(removed.decision.reasons).toContain("community_notice");
    expect(removed.decision.ruleIds).toContain("community_notice");
    expect(removed.decision.evidence).toEqual([
      { kind: "feature", summary: "community:added" },
    ]);
    const joined = await screenTelegramEvent(
      await posted({ updateId: 7502, chatId: -100782, joined: true }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: createMemoryModerator(),
      },
    );
    expect(joined.decision.action).toBe("delete");
    expect(joined.decision.evidence).toEqual([
      { kind: "feature", summary: "community:joined" },
    ]);
    const left = await screenTelegramEvent(
      await posted({ updateId: 7503, chatId: -100783, removed: true }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: createMemoryModerator(),
      },
    );
    expect(left.decision.action).toBe("delete");
    expect(left.decision.evidence).toEqual([
      { kind: "feature", summary: "community:removed" },
    ]);
    const empty = await screenTelegramEvent(
      await posted({ updateId: 7504, chatId: -100784, empty: true }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(empty.decision.action).toBe("allow");
    const paidModerator = createMemoryModerator();
    const skipped = await screenTelegramEvent(
      await posted({
        updateId: 7505,
        chatId: -100785,
        added: true,
        paid: true,
      }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: paidModerator,
      },
    );
    expect(skipped.decision.action).toBe("delete");
    expect(skipped.actionResults).toContainEqual({
      actionId: "delete",
      status: "skipped",
      detail: "paid_post",
    });
    expect(paidModerator.deleted).toEqual([]);
    const dumped = JSON.stringify({
      removed: removed.decision,
      joined: joined.decision,
      left: left.decision,
      empty: empty.decision,
      skipped: skipped.decision,
    });
    expect(dumped).not.toContain(name);
    expect(dumped).not.toContain(String(communityId));
  });

  it("keeps a shared chat until that chat asks", async () => {
    const title = "分享广告标题";
    const requestId = 446446001;
    const sharedId = -100777446;
    async function posted(input: {
      updateId: number;
      chatId: number;
      shared?: boolean;
      users?: boolean;
      empty?: boolean;
      paid?: boolean;
    }) {
      const normalized = await normalizeUpdate({
        update: {
          update_id: input.updateId,
          message: {
            message_id: input.updateId,
            date: 1761955200,
            chat: { id: input.chatId, type: "supergroup" },
            from: { id: 96 },
            ...(input.paid ? { is_paid_post: true } : {}),
            ...(input.shared
              ? {
                  chat_shared: {
                    request_id: requestId,
                    chat_id: sharedId,
                    title,
                    username: "shareposter446",
                  },
                }
              : {}),
            ...(input.users
              ? {
                  users_shared: {
                    request_id: requestId,
                    users: [{ user_id: 991446, first_name: "干净名字" }],
                  },
                }
              : {}),
            ...(input.empty ? { chat_shared: {} } : {}),
          },
        },
        tenantId: "local",
        adminUserIds: [],
        nowIso: "2026-11-01T00:00:00.000Z",
      });
      expect(normalized.status).toBe("event");
      if (normalized.status !== "event") {
        throw new Error("expected event");
      }
      return normalized.event;
    }
    const idle = await posted({
      updateId: 7600,
      chatId: -100790,
      shared: true,
    });
    expect(idle.message?.asSharedChat).toBe(true);
    expect(idle.message?.text).toBe("");
    expect(JSON.stringify(idle)).not.toContain(title);
    expect(JSON.stringify(idle)).not.toContain("100777446");
    const allowed = await screenTelegramEvent(idle, {
      rateWindow: createMemoryRateWindow(),
    });
    expect(allowed.decision.action).toBe("allow");
    const source: RuleSource = {
      async loadChat() {
        return {
          version: 1,
          aggregate: "max",
          rules: [
            {
              id: "shared_chat",
              enabled: true,
              when: { eventKind: "message" },
              detectorIds: ["shared_chat"],
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
    const removed = await screenTelegramEvent(
      await posted({ updateId: 7601, chatId: -100791, shared: true }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: createMemoryModerator(),
      },
    );
    expect(removed.decision.action).toBe("delete");
    expect(removed.decision.reasons).toContain("shared_chat");
    expect(removed.decision.ruleIds).toContain("shared_chat");
    expect(removed.decision.evidence).toEqual([
      { kind: "feature", summary: "chat:shared" },
    ]);
    const users = await screenTelegramEvent(
      await posted({ updateId: 7602, chatId: -100792, users: true }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(users.decision.action).toBe("allow");
    const empty = await screenTelegramEvent(
      await posted({ updateId: 7603, chatId: -100793, empty: true }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(empty.decision.action).toBe("allow");
    const paidModerator = createMemoryModerator();
    const skipped = await screenTelegramEvent(
      await posted({
        updateId: 7604,
        chatId: -100794,
        shared: true,
        paid: true,
      }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: paidModerator,
      },
    );
    expect(skipped.decision.action).toBe("delete");
    expect(skipped.actionResults).toContainEqual({
      actionId: "delete",
      status: "skipped",
      detail: "paid_post",
    });
    expect(paidModerator.deleted).toEqual([]);
    const dumped = JSON.stringify({
      removed: removed.decision,
      users: users.decision,
      empty: empty.decision,
      skipped: skipped.decision,
    });
    expect(dumped).not.toContain(title);
    expect(dumped).not.toContain("shareposter446");
    expect(dumped).not.toContain(String(requestId));
    expect(dumped).not.toContain("100777446");
    expect(dumped).not.toContain("991446");
    expect(dumped).not.toContain("干净名字");
  });

  it("keeps a chat photo until that chat asks", async () => {
    const fileId = "AgADphoto447";
    const uniqueId = "uniqphoto447";
    async function posted(input: {
      updateId: number;
      chatId: number;
      set?: boolean;
      cleared?: boolean;
      empty?: boolean;
      paid?: boolean;
    }) {
      const normalized = await normalizeUpdate({
        update: {
          update_id: input.updateId,
          message: {
            message_id: input.updateId,
            date: 1761955200,
            chat: { id: input.chatId, type: "supergroup" },
            from: { id: 96 },
            ...(input.paid ? { is_paid_post: true } : {}),
            ...(input.set
              ? {
                  new_chat_photo: [
                    {
                      file_id: fileId,
                      file_unique_id: uniqueId,
                      width: 90177,
                      height: 90178,
                    },
                  ],
                }
              : {}),
            ...(input.cleared ? { delete_chat_photo: true } : {}),
            ...(input.empty ? { new_chat_photo: [] } : {}),
          },
        },
        tenantId: "local",
        adminUserIds: [],
        nowIso: "2026-11-01T00:00:00.000Z",
      });
      expect(normalized.status).toBe("event");
      if (normalized.status !== "event") {
        throw new Error("expected event");
      }
      return normalized.event;
    }
    const idle = await posted({
      updateId: 7700,
      chatId: -100795,
      set: true,
    });
    expect(idle.message?.photo).toBe("set");
    expect(idle.message?.text).toBe("");
    expect(JSON.stringify(idle)).not.toContain(fileId);
    expect(JSON.stringify(idle)).not.toContain("90177");
    const allowed = await screenTelegramEvent(idle, {
      rateWindow: createMemoryRateWindow(),
    });
    expect(allowed.decision.action).toBe("allow");
    const source: RuleSource = {
      async loadChat() {
        return {
          version: 1,
          aggregate: "max",
          rules: [
            {
              id: "chat_photo",
              enabled: true,
              when: { eventKind: "message" },
              detectorIds: ["chat_photo"],
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
    const removed = await screenTelegramEvent(
      await posted({ updateId: 7701, chatId: -100796, set: true }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: createMemoryModerator(),
      },
    );
    expect(removed.decision.action).toBe("delete");
    expect(removed.decision.reasons).toContain("chat_photo");
    expect(removed.decision.ruleIds).toContain("chat_photo");
    expect(removed.decision.evidence).toEqual([
      { kind: "feature", summary: "photo:set" },
    ]);
    const cleared = await screenTelegramEvent(
      await posted({ updateId: 7702, chatId: -100797, cleared: true }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(cleared.decision.action).toBe("delete");
    expect(cleared.decision.evidence).toEqual([
      { kind: "feature", summary: "photo:cleared" },
    ]);
    const empty = await screenTelegramEvent(
      await posted({ updateId: 7703, chatId: -100798, empty: true }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(empty.decision.action).toBe("allow");
    const paidModerator = createMemoryModerator();
    const skipped = await screenTelegramEvent(
      await posted({
        updateId: 7704,
        chatId: -100799,
        set: true,
        paid: true,
      }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: paidModerator,
      },
    );
    expect(skipped.decision.action).toBe("delete");
    expect(skipped.actionResults).toContainEqual({
      actionId: "delete",
      status: "skipped",
      detail: "paid_post",
    });
    expect(paidModerator.deleted).toEqual([]);
    const dumped = JSON.stringify({
      removed: removed.decision,
      cleared: cleared.decision,
      empty: empty.decision,
      skipped: skipped.decision,
    });
    expect(dumped).not.toContain(fileId);
    expect(dumped).not.toContain(uniqueId);
    expect(dumped).not.toContain("90177");
    expect(dumped).not.toContain("90178");
  });

  it("keeps a chat background until that chat asks", async () => {
    const filename = "壁纸广告文件名";
    const fileId = "AgADwall448";
    const themeName = "主题广告448";
    async function posted(input: {
      updateId: number;
      chatId: number;
      kind?: "wallpaper" | "pattern" | "fill" | "theme";
      empty?: boolean;
      paid?: boolean;
    }) {
      const type =
        input.kind === "wallpaper" || input.kind === "pattern"
          ? {
              type: input.kind,
              document: {
                file_id: fileId,
                file_unique_id: "uniqwall448",
                file_name: filename,
              },
              theme_name: themeName,
            }
          : input.kind === "fill"
            ? { type: "fill", fill: { type: "solid", color: 90179 } }
            : input.kind === "theme"
              ? { type: "chat_theme", theme_name: themeName }
              : undefined;
      const normalized = await normalizeUpdate({
        update: {
          update_id: input.updateId,
          message: {
            message_id: input.updateId,
            date: 1761955200,
            chat: { id: input.chatId, type: "supergroup" },
            from: { id: 96 },
            ...(input.paid ? { is_paid_post: true } : {}),
            ...(type ? { chat_background_set: { type } } : {}),
            ...(input.empty ? { chat_background_set: {} } : {}),
          },
        },
        tenantId: "local",
        adminUserIds: [],
        nowIso: "2026-11-01T00:00:00.000Z",
      });
      expect(normalized.status).toBe("event");
      if (normalized.status !== "event") {
        throw new Error("expected event");
      }
      return normalized.event;
    }
    const idle = await posted({
      updateId: 7800,
      chatId: -100800,
      kind: "wallpaper",
    });
    expect(idle.message?.background).toBe("wallpaper");
    expect(idle.message?.text).toBe("");
    expect(JSON.stringify(idle)).not.toContain(filename);
    expect(JSON.stringify(idle)).not.toContain(fileId);
    const allowed = await screenTelegramEvent(idle, {
      rateWindow: createMemoryRateWindow(),
    });
    expect(allowed.decision.action).toBe("allow");
    const source: RuleSource = {
      async loadChat() {
        return {
          version: 1,
          aggregate: "max",
          rules: [
            {
              id: "chat_background",
              enabled: true,
              when: { eventKind: "message" },
              detectorIds: ["chat_background"],
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
    const removed = await screenTelegramEvent(
      await posted({ updateId: 7801, chatId: -100801, kind: "wallpaper" }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: createMemoryModerator(),
      },
    );
    expect(removed.decision.action).toBe("delete");
    expect(removed.decision.reasons).toContain("chat_background");
    expect(removed.decision.ruleIds).toContain("chat_background");
    expect(removed.decision.evidence).toEqual([
      { kind: "feature", summary: "background:wallpaper" },
    ]);
    const pattern = await screenTelegramEvent(
      await posted({ updateId: 7802, chatId: -100802, kind: "pattern" }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(pattern.decision.action).toBe("delete");
    expect(pattern.decision.evidence).toEqual([
      { kind: "feature", summary: "background:pattern" },
    ]);
    const fill = await screenTelegramEvent(
      await posted({ updateId: 7803, chatId: -100803, kind: "fill" }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(fill.decision.action).toBe("delete");
    expect(fill.decision.evidence).toEqual([
      { kind: "feature", summary: "background:fill" },
    ]);
    const theme = await screenTelegramEvent(
      await posted({ updateId: 7804, chatId: -100804, kind: "theme" }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(theme.decision.action).toBe("delete");
    expect(theme.decision.evidence).toEqual([
      { kind: "feature", summary: "background:theme" },
    ]);
    const empty = await screenTelegramEvent(
      await posted({ updateId: 7805, chatId: -100805, empty: true }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(empty.decision.action).toBe("allow");
    const paidModerator = createMemoryModerator();
    const skipped = await screenTelegramEvent(
      await posted({
        updateId: 7806,
        chatId: -100806,
        kind: "wallpaper",
        paid: true,
      }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: paidModerator,
      },
    );
    expect(skipped.decision.action).toBe("delete");
    expect(skipped.actionResults).toContainEqual({
      actionId: "delete",
      status: "skipped",
      detail: "paid_post",
    });
    expect(paidModerator.deleted).toEqual([]);
    const dumped = JSON.stringify({
      removed: removed.decision,
      pattern: pattern.decision,
      fill: fill.decision,
      theme: theme.decision,
      empty: empty.decision,
      skipped: skipped.decision,
    });
    expect(dumped).not.toContain(filename);
    expect(dumped).not.toContain(fileId);
    expect(dumped).not.toContain(themeName);
    expect(dumped).not.toContain("90179");
  });

  it("keeps a gift until that chat asks", async () => {
    const title = "礼物广告标题";
    const username = "giftposter449";
    const fileId = "AgADgift449";
    const giftId = "giftid449";
    const slug = "PlushSlug449";
    async function posted(input: {
      updateId: number;
      chatId: number;
      kind?: "card" | "unique" | "upgrade";
      empty?: boolean;
      paid?: boolean;
    }) {
      const gift =
        input.kind === "card" || input.kind === "upgrade"
          ? {
              gift: {
                id: giftId,
                star_count: 90180,
                sticker: { file_id: fileId, file_unique_id: "uniqgift449" },
                publisher_chat: { username, title },
              },
            }
          : input.kind === "unique"
            ? {
                gift: {
                  name: slug,
                  number: 90181,
                  base_name: "收藏广告名字",
                },
                origin: "upgrade",
                owned_gift_id: "owned449",
              }
            : undefined;
      const normalized = await normalizeUpdate({
        update: {
          update_id: input.updateId,
          message: {
            message_id: input.updateId,
            date: 1761955200,
            chat: { id: input.chatId, type: "supergroup" },
            from: { id: 96 },
            ...(input.paid ? { is_paid_post: true } : {}),
            ...(input.kind === "card" ? { gift } : {}),
            ...(input.kind === "unique" ? { unique_gift: gift } : {}),
            ...(input.kind === "upgrade" ? { gift_upgrade_sent: gift } : {}),
            ...(input.empty ? { gift: {} } : {}),
          },
        },
        tenantId: "local",
        adminUserIds: [],
        nowIso: "2026-11-01T00:00:00.000Z",
      });
      expect(normalized.status).toBe("event");
      if (normalized.status !== "event") {
        throw new Error("expected event");
      }
      return normalized.event;
    }
    const idle = await posted({
      updateId: 8100,
      chatId: -100810,
      kind: "card",
    });
    expect(idle.message?.gift).toBe("card");
    expect(idle.message?.text).toBe("");
    expect(JSON.stringify(idle)).not.toContain(title);
    expect(JSON.stringify(idle)).not.toContain(fileId);
    expect(JSON.stringify(idle)).not.toContain("90180");
    const allowed = await screenTelegramEvent(idle, {
      rateWindow: createMemoryRateWindow(),
    });
    expect(allowed.decision.action).toBe("allow");
    const source: RuleSource = {
      async loadChat() {
        return {
          version: 1,
          aggregate: "max",
          rules: [
            {
              id: "gift_card",
              enabled: true,
              when: { eventKind: "message" },
              detectorIds: ["gift_card"],
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
    const removed = await screenTelegramEvent(
      await posted({ updateId: 8101, chatId: -100811, kind: "card" }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: createMemoryModerator(),
      },
    );
    expect(removed.decision.action).toBe("delete");
    expect(removed.decision.reasons).toContain("gift_card");
    expect(removed.decision.ruleIds).toContain("gift_card");
    expect(removed.decision.evidence).toEqual([
      { kind: "feature", summary: "gift:card" },
    ]);
    const unique = await screenTelegramEvent(
      await posted({ updateId: 8102, chatId: -100812, kind: "unique" }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(unique.decision.action).toBe("delete");
    expect(unique.decision.evidence).toEqual([
      { kind: "feature", summary: "gift:unique" },
    ]);
    const upgrade = await screenTelegramEvent(
      await posted({ updateId: 8103, chatId: -100813, kind: "upgrade" }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(upgrade.decision.action).toBe("delete");
    expect(upgrade.decision.evidence).toEqual([
      { kind: "feature", summary: "gift:upgrade" },
    ]);
    const empty = await screenTelegramEvent(
      await posted({ updateId: 8104, chatId: -100814, empty: true }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(empty.decision.action).toBe("allow");
    const paidModerator = createMemoryModerator();
    const skipped = await screenTelegramEvent(
      await posted({
        updateId: 8105,
        chatId: -100815,
        kind: "card",
        paid: true,
      }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: paidModerator,
      },
    );
    expect(skipped.decision.action).toBe("delete");
    expect(skipped.actionResults).toContainEqual({
      actionId: "delete",
      status: "skipped",
      detail: "paid_post",
    });
    expect(paidModerator.deleted).toEqual([]);
    const dumped = JSON.stringify({
      removed: removed.decision,
      unique: unique.decision,
      upgrade: upgrade.decision,
      empty: empty.decision,
      skipped: skipped.decision,
    });
    expect(dumped).not.toContain(title);
    expect(dumped).not.toContain(username);
    expect(dumped).not.toContain(fileId);
    expect(dumped).not.toContain(giftId);
    expect(dumped).not.toContain(slug);
    expect(dumped).not.toContain("收藏广告名字");
    expect(dumped).not.toContain("90180");
    expect(dumped).not.toContain("90181");
    expect(dumped).not.toContain("owned449");
  });

  it("keeps a rich email until that chat asks", async () => {
    const address = "902120011@mail.test";
    const actor = "留邮箱的人";
    async function posted(input: {
      updateId: number;
      chatId: number;
      email?: boolean;
      paid?: boolean;
    }) {
      const normalized = await normalizeUpdate({
        update: {
          update_id: input.updateId,
          message: {
            message_id: input.updateId,
            date: 1761955200,
            chat: { id: input.chatId, type: "supergroup" },
            from: { id: 110, first_name: actor },
            ...(input.paid ? { is_paid_post: true } : {}),
            ...(input.email
              ? {
                  rich_message: {
                    blocks: [
                      {
                        type: "paragraph",
                        text: {
                          type: "email_address",
                          text: "联系邮箱",
                          email_address: address,
                        },
                      },
                    ],
                  },
                }
              : { text: "今天站会" }),
          },
        },
        tenantId: "local",
        adminUserIds: [],
        nowIso: "2026-11-01T00:00:00.000Z",
      });
      expect(normalized.status).toBe("event");
      if (normalized.status !== "event") {
        throw new Error("expected event");
      }
      return normalized.event;
    }
    function rule(id: "rich_email" | "rich_phone"): RuleSource {
      return {
        async loadChat() {
          return {
            version: 1,
            aggregate: "max",
            rules: [
              {
                id,
                enabled: true,
                when: { eventKind: "message" },
                detectorIds: [id],
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
    }
    const idle = await posted({
      updateId: 10530,
      chatId: -1001130,
      email: true,
    });
    expect(idle.message?.asRichEmail).toBe(true);
    expect(idle.message?.text).toBe("联系邮箱");
    const idleDump = JSON.stringify(idle);
    expect(idleDump).not.toContain(address);
    expect(idleDump).not.toContain(actor);
    const allowed = await screenTelegramEvent(idle, {
      rateWindow: createMemoryRateWindow(),
    });
    expect(allowed.decision.action).toBe("allow");
    const removed = await screenTelegramEvent(
      await posted({ updateId: 10531, chatId: -1001131, email: true }),
      {
        source: rule("rich_email"),
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: createMemoryModerator(),
      },
    );
    expect(removed.decision.action).toBe("delete");
    expect(removed.decision.reasons).toContain("rich_email");
    expect(removed.decision.ruleIds).toContain("rich_email");
    expect(removed.decision.evidence).toEqual([
      { kind: "feature", summary: "rich:email" },
    ]);
    const keptByPhone = await screenTelegramEvent(
      await posted({ updateId: 10532, chatId: -1001132, email: true }),
      {
        source: rule("rich_phone"),
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(keptByPhone.decision.action).toBe("allow");
    const plain = await screenTelegramEvent(
      await posted({ updateId: 10533, chatId: -1001133 }),
      {
        source: rule("rich_email"),
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(plain.decision.action).toBe("allow");
    const paidModerator = createMemoryModerator();
    const skipped = await screenTelegramEvent(
      await posted({
        updateId: 10534,
        chatId: -1001134,
        email: true,
        paid: true,
      }),
      {
        source: rule("rich_email"),
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: paidModerator,
      },
    );
    expect(skipped.decision.action).toBe("delete");
    expect(skipped.actionResults).toContainEqual({
      actionId: "delete",
      status: "skipped",
      detail: "paid_post",
    });
    expect(paidModerator.deleted).toEqual([]);
    const dumped = JSON.stringify({
      removed: removed.decision,
      keptByPhone: keptByPhone.decision,
      plain: plain.decision,
      skipped: skipped.decision,
    });
    expect(dumped).not.toContain(address);
    expect(dumped).not.toContain("902120011");
    expect(dumped).not.toContain("联系邮箱");
    expect(dumped).not.toContain(actor);
  });

  it("keeps a rich phone or card until that chat asks", async () => {
    const phoneNumber = "+9021190011";
    const cardNumber = "9021190099990000";
    const actor = "留号码的人";
    async function posted(input: {
      updateId: number;
      chatId: number;
      kind?: "phone" | "card";
      paid?: boolean;
    }) {
      const secret =
        input.kind === "card"
          ? {
              type: "bank_card_number",
              text: "付款卡",
              bank_card_number: cardNumber,
            }
          : {
              type: "phone_number",
              text: "联系方式",
              phone_number: phoneNumber,
            };
      const normalized = await normalizeUpdate({
        update: {
          update_id: input.updateId,
          message: {
            message_id: input.updateId,
            date: 1761955200,
            chat: { id: input.chatId, type: "supergroup" },
            from: { id: 109, first_name: actor },
            ...(input.paid ? { is_paid_post: true } : {}),
            ...(input.kind
              ? {
                  rich_message: {
                    blocks: [{ type: "paragraph", text: secret }],
                  },
                }
              : { text: "今天站会" }),
          },
        },
        tenantId: "local",
        adminUserIds: [],
        nowIso: "2026-11-01T00:00:00.000Z",
      });
      expect(normalized.status).toBe("event");
      if (normalized.status !== "event") {
        throw new Error("expected event");
      }
      return normalized.event;
    }
    function rule(id: "rich_phone" | "rich_card"): RuleSource {
      return {
        async loadChat() {
          return {
            version: 1,
            aggregate: "max",
            rules: [
              {
                id,
                enabled: true,
                when: { eventKind: "message" },
                detectorIds: [id],
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
    }
    const idle = await posted({
      updateId: 10520,
      chatId: -1001120,
      kind: "phone",
    });
    expect(idle.message?.asRichPhone).toBe(true);
    expect(idle.message?.text).toBe("联系方式");
    const idleDump = JSON.stringify(idle);
    expect(idleDump).not.toContain(phoneNumber);
    expect(idleDump).not.toContain(actor);
    const allowed = await screenTelegramEvent(idle, {
      rateWindow: createMemoryRateWindow(),
    });
    expect(allowed.decision.action).toBe("allow");
    const removed = await screenTelegramEvent(
      await posted({ updateId: 10521, chatId: -1001121, kind: "phone" }),
      {
        source: rule("rich_phone"),
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: createMemoryModerator(),
      },
    );
    expect(removed.decision.action).toBe("delete");
    expect(removed.decision.reasons).toContain("rich_phone");
    expect(removed.decision.ruleIds).toContain("rich_phone");
    expect(removed.decision.evidence).toEqual([
      { kind: "feature", summary: "rich:phone" },
    ]);
    const removedCard = await screenTelegramEvent(
      await posted({ updateId: 10522, chatId: -1001122, kind: "card" }),
      {
        source: rule("rich_card"),
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: createMemoryModerator(),
      },
    );
    expect(removedCard.decision.action).toBe("delete");
    expect(removedCard.decision.reasons).toContain("rich_card");
    expect(removedCard.decision.evidence).toEqual([
      { kind: "feature", summary: "rich:card" },
    ]);
    const keptByCard = await screenTelegramEvent(
      await posted({ updateId: 10523, chatId: -1001123, kind: "phone" }),
      {
        source: rule("rich_card"),
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(keptByCard.decision.action).toBe("allow");
    const keptByPhone = await screenTelegramEvent(
      await posted({ updateId: 10524, chatId: -1001124, kind: "card" }),
      {
        source: rule("rich_phone"),
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(keptByPhone.decision.action).toBe("allow");
    const plain = await screenTelegramEvent(
      await posted({ updateId: 10525, chatId: -1001125 }),
      {
        source: rule("rich_phone"),
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(plain.decision.action).toBe("allow");
    const paidModerator = createMemoryModerator();
    const skipped = await screenTelegramEvent(
      await posted({
        updateId: 10526,
        chatId: -1001126,
        kind: "phone",
        paid: true,
      }),
      {
        source: rule("rich_phone"),
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: paidModerator,
      },
    );
    expect(skipped.decision.action).toBe("delete");
    expect(skipped.actionResults).toContainEqual({
      actionId: "delete",
      status: "skipped",
      detail: "paid_post",
    });
    expect(paidModerator.deleted).toEqual([]);
    const dumped = JSON.stringify({
      removed: removed.decision,
      removedCard: removedCard.decision,
      keptByCard: keptByCard.decision,
      keptByPhone: keptByPhone.decision,
      plain: plain.decision,
      skipped: skipped.decision,
    });
    expect(dumped).not.toContain(phoneNumber);
    expect(dumped).not.toContain(cardNumber);
    expect(dumped).not.toContain("联系方式");
    expect(dumped).not.toContain("付款卡");
    expect(dumped).not.toContain(actor);
  });

  it("keeps a rich anchor until that chat asks", async () => {
    const name = "anchor90227";
    const actor = "发锚点的人";
    async function posted(input: {
      updateId: number;
      chatId: number;
      kind?: "anchor" | "cashtag";
      paid?: boolean;
    }) {
      const rich =
        input.kind === "cashtag"
          ? {
              type: "cashtag",
              text: "行情留下",
              cashtag: "$cash90226",
            }
          : ["锚点广告", { type: "anchor", name }];
      const normalized = await normalizeUpdate({
        update: {
          update_id: input.updateId,
          message: {
            message_id: input.updateId,
            date: 1761955200,
            chat: { id: input.chatId, type: "supergroup" },
            from: { id: 119, first_name: actor },
            ...(input.paid ? { is_paid_post: true } : {}),
            ...(input.kind
              ? {
                  rich_message: {
                    blocks: [{ type: "paragraph", text: rich }],
                  },
                }
              : { text: "今天站会" }),
          },
        },
        tenantId: "local",
        adminUserIds: [],
        nowIso: "2026-11-01T00:00:00.000Z",
      });
      expect(normalized.status).toBe("event");
      if (normalized.status !== "event") {
        throw new Error("expected event");
      }
      return normalized.event;
    }
    function rule(id: "rich_anchor" | "rich_cashtag"): RuleSource {
      return {
        async loadChat() {
          return {
            version: 1,
            aggregate: "max",
            rules: [
              {
                id,
                enabled: true,
                when: { eventKind: "message" },
                detectorIds: [id],
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
    }
    const idle = await posted({
      updateId: 10610,
      chatId: -1001210,
      kind: "anchor",
    });
    expect(idle.message?.asRichAnchor).toBe(true);
    expect(idle.message?.asRichCashtag).toBeUndefined();
    expect(idle.message?.text).toBe("锚点广告");
    const idleDump = JSON.stringify(idle);
    expect(idleDump).not.toContain(name);
    expect(idleDump).not.toContain(actor);
    const allowed = await screenTelegramEvent(idle, {
      rateWindow: createMemoryRateWindow(),
    });
    expect(allowed.decision.action).toBe("allow");
    const removed = await screenTelegramEvent(
      await posted({ updateId: 10611, chatId: -1001211, kind: "anchor" }),
      {
        source: rule("rich_anchor"),
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: createMemoryModerator(),
      },
    );
    expect(removed.decision.action).toBe("delete");
    expect(removed.decision.reasons).toContain("rich_anchor");
    expect(removed.decision.ruleIds).toContain("rich_anchor");
    expect(removed.decision.evidence).toEqual([
      { kind: "feature", summary: "rich:anchor" },
    ]);
    const keptByCash = await screenTelegramEvent(
      await posted({ updateId: 10612, chatId: -1001212, kind: "anchor" }),
      {
        source: rule("rich_cashtag"),
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(keptByCash.decision.action).toBe("allow");
    const keptCash = await screenTelegramEvent(
      await posted({ updateId: 10613, chatId: -1001213, kind: "cashtag" }),
      {
        source: rule("rich_anchor"),
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(keptCash.decision.action).toBe("allow");
    const plain = await screenTelegramEvent(
      await posted({ updateId: 10614, chatId: -1001214 }),
      {
        source: rule("rich_anchor"),
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(plain.decision.action).toBe("allow");
    const paidModerator = createMemoryModerator();
    const skipped = await screenTelegramEvent(
      await posted({
        updateId: 10615,
        chatId: -1001215,
        kind: "anchor",
        paid: true,
      }),
      {
        source: rule("rich_anchor"),
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: paidModerator,
      },
    );
    expect(skipped.decision.action).toBe("delete");
    expect(skipped.actionResults).toContainEqual({
      actionId: "delete",
      status: "skipped",
      detail: "paid_post",
    });
    expect(paidModerator.deleted).toEqual([]);
    const dumped = JSON.stringify({
      removed: removed.decision,
      keptByCash: keptByCash.decision,
      keptCash: keptCash.decision,
      plain: plain.decision,
      skipped: skipped.decision,
    });
    expect(dumped).not.toContain(name);
    expect(dumped).not.toContain("90227");
    expect(dumped).not.toContain("锚点广告");
    expect(dumped).not.toContain(actor);
    expect(dumped).not.toContain("$cash90226");
  });

  it("keeps a rich cashtag until that chat asks", async () => {
    const cashtag = "$cash90226";
    const actor = "发行情的人";
    async function posted(input: {
      updateId: number;
      chatId: number;
      kind?: "cashtag" | "hashtag";
      paid?: boolean;
    }) {
      const rich =
        input.kind === "hashtag"
          ? {
              type: "hashtag",
              text: "话题留下",
              hashtag: "#tag90224",
            }
          : {
              type: "cashtag",
              text: "行情广告",
              cashtag,
            };
      const normalized = await normalizeUpdate({
        update: {
          update_id: input.updateId,
          message: {
            message_id: input.updateId,
            date: 1761955200,
            chat: { id: input.chatId, type: "supergroup" },
            from: { id: 118, first_name: actor },
            ...(input.paid ? { is_paid_post: true } : {}),
            ...(input.kind
              ? {
                  rich_message: {
                    blocks: [{ type: "paragraph", text: rich }],
                  },
                }
              : { text: "今天站会" }),
          },
        },
        tenantId: "local",
        adminUserIds: [],
        nowIso: "2026-11-01T00:00:00.000Z",
      });
      expect(normalized.status).toBe("event");
      if (normalized.status !== "event") {
        throw new Error("expected event");
      }
      return normalized.event;
    }
    function rule(id: "rich_cashtag" | "rich_hashtag"): RuleSource {
      return {
        async loadChat() {
          return {
            version: 1,
            aggregate: "max",
            rules: [
              {
                id,
                enabled: true,
                when: { eventKind: "message" },
                detectorIds: [id],
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
    }
    const idle = await posted({
      updateId: 10600,
      chatId: -1001200,
      kind: "cashtag",
    });
    expect(idle.message?.asRichCashtag).toBe(true);
    expect(idle.message?.asRichHashtag).toBeUndefined();
    expect(idle.message?.text).toBe("行情广告");
    const idleDump = JSON.stringify(idle);
    expect(idleDump).not.toContain(cashtag);
    expect(idleDump).not.toContain(actor);
    const allowed = await screenTelegramEvent(idle, {
      rateWindow: createMemoryRateWindow(),
    });
    expect(allowed.decision.action).toBe("allow");
    const removed = await screenTelegramEvent(
      await posted({ updateId: 10601, chatId: -1001201, kind: "cashtag" }),
      {
        source: rule("rich_cashtag"),
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: createMemoryModerator(),
      },
    );
    expect(removed.decision.action).toBe("delete");
    expect(removed.decision.reasons).toContain("rich_cashtag");
    expect(removed.decision.ruleIds).toContain("rich_cashtag");
    expect(removed.decision.evidence).toEqual([
      { kind: "feature", summary: "rich:cashtag" },
    ]);
    const keptByTag = await screenTelegramEvent(
      await posted({ updateId: 10602, chatId: -1001202, kind: "cashtag" }),
      {
        source: rule("rich_hashtag"),
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(keptByTag.decision.action).toBe("allow");
    const keptTag = await screenTelegramEvent(
      await posted({ updateId: 10603, chatId: -1001203, kind: "hashtag" }),
      {
        source: rule("rich_cashtag"),
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(keptTag.decision.action).toBe("allow");
    const plain = await screenTelegramEvent(
      await posted({ updateId: 10604, chatId: -1001204 }),
      {
        source: rule("rich_cashtag"),
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(plain.decision.action).toBe("allow");
    const paidModerator = createMemoryModerator();
    const skipped = await screenTelegramEvent(
      await posted({
        updateId: 10605,
        chatId: -1001205,
        kind: "cashtag",
        paid: true,
      }),
      {
        source: rule("rich_cashtag"),
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: paidModerator,
      },
    );
    expect(skipped.decision.action).toBe("delete");
    expect(skipped.actionResults).toContainEqual({
      actionId: "delete",
      status: "skipped",
      detail: "paid_post",
    });
    expect(paidModerator.deleted).toEqual([]);
    const dumped = JSON.stringify({
      removed: removed.decision,
      keptByTag: keptByTag.decision,
      keptTag: keptTag.decision,
      plain: plain.decision,
      skipped: skipped.decision,
    });
    expect(dumped).not.toContain(cashtag);
    expect(dumped).not.toContain("90226");
    expect(dumped).not.toContain("行情广告");
    expect(dumped).not.toContain(actor);
    expect(dumped).not.toContain("#tag90224");
  });

  it("keeps a rich hashtag until that chat asks", async () => {
    const hashtag = "#tag90224";
    const actor = "发话题的人";
    async function posted(input: {
      updateId: number;
      chatId: number;
      kind?: "hashtag" | "command";
      paid?: boolean;
    }) {
      const rich =
        input.kind === "command"
          ? {
              type: "bot_command",
              text: "命令留下",
              bot_command: "/go90223",
            }
          : {
              type: "hashtag",
              text: "话题广告",
              hashtag,
            };
      const normalized = await normalizeUpdate({
        update: {
          update_id: input.updateId,
          message: {
            message_id: input.updateId,
            date: 1761955200,
            chat: { id: input.chatId, type: "supergroup" },
            from: { id: 117, first_name: actor },
            ...(input.paid ? { is_paid_post: true } : {}),
            ...(input.kind
              ? {
                  rich_message: {
                    blocks: [{ type: "paragraph", text: rich }],
                  },
                }
              : { text: "今天站会" }),
          },
        },
        tenantId: "local",
        adminUserIds: [],
        nowIso: "2026-11-01T00:00:00.000Z",
      });
      expect(normalized.status).toBe("event");
      if (normalized.status !== "event") {
        throw new Error("expected event");
      }
      return normalized.event;
    }
    function rule(id: "rich_hashtag" | "rich_command"): RuleSource {
      return {
        async loadChat() {
          return {
            version: 1,
            aggregate: "max",
            rules: [
              {
                id,
                enabled: true,
                when: { eventKind: "message" },
                detectorIds: [id],
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
    }
    const idle = await posted({
      updateId: 10590,
      chatId: -1001190,
      kind: "hashtag",
    });
    expect(idle.message?.asRichHashtag).toBe(true);
    expect(idle.message?.asRichCommand).toBeUndefined();
    expect(idle.message?.text).toBe("话题广告");
    const idleDump = JSON.stringify(idle);
    expect(idleDump).not.toContain(hashtag);
    expect(idleDump).not.toContain(actor);
    const allowed = await screenTelegramEvent(idle, {
      rateWindow: createMemoryRateWindow(),
    });
    expect(allowed.decision.action).toBe("allow");
    const removed = await screenTelegramEvent(
      await posted({ updateId: 10591, chatId: -1001191, kind: "hashtag" }),
      {
        source: rule("rich_hashtag"),
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: createMemoryModerator(),
      },
    );
    expect(removed.decision.action).toBe("delete");
    expect(removed.decision.reasons).toContain("rich_hashtag");
    expect(removed.decision.ruleIds).toContain("rich_hashtag");
    expect(removed.decision.evidence).toEqual([
      { kind: "feature", summary: "rich:hashtag" },
    ]);
    const keptByCommand = await screenTelegramEvent(
      await posted({ updateId: 10592, chatId: -1001192, kind: "hashtag" }),
      {
        source: rule("rich_command"),
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(keptByCommand.decision.action).toBe("allow");
    const keptCommand = await screenTelegramEvent(
      await posted({ updateId: 10593, chatId: -1001193, kind: "command" }),
      {
        source: rule("rich_hashtag"),
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(keptCommand.decision.action).toBe("allow");
    const plain = await screenTelegramEvent(
      await posted({ updateId: 10594, chatId: -1001194 }),
      {
        source: rule("rich_hashtag"),
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(plain.decision.action).toBe("allow");
    const paidModerator = createMemoryModerator();
    const skipped = await screenTelegramEvent(
      await posted({
        updateId: 10595,
        chatId: -1001195,
        kind: "hashtag",
        paid: true,
      }),
      {
        source: rule("rich_hashtag"),
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: paidModerator,
      },
    );
    expect(skipped.decision.action).toBe("delete");
    expect(skipped.actionResults).toContainEqual({
      actionId: "delete",
      status: "skipped",
      detail: "paid_post",
    });
    expect(paidModerator.deleted).toEqual([]);
    const dumped = JSON.stringify({
      removed: removed.decision,
      keptByCommand: keptByCommand.decision,
      keptCommand: keptCommand.decision,
      plain: plain.decision,
      skipped: skipped.decision,
    });
    expect(dumped).not.toContain(hashtag);
    expect(dumped).not.toContain("90224");
    expect(dumped).not.toContain("话题广告");
    expect(dumped).not.toContain(actor);
    expect(dumped).not.toContain("/go90223");
  });

  it("keeps a rich command until that chat asks", async () => {
    const command = "/go90223";
    const actor = "发命令的人";
    async function posted(input: {
      updateId: number;
      chatId: number;
      kind?: "command" | "named";
      paid?: boolean;
    }) {
      const rich =
        input.kind === "named"
          ? {
              type: "text_mention",
              text: "标识留下",
              user: { id: 88022, is_bot: false, first_name: "某人" },
            }
          : {
              type: "bot_command",
              text: "点命令广告",
              bot_command: command,
            };
      const normalized = await normalizeUpdate({
        update: {
          update_id: input.updateId,
          message: {
            message_id: input.updateId,
            date: 1761955200,
            chat: { id: input.chatId, type: "supergroup" },
            from: { id: 116, first_name: actor },
            ...(input.paid ? { is_paid_post: true } : {}),
            ...(input.kind
              ? {
                  rich_message: {
                    blocks: [{ type: "paragraph", text: rich }],
                  },
                }
              : { text: "今天站会" }),
          },
        },
        tenantId: "local",
        adminUserIds: [],
        nowIso: "2026-11-01T00:00:00.000Z",
      });
      expect(normalized.status).toBe("event");
      if (normalized.status !== "event") {
        throw new Error("expected event");
      }
      return normalized.event;
    }
    function rule(id: "rich_command" | "rich_text_mention"): RuleSource {
      return {
        async loadChat() {
          return {
            version: 1,
            aggregate: "max",
            rules: [
              {
                id,
                enabled: true,
                when: { eventKind: "message" },
                detectorIds: [id],
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
    }
    const idle = await posted({
      updateId: 10580,
      chatId: -1001180,
      kind: "command",
    });
    expect(idle.message?.asRichCommand).toBe(true);
    expect(idle.message?.asRichTextMention).toBeUndefined();
    expect(idle.message?.text).toBe("点命令广告");
    const idleDump = JSON.stringify(idle);
    expect(idleDump).not.toContain(command);
    expect(idleDump).not.toContain(actor);
    const allowed = await screenTelegramEvent(idle, {
      rateWindow: createMemoryRateWindow(),
    });
    expect(allowed.decision.action).toBe("allow");
    const removed = await screenTelegramEvent(
      await posted({ updateId: 10581, chatId: -1001181, kind: "command" }),
      {
        source: rule("rich_command"),
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: createMemoryModerator(),
      },
    );
    expect(removed.decision.action).toBe("delete");
    expect(removed.decision.reasons).toContain("rich_command");
    expect(removed.decision.ruleIds).toContain("rich_command");
    expect(removed.decision.evidence).toEqual([
      { kind: "feature", summary: "rich:command" },
    ]);
    const keptByName = await screenTelegramEvent(
      await posted({ updateId: 10582, chatId: -1001182, kind: "command" }),
      {
        source: rule("rich_text_mention"),
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(keptByName.decision.action).toBe("allow");
    const keptName = await screenTelegramEvent(
      await posted({ updateId: 10583, chatId: -1001183, kind: "named" }),
      {
        source: rule("rich_command"),
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(keptName.decision.action).toBe("allow");
    const plain = await screenTelegramEvent(
      await posted({ updateId: 10584, chatId: -1001184 }),
      {
        source: rule("rich_command"),
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(plain.decision.action).toBe("allow");
    const paidModerator = createMemoryModerator();
    const skipped = await screenTelegramEvent(
      await posted({
        updateId: 10585,
        chatId: -1001185,
        kind: "command",
        paid: true,
      }),
      {
        source: rule("rich_command"),
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: paidModerator,
      },
    );
    expect(skipped.decision.action).toBe("delete");
    expect(skipped.actionResults).toContainEqual({
      actionId: "delete",
      status: "skipped",
      detail: "paid_post",
    });
    expect(paidModerator.deleted).toEqual([]);
    const dumped = JSON.stringify({
      removed: removed.decision,
      keptByName: keptByName.decision,
      keptName: keptName.decision,
      plain: plain.decision,
      skipped: skipped.decision,
    });
    expect(dumped).not.toContain(command);
    expect(dumped).not.toContain("90223");
    expect(dumped).not.toContain("点命令广告");
    expect(dumped).not.toContain(actor);
  });

  it("keeps a rich text mention until that chat asks", async () => {
    const userId = 902220011;
    const hiddenName = "隐藏名90222";
    const actor = "点标识的人";
    async function posted(input: {
      updateId: number;
      chatId: number;
      named?: boolean;
      paid?: boolean;
    }) {
      const normalized = await normalizeUpdate({
        update: {
          update_id: input.updateId,
          message: {
            message_id: input.updateId,
            date: 1761955200,
            chat: { id: input.chatId, type: "supergroup" },
            from: { id: 114, first_name: actor },
            ...(input.paid ? { is_paid_post: true } : {}),
            ...(input.named
              ? {
                  rich_message: {
                    blocks: [
                      {
                        type: "paragraph",
                        text: {
                          type: "text_mention",
                          text: "点人广告",
                          user: {
                            id: userId,
                            is_bot: false,
                            first_name: hiddenName,
                          },
                        },
                      },
                    ],
                  },
                }
              : { text: "今天站会" }),
          },
        },
        tenantId: "local",
        adminUserIds: [],
        nowIso: "2026-11-01T00:00:00.000Z",
      });
      expect(normalized.status).toBe("event");
      if (normalized.status !== "event") {
        throw new Error("expected event");
      }
      return normalized.event;
    }
    function rule(id: "rich_text_mention" | "rich_mention"): RuleSource {
      return {
        async loadChat() {
          return {
            version: 1,
            aggregate: "max",
            rules: [
              {
                id,
                enabled: true,
                when: { eventKind: "message" },
                detectorIds: [id],
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
    }
    const idle = await posted({
      updateId: 10570,
      chatId: -1001170,
      named: true,
    });
    expect(idle.message?.asRichTextMention).toBe(true);
    expect(idle.message?.asRichMention).toBeUndefined();
    expect(idle.message?.text).toBe("点人广告");
    const idleDump = JSON.stringify(idle);
    expect(idleDump).not.toContain(String(userId));
    expect(idleDump).not.toContain(hiddenName);
    expect(idleDump).not.toContain(actor);
    const allowed = await screenTelegramEvent(idle, {
      rateWindow: createMemoryRateWindow(),
    });
    expect(allowed.decision.action).toBe("allow");
    const removed = await screenTelegramEvent(
      await posted({ updateId: 10571, chatId: -1001171, named: true }),
      {
        source: rule("rich_text_mention"),
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: createMemoryModerator(),
      },
    );
    expect(removed.decision.action).toBe("delete");
    expect(removed.decision.reasons).toContain("rich_text_mention");
    expect(removed.decision.ruleIds).toContain("rich_text_mention");
    expect(removed.decision.evidence).toEqual([
      { kind: "feature", summary: "rich:text_mention" },
    ]);
    const keptByMention = await screenTelegramEvent(
      await posted({ updateId: 10572, chatId: -1001172, named: true }),
      {
        source: rule("rich_mention"),
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(keptByMention.decision.action).toBe("allow");
    const plain = await screenTelegramEvent(
      await posted({ updateId: 10573, chatId: -1001173 }),
      {
        source: rule("rich_text_mention"),
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(plain.decision.action).toBe("allow");
    const paidModerator = createMemoryModerator();
    const skipped = await screenTelegramEvent(
      await posted({
        updateId: 10574,
        chatId: -1001174,
        named: true,
        paid: true,
      }),
      {
        source: rule("rich_text_mention"),
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: paidModerator,
      },
    );
    expect(skipped.decision.action).toBe("delete");
    expect(skipped.actionResults).toContainEqual({
      actionId: "delete",
      status: "skipped",
      detail: "paid_post",
    });
    expect(paidModerator.deleted).toEqual([]);
    const dumped = JSON.stringify({
      removed: removed.decision,
      keptByMention: keptByMention.decision,
      plain: plain.decision,
      skipped: skipped.decision,
    });
    expect(dumped).not.toContain(String(userId));
    expect(dumped).not.toContain(hiddenName);
    expect(dumped).not.toContain("点人广告");
    expect(dumped).not.toContain(actor);
  });

  it("keeps a rich mention until that chat asks", async () => {
    const username = "u90221hidden";
    const actor = "点用户名的人";
    async function posted(input: {
      updateId: number;
      chatId: number;
      mention?: boolean;
      paid?: boolean;
    }) {
      const normalized = await normalizeUpdate({
        update: {
          update_id: input.updateId,
          message: {
            message_id: input.updateId,
            date: 1761955200,
            chat: { id: input.chatId, type: "supergroup" },
            from: { id: 113, first_name: actor },
            ...(input.paid ? { is_paid_post: true } : {}),
            ...(input.mention
              ? {
                  rich_message: {
                    blocks: [
                      {
                        type: "paragraph",
                        text: {
                          type: "mention",
                          text: "点名广告",
                          username,
                        },
                      },
                    ],
                  },
                }
              : { text: "今天站会" }),
          },
        },
        tenantId: "local",
        adminUserIds: [],
        nowIso: "2026-11-01T00:00:00.000Z",
      });
      expect(normalized.status).toBe("event");
      if (normalized.status !== "event") {
        throw new Error("expected event");
      }
      return normalized.event;
    }
    function rule(id: "rich_mention" | "rich_email"): RuleSource {
      return {
        async loadChat() {
          return {
            version: 1,
            aggregate: "max",
            rules: [
              {
                id,
                enabled: true,
                when: { eventKind: "message" },
                detectorIds: [id],
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
    }
    const idle = await posted({
      updateId: 10560,
      chatId: -1001160,
      mention: true,
    });
    expect(idle.message?.asRichMention).toBe(true);
    expect(idle.message?.text).toBe("点名广告");
    const idleDump = JSON.stringify(idle);
    expect(idleDump).not.toContain(username);
    expect(idleDump).not.toContain(actor);
    const allowed = await screenTelegramEvent(idle, {
      rateWindow: createMemoryRateWindow(),
    });
    expect(allowed.decision.action).toBe("allow");
    const removed = await screenTelegramEvent(
      await posted({ updateId: 10561, chatId: -1001161, mention: true }),
      {
        source: rule("rich_mention"),
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: createMemoryModerator(),
      },
    );
    expect(removed.decision.action).toBe("delete");
    expect(removed.decision.reasons).toContain("rich_mention");
    expect(removed.decision.ruleIds).toContain("rich_mention");
    expect(removed.decision.evidence).toEqual([
      { kind: "feature", summary: "rich:mention" },
    ]);
    const keptByEmail = await screenTelegramEvent(
      await posted({ updateId: 10562, chatId: -1001162, mention: true }),
      {
        source: rule("rich_email"),
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(keptByEmail.decision.action).toBe("allow");
    const plain = await screenTelegramEvent(
      await posted({ updateId: 10563, chatId: -1001163 }),
      {
        source: rule("rich_mention"),
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(plain.decision.action).toBe("allow");
    const paidModerator = createMemoryModerator();
    const skipped = await screenTelegramEvent(
      await posted({
        updateId: 10564,
        chatId: -1001164,
        mention: true,
        paid: true,
      }),
      {
        source: rule("rich_mention"),
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: paidModerator,
      },
    );
    expect(skipped.decision.action).toBe("delete");
    expect(skipped.actionResults).toContainEqual({
      actionId: "delete",
      status: "skipped",
      detail: "paid_post",
    });
    expect(paidModerator.deleted).toEqual([]);
    const dumped = JSON.stringify({
      removed: removed.decision,
      keptByEmail: keptByEmail.decision,
      plain: plain.decision,
      skipped: skipped.decision,
    });
    expect(dumped).not.toContain(username);
    expect(dumped).not.toContain("90221");
    expect(dumped).not.toContain("点名广告");
    expect(dumped).not.toContain(actor);
  });

  it("keeps a rich map until that chat asks", async () => {
    const caption = "地图说明广告";
    const actor = "发地图的人";
    const latitude = 23.90217;
    const longitude = 113.90218;
    async function posted(input: {
      updateId: number;
      chatId: number;
      kind?: "map" | "pin";
      paid?: boolean;
    }) {
      const normalized = await normalizeUpdate({
        update: {
          update_id: input.updateId,
          message: {
            message_id: input.updateId,
            date: 1761955200,
            chat: { id: input.chatId, type: "supergroup" },
            from: { id: 112, first_name: actor },
            ...(input.paid ? { is_paid_post: true } : {}),
            ...(input.kind === "pin"
              ? { location: { latitude, longitude } }
              : input.kind === "map"
                ? {
                    rich_message: {
                      blocks: [
                        {
                          type: "map",
                          location: { latitude, longitude },
                          caption: { text: caption },
                        },
                      ],
                    },
                  }
                : { text: "今天站会" }),
          },
        },
        tenantId: "local",
        adminUserIds: [],
        nowIso: "2026-11-01T00:00:00.000Z",
      });
      expect(normalized.status).toBe("event");
      if (normalized.status !== "event") {
        throw new Error("expected event");
      }
      return normalized.event;
    }
    function rule(id: "rich_map" | "bare_location"): RuleSource {
      return {
        async loadChat() {
          return {
            version: 1,
            aggregate: "max",
            rules: [
              {
                id,
                enabled: true,
                when: { eventKind: "message" },
                detectorIds: [id],
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
    }
    const idle = await posted({
      updateId: 10550,
      chatId: -1001150,
      kind: "map",
    });
    expect(idle.message?.asRichMap).toBe(true);
    expect(idle.message?.asLocation).toBeUndefined();
    expect(idle.message?.text).toBe(caption);
    const idleDump = JSON.stringify(idle);
    expect(idleDump).not.toContain(String(latitude));
    expect(idleDump).not.toContain(actor);
    const allowed = await screenTelegramEvent(idle, {
      rateWindow: createMemoryRateWindow(),
    });
    expect(allowed.decision.action).toBe("allow");
    const removed = await screenTelegramEvent(
      await posted({ updateId: 10551, chatId: -1001151, kind: "map" }),
      {
        source: rule("rich_map"),
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: createMemoryModerator(),
      },
    );
    expect(removed.decision.action).toBe("delete");
    expect(removed.decision.reasons).toContain("rich_map");
    expect(removed.decision.ruleIds).toContain("rich_map");
    expect(removed.decision.evidence).toEqual([
      { kind: "feature", summary: "map:rich" },
    ]);
    const keptByPin = await screenTelegramEvent(
      await posted({ updateId: 10552, chatId: -1001152, kind: "map" }),
      {
        source: rule("bare_location"),
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(keptByPin.decision.action).toBe("allow");
    const keptMap = await screenTelegramEvent(
      await posted({ updateId: 10553, chatId: -1001153, kind: "pin" }),
      {
        source: rule("rich_map"),
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(keptMap.decision.action).toBe("allow");
    const plain = await screenTelegramEvent(
      await posted({ updateId: 10554, chatId: -1001154 }),
      {
        source: rule("rich_map"),
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(plain.decision.action).toBe("allow");
    const paidModerator = createMemoryModerator();
    const skipped = await screenTelegramEvent(
      await posted({
        updateId: 10555,
        chatId: -1001155,
        kind: "map",
        paid: true,
      }),
      {
        source: rule("rich_map"),
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: paidModerator,
      },
    );
    expect(skipped.decision.action).toBe("delete");
    expect(skipped.actionResults).toContainEqual({
      actionId: "delete",
      status: "skipped",
      detail: "paid_post",
    });
    expect(paidModerator.deleted).toEqual([]);
    const dumped = JSON.stringify({
      removed: removed.decision,
      keptByPin: keptByPin.decision,
      keptMap: keptMap.decision,
      plain: plain.decision,
      skipped: skipped.decision,
    });
    expect(dumped).not.toContain(String(latitude));
    expect(dumped).not.toContain(String(longitude));
    expect(dumped).not.toContain("90217");
    expect(dumped).not.toContain(caption);
    expect(dumped).not.toContain(actor);
  });

  it("keeps a rich block spoiler until that chat asks", async () => {
    const caption = "富文本剧透广告";
    const actor = "发块剧透的人";
    const fileId = "AgAC90213blockspoiler";
    async function posted(input: {
      updateId: number;
      chatId: number;
      spoiler?: boolean;
      paid?: boolean;
    }) {
      const normalized = await normalizeUpdate({
        update: {
          update_id: input.updateId,
          message: {
            message_id: input.updateId,
            date: 1761955200,
            chat: { id: input.chatId, type: "supergroup" },
            from: { id: 111, first_name: actor },
            ...(input.paid ? { is_paid_post: true } : {}),
            rich_message: {
              blocks: [
                {
                  type: "photo",
                  photo: [{ file_id: fileId, width: 1, height: 1 }],
                  ...(input.spoiler === undefined
                    ? {}
                    : { has_spoiler: input.spoiler }),
                  caption: { text: caption },
                },
              ],
            },
          },
        },
        tenantId: "local",
        adminUserIds: [],
        nowIso: "2026-11-01T00:00:00.000Z",
      });
      expect(normalized.status).toBe("event");
      if (normalized.status !== "event") {
        throw new Error("expected event");
      }
      return normalized.event;
    }
    const source: RuleSource = {
      async loadChat() {
        return {
          version: 1,
          aggregate: "max",
          rules: [
            {
              id: "media_spoiler",
              enabled: true,
              when: { eventKind: "message" },
              detectorIds: ["media_spoiler"],
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
    const idle = await posted({
      updateId: 10540,
      chatId: -1001140,
      spoiler: true,
    });
    expect(idle.message?.asSpoiler).toBe(true);
    expect(idle.message?.text).toBe(caption);
    const idleDump = JSON.stringify(idle);
    expect(idleDump).not.toContain(fileId);
    expect(idleDump).not.toContain(actor);
    const allowed = await screenTelegramEvent(idle, {
      rateWindow: createMemoryRateWindow(),
    });
    expect(allowed.decision.action).toBe("allow");
    const removed = await screenTelegramEvent(
      await posted({ updateId: 10541, chatId: -1001141, spoiler: true }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: createMemoryModerator(),
      },
    );
    expect(removed.decision.action).toBe("delete");
    expect(removed.decision.reasons).toContain("media_spoiler");
    expect(removed.decision.ruleIds).toContain("media_spoiler");
    expect(removed.decision.evidence).toEqual([
      { kind: "feature", summary: "media:spoiler" },
    ]);
    const stickerOnly: RuleSource = {
      async loadChat() {
        return {
          version: 1,
          aggregate: "max",
          rules: [
            {
              id: "media_sticker",
              enabled: true,
              when: { eventKind: "message" },
              detectorIds: ["media_sticker"],
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
    const keptBySticker = await screenTelegramEvent(
      await posted({ updateId: 10542, chatId: -1001142, spoiler: true }),
      {
        source: stickerOnly,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(keptBySticker.decision.action).toBe("allow");
    const open = await screenTelegramEvent(
      await posted({ updateId: 10543, chatId: -1001143, spoiler: false }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(open.decision.action).toBe("allow");
    const paidModerator = createMemoryModerator();
    const skipped = await screenTelegramEvent(
      await posted({
        updateId: 10544,
        chatId: -1001144,
        spoiler: true,
        paid: true,
      }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: paidModerator,
      },
    );
    expect(skipped.decision.action).toBe("delete");
    expect(skipped.actionResults).toContainEqual({
      actionId: "delete",
      status: "skipped",
      detail: "paid_post",
    });
    expect(paidModerator.deleted).toEqual([]);
    const dumped = JSON.stringify({
      removed: removed.decision,
      keptBySticker: keptBySticker.decision,
      open: open.decision,
      skipped: skipped.decision,
    });
    expect(dumped).not.toContain(fileId);
    expect(dumped).not.toContain("90213");
    expect(dumped).not.toContain(caption);
    expect(dumped).not.toContain(actor);
  });

  it("keeps spoiler media until that chat asks", async () => {
    const caption = "剧透说明广告";
    const actor = "发剧透的人";
    const fileId = "AgAC90209spoiler";
    async function posted(input: {
      updateId: number;
      chatId: number;
      spoiler?: boolean;
      flag?: boolean;
      paid?: boolean;
    }) {
      const normalized = await normalizeUpdate({
        update: {
          update_id: input.updateId,
          message: {
            message_id: input.updateId,
            date: 1761955200,
            chat: { id: input.chatId, type: "supergroup" },
            from: { id: 108, first_name: actor },
            caption,
            photo: [{ file_id: fileId, width: 1, height: 1 }],
            ...(input.paid ? { is_paid_post: true } : {}),
            ...(input.spoiler ? { has_media_spoiler: true } : {}),
            ...(input.flag ? { has_media_spoiler: false } : {}),
          },
        },
        tenantId: "local",
        adminUserIds: [],
        nowIso: "2026-11-01T00:00:00.000Z",
      });
      expect(normalized.status).toBe("event");
      if (normalized.status !== "event") {
        throw new Error("expected event");
      }
      return normalized.event;
    }
    const idle = await posted({
      updateId: 10510,
      chatId: -1001110,
      spoiler: true,
    });
    expect(idle.message?.asSpoiler).toBe(true);
    expect(idle.message?.media).toBe("photo");
    expect(idle.message?.text).toBe(caption);
    const idleDump = JSON.stringify(idle);
    expect(idleDump).not.toContain(actor);
    expect(idleDump).not.toContain(fileId);
    const allowed = await screenTelegramEvent(idle, {
      rateWindow: createMemoryRateWindow(),
    });
    expect(allowed.decision.action).toBe("allow");
    const source: RuleSource = {
      async loadChat() {
        return {
          version: 1,
          aggregate: "max",
          rules: [
            {
              id: "media_spoiler",
              enabled: true,
              when: { eventKind: "message" },
              detectorIds: ["media_spoiler"],
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
    const removed = await screenTelegramEvent(
      await posted({ updateId: 10511, chatId: -1001111, spoiler: true }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: createMemoryModerator(),
      },
    );
    expect(removed.decision.action).toBe("delete");
    expect(removed.decision.reasons).toContain("media_spoiler");
    expect(removed.decision.ruleIds).toContain("media_spoiler");
    expect(removed.decision.evidence).toEqual([
      { kind: "feature", summary: "media:spoiler" },
    ]);
    const stickerOnly: RuleSource = {
      async loadChat() {
        return {
          version: 1,
          aggregate: "max",
          rules: [
            {
              id: "media_sticker",
              enabled: true,
              when: { eventKind: "message" },
              detectorIds: ["media_sticker"],
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
    const keptBySticker = await screenTelegramEvent(
      await posted({ updateId: 10512, chatId: -1001112, spoiler: true }),
      {
        source: stickerOnly,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(keptBySticker.decision.action).toBe("allow");
    const flag = await screenTelegramEvent(
      await posted({ updateId: 10513, chatId: -1001113, flag: true }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(flag.decision.action).toBe("allow");
    const paidModerator = createMemoryModerator();
    const skipped = await screenTelegramEvent(
      await posted({
        updateId: 10514,
        chatId: -1001114,
        spoiler: true,
        paid: true,
      }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: paidModerator,
      },
    );
    expect(skipped.decision.action).toBe("delete");
    expect(skipped.actionResults).toContainEqual({
      actionId: "delete",
      status: "skipped",
      detail: "paid_post",
    });
    expect(paidModerator.deleted).toEqual([]);
    const dumped = JSON.stringify({
      removed: removed.decision,
      keptBySticker: keptBySticker.decision,
      flag: flag.decision,
      skipped: skipped.decision,
    });
    expect(dumped).not.toContain(caption);
    expect(dumped).not.toContain(actor);
    expect(dumped).not.toContain(fileId);
    expect(dumped).not.toContain("90209");
  });

  it("keeps a pending suggested post until that chat asks", async () => {
    const text = "待审建议帖广告";
    const actor = "投稿的人";
    async function posted(input: {
      updateId: number;
      chatId: number;
      state?: "pending" | "approved";
      flag?: boolean;
      paid?: boolean;
    }) {
      const normalized = await normalizeUpdate({
        update: {
          update_id: input.updateId,
          message: {
            message_id: input.updateId,
            date: 1761955200,
            chat: { id: input.chatId, type: "channel" },
            from: { id: 107, first_name: actor },
            text,
            ...(input.paid ? { is_paid_post: true } : {}),
            ...(input.state
              ? {
                  suggested_post_info: {
                    state: input.state,
                    price: { currency: "XTR", amount: 90208 },
                    send_date: 1761959028,
                  },
                }
              : {}),
            ...(input.flag ? { suggested_post_info: true } : {}),
          },
        },
        tenantId: "local",
        adminUserIds: [],
        nowIso: "2026-11-01T00:00:00.000Z",
      });
      expect(normalized.status).toBe("event");
      if (normalized.status !== "event") {
        throw new Error("expected event");
      }
      return normalized.event;
    }
    const idle = await posted({
      updateId: 10500,
      chatId: -1001100,
      state: "pending",
    });
    expect(idle.message?.asPostPending).toBe(true);
    expect(idle.message?.text).toBe(text);
    const idleDump = JSON.stringify(idle);
    expect(idleDump).not.toContain(actor);
    expect(idleDump).not.toContain("90208");
    const allowed = await screenTelegramEvent(idle, {
      rateWindow: createMemoryRateWindow(),
    });
    expect(allowed.decision.action).toBe("allow");
    const source: RuleSource = {
      async loadChat() {
        return {
          version: 1,
          aggregate: "max",
          rules: [
            {
              id: "post_pending",
              enabled: true,
              when: { eventKind: "message" },
              detectorIds: ["post_pending"],
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
    const removed = await screenTelegramEvent(
      await posted({ updateId: 10501, chatId: -1001101, state: "pending" }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: createMemoryModerator(),
      },
    );
    expect(removed.decision.action).toBe("delete");
    expect(removed.decision.reasons).toContain("post_pending");
    expect(removed.decision.ruleIds).toContain("post_pending");
    expect(removed.decision.evidence).toEqual([
      { kind: "feature", summary: "post:pending" },
    ]);
    const postOnly: RuleSource = {
      async loadChat() {
        return {
          version: 1,
          aggregate: "max",
          rules: [
            {
              id: "post_notice",
              enabled: true,
              when: { eventKind: "message" },
              detectorIds: ["post_notice"],
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
    const keptByPost = await screenTelegramEvent(
      await posted({ updateId: 10502, chatId: -1001102, state: "pending" }),
      {
        source: postOnly,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(keptByPost.decision.action).toBe("allow");
    const declinedOnly: RuleSource = {
      async loadChat() {
        return {
          version: 1,
          aggregate: "max",
          rules: [
            {
              id: "post_declined",
              enabled: true,
              when: { eventKind: "message" },
              detectorIds: ["post_declined"],
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
    const keptByDecline = await screenTelegramEvent(
      await posted({ updateId: 10503, chatId: -1001103, state: "pending" }),
      {
        source: declinedOnly,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(keptByDecline.decision.action).toBe("allow");
    const approved = await screenTelegramEvent(
      await posted({ updateId: 10504, chatId: -1001104, state: "approved" }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(approved.decision.action).toBe("allow");
    const flag = await screenTelegramEvent(
      await posted({ updateId: 10505, chatId: -1001105, flag: true }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(flag.decision.action).toBe("allow");
    const paidModerator = createMemoryModerator();
    const skipped = await screenTelegramEvent(
      await posted({
        updateId: 10506,
        chatId: -1001106,
        state: "pending",
        paid: true,
      }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: paidModerator,
      },
    );
    expect(skipped.decision.action).toBe("delete");
    expect(skipped.actionResults).toContainEqual({
      actionId: "delete",
      status: "skipped",
      detail: "paid_post",
    });
    expect(paidModerator.deleted).toEqual([]);
    const dumped = JSON.stringify({
      removed: removed.decision,
      keptByPost: keptByPost.decision,
      keptByDecline: keptByDecline.decision,
      approved: approved.decision,
      flag: flag.decision,
      skipped: skipped.decision,
    });
    expect(dumped).not.toContain(text);
    expect(dumped).not.toContain(actor);
    expect(dumped).not.toContain("90208");
  });

  it("keeps a created group until that chat asks", async () => {
    const actor = "建群的人";
    async function posted(input: {
      updateId: number;
      chatId: number;
      created?: boolean;
      flag?: boolean;
      paid?: boolean;
    }) {
      const normalized = await normalizeUpdate({
        update: {
          update_id: input.updateId,
          message: {
            message_id: input.updateId,
            date: 1761955200,
            chat: { id: input.chatId, type: "group" },
            from: { id: 106, first_name: actor },
            ...(input.paid ? { is_paid_post: true } : {}),
            ...(input.created ? { group_chat_created: true } : {}),
            ...(input.flag ? { group_chat_created: false } : {}),
          },
        },
        tenantId: "local",
        adminUserIds: [],
        nowIso: "2026-11-01T00:00:00.000Z",
      });
      expect(normalized.status).toBe("event");
      if (normalized.status !== "event") {
        throw new Error("expected event");
      }
      return normalized.event;
    }
    const idle = await posted({
      updateId: 10490,
      chatId: -1001090,
      created: true,
    });
    expect(idle.message?.asGroupCreated).toBe(true);
    expect(idle.message?.text).toBe("");
    expect(JSON.stringify(idle)).not.toContain(actor);
    const allowed = await screenTelegramEvent(idle, {
      rateWindow: createMemoryRateWindow(),
    });
    expect(allowed.decision.action).toBe("allow");
    const source: RuleSource = {
      async loadChat() {
        return {
          version: 1,
          aggregate: "max",
          rules: [
            {
              id: "group_created",
              enabled: true,
              when: { eventKind: "message" },
              detectorIds: ["group_created"],
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
    const removed = await screenTelegramEvent(
      await posted({ updateId: 10491, chatId: -1001091, created: true }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: createMemoryModerator(),
      },
    );
    expect(removed.decision.action).toBe("delete");
    expect(removed.decision.reasons).toContain("group_created");
    expect(removed.decision.ruleIds).toContain("group_created");
    expect(removed.decision.evidence).toEqual([
      { kind: "feature", summary: "group:created" },
    ]);
    const noticeOnly: RuleSource = {
      async loadChat() {
        return {
          version: 1,
          aggregate: "max",
          rules: [
            {
              id: "service_notice",
              enabled: true,
              when: { eventKind: "message" },
              detectorIds: ["notice"],
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
    const keptByNotice = await screenTelegramEvent(
      await posted({ updateId: 10492, chatId: -1001092, created: true }),
      {
        source: noticeOnly,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(keptByNotice.decision.action).toBe("allow");
    const flag = await screenTelegramEvent(
      await posted({ updateId: 10493, chatId: -1001093, flag: true }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(flag.decision.action).toBe("allow");
    const paidModerator = createMemoryModerator();
    const skipped = await screenTelegramEvent(
      await posted({
        updateId: 10494,
        chatId: -1001094,
        created: true,
        paid: true,
      }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: paidModerator,
      },
    );
    expect(skipped.decision.action).toBe("delete");
    expect(skipped.actionResults).toContainEqual({
      actionId: "delete",
      status: "skipped",
      detail: "paid_post",
    });
    expect(paidModerator.deleted).toEqual([]);
    const dumped = JSON.stringify({
      removed: removed.decision,
      keptByNotice: keptByNotice.decision,
      flag: flag.decision,
      skipped: skipped.decision,
    });
    expect(dumped).not.toContain(actor);
  });

  it("keeps a declined suggested post until that chat asks", async () => {
    const comment = "拒绝说明广告";
    const original = "原建议帖广告";
    const actor = "拒稿的人";
    async function posted(input: {
      updateId: number;
      chatId: number;
      declined?: boolean;
      flag?: boolean;
      paid?: boolean;
    }) {
      const normalized = await normalizeUpdate({
        update: {
          update_id: input.updateId,
          message: {
            message_id: input.updateId,
            date: 1761955200,
            chat: { id: input.chatId, type: "supergroup" },
            from: { id: 105, first_name: actor },
            ...(input.paid ? { is_paid_post: true } : {}),
            ...(input.declined
              ? {
                  suggested_post_declined: {
                    comment,
                    suggested_post_message: {
                      message_id: 1,
                      date: 1761955200,
                      chat: { id: input.chatId, type: "supergroup" },
                      text: original,
                    },
                  },
                }
              : {}),
            ...(input.flag ? { suggested_post_declined: true } : {}),
          },
        },
        tenantId: "local",
        adminUserIds: [],
        nowIso: "2026-11-01T00:00:00.000Z",
      });
      expect(normalized.status).toBe("event");
      if (normalized.status !== "event") {
        throw new Error("expected event");
      }
      return normalized.event;
    }
    const idle = await posted({
      updateId: 10480,
      chatId: -1001080,
      declined: true,
    });
    expect(idle.message?.asPostDeclined).toBe(true);
    expect(idle.message?.text).toBe(comment);
    const idleDump = JSON.stringify(idle);
    expect(idleDump).not.toContain(actor);
    expect(idleDump).not.toContain(original);
    const allowed = await screenTelegramEvent(idle, {
      rateWindow: createMemoryRateWindow(),
    });
    expect(allowed.decision.action).toBe("allow");
    const source: RuleSource = {
      async loadChat() {
        return {
          version: 1,
          aggregate: "max",
          rules: [
            {
              id: "post_declined",
              enabled: true,
              when: { eventKind: "message" },
              detectorIds: ["post_declined"],
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
    const removed = await screenTelegramEvent(
      await posted({ updateId: 10481, chatId: -1001081, declined: true }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: createMemoryModerator(),
      },
    );
    expect(removed.decision.action).toBe("delete");
    expect(removed.decision.reasons).toContain("post_declined");
    expect(removed.decision.ruleIds).toContain("post_declined");
    expect(removed.decision.evidence).toEqual([
      { kind: "feature", summary: "decline:post" },
    ]);
    const postOnly: RuleSource = {
      async loadChat() {
        return {
          version: 1,
          aggregate: "max",
          rules: [
            {
              id: "post_notice",
              enabled: true,
              when: { eventKind: "message" },
              detectorIds: ["post_notice"],
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
    const keptByPost = await screenTelegramEvent(
      await posted({ updateId: 10482, chatId: -1001082, declined: true }),
      {
        source: postOnly,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(keptByPost.decision.action).toBe("allow");
    const flag = await screenTelegramEvent(
      await posted({ updateId: 10483, chatId: -1001083, flag: true }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(flag.decision.action).toBe("allow");
    const paidModerator = createMemoryModerator();
    const skipped = await screenTelegramEvent(
      await posted({
        updateId: 10484,
        chatId: -1001084,
        declined: true,
        paid: true,
      }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: paidModerator,
      },
    );
    expect(skipped.decision.action).toBe("delete");
    expect(skipped.actionResults).toContainEqual({
      actionId: "delete",
      status: "skipped",
      detail: "paid_post",
    });
    expect(paidModerator.deleted).toEqual([]);
    const dumped = JSON.stringify({
      removed: removed.decision,
      keptByPost: keptByPost.decision,
      flag: flag.decision,
      skipped: skipped.decision,
    });
    expect(dumped).not.toContain(comment);
    expect(dumped).not.toContain(original);
    expect(dumped).not.toContain(actor);
  });

  it("keeps a topic rename until that chat asks", async () => {
    const created = "新建话题广告名";
    const actor = "建话题的人";
    const emoji = "表情编号90206专属";
    async function posted(input: {
      updateId: number;
      chatId: number;
      created?: boolean;
      flag?: boolean;
      paid?: boolean;
    }) {
      const normalized = await normalizeUpdate({
        update: {
          update_id: input.updateId,
          message: {
            message_id: input.updateId,
            date: 1761955200,
            chat: { id: input.chatId, type: "supergroup" },
            from: { id: 104, first_name: actor },
            ...(input.paid ? { is_paid_post: true } : {}),
            ...(input.created
              ? {
                  forum_topic_created: {
                    name: created,
                    icon_color: 90207,
                    icon_custom_emoji_id: emoji,
                    is_name_implicit: true,
                  },
                }
              : {}),
            ...(input.flag
              ? { forum_topic_created: true, forum_topic_edited: true }
              : {}),
          },
        },
        tenantId: "local",
        adminUserIds: [],
        nowIso: "2026-11-01T00:00:00.000Z",
      });
      expect(normalized.status).toBe("event");
      if (normalized.status !== "event") {
        throw new Error("expected event");
      }
      return normalized.event;
    }
    const idle = await posted({
      updateId: 10470,
      chatId: -1001070,
      created: true,
    });
    expect(idle.message?.topicNotice).toBe("created");
    expect(idle.message?.text).toBe(created);
    const idleDump = JSON.stringify(idle);
    expect(idleDump).not.toContain(actor);
    expect(idleDump).not.toContain(emoji);
    expect(idleDump).not.toContain("90207");
    const allowed = await screenTelegramEvent(idle, {
      rateWindow: createMemoryRateWindow(),
    });
    expect(allowed.decision.action).toBe("allow");
    const source: RuleSource = {
      async loadChat() {
        return {
          version: 1,
          aggregate: "max",
          rules: [
            {
              id: "topic_notice",
              enabled: true,
              when: { eventKind: "message" },
              detectorIds: ["topic_notice"],
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
    const removed = await screenTelegramEvent(
      await posted({ updateId: 10471, chatId: -1001071, created: true }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: createMemoryModerator(),
      },
    );
    expect(removed.decision.action).toBe("delete");
    expect(removed.decision.reasons).toContain("topic_notice");
    expect(removed.decision.ruleIds).toContain("topic_notice");
    expect(removed.decision.evidence).toEqual([
      { kind: "feature", summary: "topic:created" },
    ]);
    const forumOnly: RuleSource = {
      async loadChat() {
        return {
          version: 1,
          aggregate: "max",
          rules: [
            {
              id: "forum_notice",
              enabled: true,
              when: { eventKind: "message" },
              detectorIds: ["forum_notice"],
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
    const keptByForum = await screenTelegramEvent(
      await posted({ updateId: 10472, chatId: -1001072, created: true }),
      {
        source: forumOnly,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(keptByForum.decision.action).toBe("allow");
    const flag = await screenTelegramEvent(
      await posted({ updateId: 10473, chatId: -1001073, flag: true }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(flag.decision.action).toBe("allow");
    const paidModerator = createMemoryModerator();
    const skipped = await screenTelegramEvent(
      await posted({
        updateId: 10474,
        chatId: -1001074,
        created: true,
        paid: true,
      }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: paidModerator,
      },
    );
    expect(skipped.decision.action).toBe("delete");
    expect(skipped.actionResults).toContainEqual({
      actionId: "delete",
      status: "skipped",
      detail: "paid_post",
    });
    expect(paidModerator.deleted).toEqual([]);
    const dumped = JSON.stringify({
      removed: removed.decision,
      keptByForum: keptByForum.decision,
      flag: flag.decision,
      skipped: skipped.decision,
    });
    expect(dumped).not.toContain(created);
    expect(dumped).not.toContain(actor);
    expect(dumped).not.toContain(emoji);
    expect(dumped).not.toContain("90207");
  });

  it("keeps added checklist tasks until that chat asks", async () => {
    const first = "新加的广告事项";
    const title = "原清单标题广告";
    const actor = "加任务的人";
    const taskId = 90204;
    async function posted(input: {
      updateId: number;
      chatId: number;
      added?: boolean;
      flag?: boolean;
      paid?: boolean;
    }) {
      const normalized = await normalizeUpdate({
        update: {
          update_id: input.updateId,
          message: {
            message_id: input.updateId,
            date: 1761955200,
            chat: { id: input.chatId, type: "supergroup" },
            from: { id: 103, first_name: actor },
            ...(input.paid ? { is_paid_post: true } : {}),
            ...(input.added
              ? {
                  checklist_tasks_added: {
                    tasks: [{ id: taskId, text: first }],
                    checklist_message: {
                      message_id: 1,
                      date: 1761955200,
                      chat: { id: input.chatId, type: "supergroup" },
                      checklist: { title },
                    },
                  },
                }
              : {}),
            ...(input.flag ? { checklist_tasks_added: true } : {}),
          },
        },
        tenantId: "local",
        adminUserIds: [],
        nowIso: "2026-11-01T00:00:00.000Z",
      });
      expect(normalized.status).toBe("event");
      if (normalized.status !== "event") {
        throw new Error("expected event");
      }
      return normalized.event;
    }
    const idle = await posted({
      updateId: 10460,
      chatId: -1001066,
      added: true,
    });
    expect(idle.message?.asChecklistAdded).toBe(true);
    expect(idle.message?.text).toBe(first);
    const idleDump = JSON.stringify(idle);
    expect(idleDump).not.toContain(actor);
    expect(idleDump).not.toContain(title);
    expect(idleDump).not.toContain(String(taskId));
    const allowed = await screenTelegramEvent(idle, {
      rateWindow: createMemoryRateWindow(),
    });
    expect(allowed.decision.action).toBe("allow");
    const source: RuleSource = {
      async loadChat() {
        return {
          version: 1,
          aggregate: "max",
          rules: [
            {
              id: "checklist_added",
              enabled: true,
              when: { eventKind: "message" },
              detectorIds: ["checklist_added"],
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
    const removed = await screenTelegramEvent(
      await posted({ updateId: 10461, chatId: -1001067, added: true }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: createMemoryModerator(),
      },
    );
    expect(removed.decision.action).toBe("delete");
    expect(removed.decision.reasons).toContain("checklist_added");
    expect(removed.decision.ruleIds).toContain("checklist_added");
    expect(removed.decision.evidence).toEqual([
      { kind: "feature", summary: "checklist:added" },
    ]);
    const flag = await screenTelegramEvent(
      await posted({ updateId: 10462, chatId: -1001068, flag: true }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(flag.decision.action).toBe("allow");
    const paidModerator = createMemoryModerator();
    const skipped = await screenTelegramEvent(
      await posted({
        updateId: 10463,
        chatId: -1001069,
        added: true,
        paid: true,
      }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: paidModerator,
      },
    );
    expect(skipped.decision.action).toBe("delete");
    expect(skipped.actionResults).toContainEqual({
      actionId: "delete",
      status: "skipped",
      detail: "paid_post",
    });
    expect(paidModerator.deleted).toEqual([]);
    const dumped = JSON.stringify({
      removed: removed.decision,
      flag: flag.decision,
      skipped: skipped.decision,
    });
    expect(dumped).not.toContain(first);
    expect(dumped).not.toContain(title);
    expect(dumped).not.toContain(actor);
    expect(dumped).not.toContain(String(taskId));
  });

  it("keeps a poll option change until that chat asks", async () => {
    const added = "投票广告选项";
    const removed = "删掉的广告选项";
    const question = "原投票题干广告";
    const actor = "加选项的人";
    const optionId = "选项编号90203专属";
    async function posted(input: {
      updateId: number;
      chatId: number;
      kind?: "added" | "deleted";
      flag?: boolean;
      paid?: boolean;
    }) {
      const normalized = await normalizeUpdate({
        update: {
          update_id: input.updateId,
          message: {
            message_id: input.updateId,
            date: 1761955200,
            chat: { id: input.chatId, type: "supergroup" },
            from: { id: 102, first_name: actor },
            ...(input.paid ? { is_paid_post: true } : {}),
            ...(input.kind === "added"
              ? {
                  poll_option_added: {
                    option_persistent_id: optionId,
                    option_text: added,
                    poll_message: {
                      message_id: 1,
                      date: 1761955200,
                      chat: { id: input.chatId, type: "supergroup" },
                      poll: { question },
                    },
                  },
                }
              : {}),
            ...(input.kind === "deleted"
              ? {
                  poll_option_deleted: {
                    option_persistent_id: optionId,
                    option_text: removed,
                  },
                }
              : {}),
            ...(input.flag
              ? { poll_option_added: true, poll_option_deleted: true }
              : {}),
          },
        },
        tenantId: "local",
        adminUserIds: [],
        nowIso: "2026-11-01T00:00:00.000Z",
      });
      expect(normalized.status).toBe("event");
      if (normalized.status !== "event") {
        throw new Error("expected event");
      }
      return normalized.event;
    }
    const idle = await posted({
      updateId: 10450,
      chatId: -1001061,
      kind: "added",
    });
    expect(idle.message?.pollNotice).toBe("added");
    expect(idle.message?.text).toBe(added);
    const idleDump = JSON.stringify(idle);
    expect(idleDump).not.toContain(actor);
    expect(idleDump).not.toContain(optionId);
    expect(idleDump).not.toContain(question);
    const allowed = await screenTelegramEvent(idle, {
      rateWindow: createMemoryRateWindow(),
    });
    expect(allowed.decision.action).toBe("allow");
    const source: RuleSource = {
      async loadChat() {
        return {
          version: 1,
          aggregate: "max",
          rules: [
            {
              id: "poll_notice",
              enabled: true,
              when: { eventKind: "message" },
              detectorIds: ["poll_notice"],
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
    const removedHit = await screenTelegramEvent(
      await posted({ updateId: 10451, chatId: -1001062, kind: "added" }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: createMemoryModerator(),
      },
    );
    expect(removedHit.decision.action).toBe("delete");
    expect(removedHit.decision.reasons).toContain("poll_notice");
    expect(removedHit.decision.ruleIds).toContain("poll_notice");
    expect(removedHit.decision.evidence).toEqual([
      { kind: "feature", summary: "poll:added" },
    ]);
    const deleted = await screenTelegramEvent(
      await posted({ updateId: 10452, chatId: -1001063, kind: "deleted" }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: createMemoryModerator(),
      },
    );
    expect(deleted.decision.action).toBe("delete");
    expect(deleted.decision.evidence).toEqual([
      { kind: "feature", summary: "poll:deleted" },
    ]);
    const flag = await screenTelegramEvent(
      await posted({ updateId: 10453, chatId: -1001064, flag: true }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(flag.decision.action).toBe("allow");
    const paidModerator = createMemoryModerator();
    const skipped = await screenTelegramEvent(
      await posted({
        updateId: 10454,
        chatId: -1001065,
        kind: "added",
        paid: true,
      }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: paidModerator,
      },
    );
    expect(skipped.decision.action).toBe("delete");
    expect(skipped.actionResults).toContainEqual({
      actionId: "delete",
      status: "skipped",
      detail: "paid_post",
    });
    expect(paidModerator.deleted).toEqual([]);
    const dumped = JSON.stringify({
      removed: removedHit.decision,
      deleted: deleted.decision,
      flag: flag.decision,
      skipped: skipped.decision,
    });
    expect(dumped).not.toContain(added);
    expect(dumped).not.toContain(removed);
    expect(dumped).not.toContain(question);
    expect(dumped).not.toContain(actor);
    expect(dumped).not.toContain(optionId);
  });

  it("keeps a proximity alert until that chat asks", async () => {
    const traveler = "靠近广告名";
    const watcher = "守位置的人";
    const actor = "报位置的人";
    const travelerId = 90200;
    const watcherId = 90201;
    const distance = 90202;
    async function posted(input: {
      updateId: number;
      chatId: number;
      alert?: boolean;
      bad?: boolean;
      paid?: boolean;
    }) {
      const normalized = await normalizeUpdate({
        update: {
          update_id: input.updateId,
          message: {
            message_id: input.updateId,
            date: 1761955200,
            chat: { id: input.chatId, type: "supergroup" },
            from: { id: 101, first_name: actor },
            ...(input.paid ? { is_paid_post: true } : {}),
            ...(input.alert
              ? {
                  proximity_alert_triggered: {
                    traveler: {
                      id: travelerId,
                      is_bot: false,
                      first_name: traveler,
                    },
                    watcher: {
                      id: watcherId,
                      is_bot: false,
                      first_name: watcher,
                    },
                    distance,
                  },
                }
              : {}),
            ...(input.bad
              ? { proximity_alert_triggered: { distance: -1 } }
              : {}),
          },
        },
        tenantId: "local",
        adminUserIds: [],
        nowIso: "2026-11-01T00:00:00.000Z",
      });
      expect(normalized.status).toBe("event");
      if (normalized.status !== "event") {
        throw new Error("expected event");
      }
      return normalized.event;
    }
    const idle = await posted({
      updateId: 10440,
      chatId: -1001057,
      alert: true,
    });
    expect(idle.message?.asProximity).toBe(true);
    expect(idle.message?.text).toBe(`${traveler} ${watcher}`);
    const idleDump = JSON.stringify(idle);
    expect(idleDump).not.toContain(actor);
    expect(idleDump).not.toContain(String(travelerId));
    expect(idleDump).not.toContain(String(watcherId));
    expect(idleDump).not.toContain(String(distance));
    const allowed = await screenTelegramEvent(idle, {
      rateWindow: createMemoryRateWindow(),
    });
    expect(allowed.decision.action).toBe("allow");
    const source: RuleSource = {
      async loadChat() {
        return {
          version: 1,
          aggregate: "max",
          rules: [
            {
              id: "proximity_notice",
              enabled: true,
              when: { eventKind: "message" },
              detectorIds: ["proximity_notice"],
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
    const removed = await screenTelegramEvent(
      await posted({ updateId: 10441, chatId: -1001058, alert: true }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: createMemoryModerator(),
      },
    );
    expect(removed.decision.action).toBe("delete");
    expect(removed.decision.reasons).toContain("proximity_notice");
    expect(removed.decision.ruleIds).toContain("proximity_notice");
    expect(removed.decision.evidence).toEqual([
      { kind: "feature", summary: "proximity:near" },
    ]);
    const bad = await screenTelegramEvent(
      await posted({ updateId: 10442, chatId: -1001059, bad: true }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(bad.decision.action).toBe("allow");
    const paidModerator = createMemoryModerator();
    const skipped = await screenTelegramEvent(
      await posted({
        updateId: 10443,
        chatId: -1001060,
        alert: true,
        paid: true,
      }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: paidModerator,
      },
    );
    expect(skipped.decision.action).toBe("delete");
    expect(skipped.actionResults).toContainEqual({
      actionId: "delete",
      status: "skipped",
      detail: "paid_post",
    });
    expect(paidModerator.deleted).toEqual([]);
    const dumped = JSON.stringify({
      removed: removed.decision,
      bad: bad.decision,
      skipped: skipped.decision,
    });
    expect(dumped).not.toContain(traveler);
    expect(dumped).not.toContain(watcher);
    expect(dumped).not.toContain(actor);
    expect(dumped).not.toContain(String(travelerId));
    expect(dumped).not.toContain(String(watcherId));
    expect(dumped).not.toContain(String(distance));
  });

  it("keeps an owner change until that chat asks", async () => {
    const name = "新群主广告名";
    const actor = "交群的人";
    const userId = 90199;
    async function posted(input: {
      updateId: number;
      chatId: number;
      changed?: boolean;
      left?: boolean;
      flag?: boolean;
      paid?: boolean;
    }) {
      const normalized = await normalizeUpdate({
        update: {
          update_id: input.updateId,
          message: {
            message_id: input.updateId,
            date: 1761955200,
            chat: { id: input.chatId, type: "supergroup" },
            from: { id: 100, first_name: actor },
            ...(input.paid ? { is_paid_post: true } : {}),
            ...(input.changed
              ? {
                  chat_owner_changed: {
                    new_owner: { id: userId, is_bot: false, first_name: name },
                  },
                }
              : {}),
            ...(input.left ? { chat_owner_left: {} } : {}),
            ...(input.flag
              ? { chat_owner_changed: true, chat_owner_left: true }
              : {}),
          },
        },
        tenantId: "local",
        adminUserIds: [],
        nowIso: "2026-11-01T00:00:00.000Z",
      });
      expect(normalized.status).toBe("event");
      if (normalized.status !== "event") {
        throw new Error("expected event");
      }
      return normalized.event;
    }
    const idle = await posted({
      updateId: 10430,
      chatId: -1001052,
      changed: true,
    });
    expect(idle.message?.ownerNotice).toBe("changed");
    expect(idle.message?.text).toBe(name);
    expect(JSON.stringify(idle)).not.toContain(actor);
    expect(JSON.stringify(idle)).not.toContain(String(userId));
    const allowed = await screenTelegramEvent(idle, {
      rateWindow: createMemoryRateWindow(),
    });
    expect(allowed.decision.action).toBe("allow");
    const source: RuleSource = {
      async loadChat() {
        return {
          version: 1,
          aggregate: "max",
          rules: [
            {
              id: "owner_notice",
              enabled: true,
              when: { eventKind: "message" },
              detectorIds: ["owner_notice"],
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
    const removed = await screenTelegramEvent(
      await posted({ updateId: 10431, chatId: -1001053, changed: true }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: createMemoryModerator(),
      },
    );
    expect(removed.decision.action).toBe("delete");
    expect(removed.decision.reasons).toContain("owner_notice");
    expect(removed.decision.ruleIds).toContain("owner_notice");
    expect(removed.decision.evidence).toEqual([
      { kind: "feature", summary: "owner:changed" },
    ]);
    const left = await screenTelegramEvent(
      await posted({ updateId: 10432, chatId: -1001054, left: true }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: createMemoryModerator(),
      },
    );
    expect(left.decision.action).toBe("delete");
    expect(left.decision.evidence).toEqual([
      { kind: "feature", summary: "owner:left" },
    ]);
    const flag = await screenTelegramEvent(
      await posted({ updateId: 10433, chatId: -1001055, flag: true }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(flag.decision.action).toBe("allow");
    const paidModerator = createMemoryModerator();
    const skipped = await screenTelegramEvent(
      await posted({
        updateId: 10434,
        chatId: -1001056,
        changed: true,
        paid: true,
      }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: paidModerator,
      },
    );
    expect(skipped.decision.action).toBe("delete");
    expect(skipped.actionResults).toContainEqual({
      actionId: "delete",
      status: "skipped",
      detail: "paid_post",
    });
    expect(paidModerator.deleted).toEqual([]);
    const dumped = JSON.stringify({
      removed: removed.decision,
      left: left.decision,
      flag: flag.decision,
      skipped: skipped.decision,
    });
    expect(dumped).not.toContain(String(userId));
    expect(dumped).not.toContain(actor);
  });

  it("keeps a video-chat invite until that chat asks", async () => {
    const name = "视频邀请广告名";
    const actor = "拉人的人";
    const userId = 90198;
    async function posted(input: {
      updateId: number;
      chatId: number;
      invited?: boolean;
      flag?: boolean;
      paid?: boolean;
    }) {
      const normalized = await normalizeUpdate({
        update: {
          update_id: input.updateId,
          message: {
            message_id: input.updateId,
            date: 1761955200,
            chat: { id: input.chatId, type: "supergroup" },
            from: { id: 99, first_name: actor },
            ...(input.paid ? { is_paid_post: true } : {}),
            ...(input.invited
              ? {
                  video_chat_participants_invited: {
                    users: [{ id: userId, first_name: name }],
                  },
                }
              : {}),
            ...(input.flag ? { video_chat_participants_invited: true } : {}),
          },
        },
        tenantId: "local",
        adminUserIds: [],
        nowIso: "2026-11-01T00:00:00.000Z",
      });
      expect(normalized.status).toBe("event");
      if (normalized.status !== "event") {
        throw new Error("expected event");
      }
      return normalized.event;
    }
    const idle = await posted({
      updateId: 10420,
      chatId: -1001048,
      invited: true,
    });
    expect(idle.message?.asCallInvite).toBe(true);
    expect(idle.message?.text).toBe(name);
    expect(JSON.stringify(idle)).not.toContain(actor);
    expect(JSON.stringify(idle)).not.toContain(String(userId));
    const allowed = await screenTelegramEvent(idle, {
      rateWindow: createMemoryRateWindow(),
    });
    expect(allowed.decision.action).toBe("allow");
    const source: RuleSource = {
      async loadChat() {
        return {
          version: 1,
          aggregate: "max",
          rules: [
            {
              id: "call_invite",
              enabled: true,
              when: { eventKind: "message" },
              detectorIds: ["call_invite"],
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
    const removed = await screenTelegramEvent(
      await posted({ updateId: 10421, chatId: -1001049, invited: true }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: createMemoryModerator(),
      },
    );
    expect(removed.decision.action).toBe("delete");
    expect(removed.decision.reasons).toContain("call_invite");
    expect(removed.decision.ruleIds).toContain("call_invite");
    expect(removed.decision.evidence).toEqual([
      { kind: "feature", summary: "invite:video" },
    ]);
    const flag = await screenTelegramEvent(
      await posted({ updateId: 10422, chatId: -1001050, flag: true }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(flag.decision.action).toBe("allow");
    const paidModerator = createMemoryModerator();
    const skipped = await screenTelegramEvent(
      await posted({
        updateId: 10423,
        chatId: -1001051,
        invited: true,
        paid: true,
      }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: paidModerator,
      },
    );
    expect(skipped.decision.action).toBe("delete");
    expect(skipped.actionResults).toContainEqual({
      actionId: "delete",
      status: "skipped",
      detail: "paid_post",
    });
    expect(paidModerator.deleted).toEqual([]);
    const dumped = JSON.stringify({
      removed: removed.decision,
      flag: flag.decision,
      skipped: skipped.decision,
    });
    expect(dumped).not.toContain(String(userId));
    expect(dumped).not.toContain(actor);
  });

  it("copies saved settings when a group becomes a supergroup", async () => {
    const keyword = "迁移专属词";
    const runtime = createMemoryRuntimeStore();
    const policyStore = createMemoryPolicyStore();
    await runtime.addKeyword("local", "-1001046", keyword);
    await runtime.setFloodPolicy("local", "-1001046", {
      threshold: 8,
      windowSeconds: 20,
    });
    await policyStore.put("local", "-1001046", {
      exemptAdmins: false,
      allowActorIds: ["user_kept"],
    });
    const logger = createMemoryLogger();
    const moved = await normalizeUpdate({
      update: {
        update_id: 10410,
        message: {
          message_id: 10410,
          date: 1761955200,
          chat: { id: -1001046, type: "group" },
          from: { id: 98, first_name: "升级群的人" },
          migrate_to_chat_id: -100880446,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(moved.status).toBe("event");
    if (moved.status !== "event") {
      return;
    }
    expect(moved.event.chatMove).toEqual({
      from: "-1001046",
      to: "-100880446",
    });
    const allowed = await screenTelegramEvent(moved.event, {
      runtime,
      policyStore,
      logger,
      rateWindow: createMemoryRateWindow(),
    });
    expect(allowed.decision.action).toBe("allow");
    expect(await runtime.listKeywords("local", "-100880446")).toEqual([
      keyword,
    ]);
    expect(await runtime.listKeywords("local", "-1001046")).toEqual([keyword]);
    expect(await runtime.getFloodPolicy("local", "-100880446")).toEqual({
      threshold: 8,
      windowSeconds: 20,
    });
    expect(await policyStore.get("local", "-100880446")).toEqual({
      exemptAdmins: false,
      allowActorIds: ["user_kept"],
    });
    expect(JSON.stringify(logger.entries)).toContain("chat_moved");
    expect(JSON.stringify(logger.entries)).not.toContain(keyword);
    expect(JSON.stringify(logger.entries)).not.toContain("升级群的人");
    const spam = await normalizeUpdate({
      update: {
        update_id: 10411,
        message: {
          message_id: 10411,
          date: 1761955200,
          chat: { id: -100880446, type: "supergroup" },
          from: { id: 99 },
          text: keyword,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(spam.status).toBe("event");
    if (spam.status !== "event") {
      return;
    }
    const removed = await screenTelegramEvent(spam.event, {
      runtime,
      policyStore,
      cache: createMemoryCache(),
      rateWindow: createMemoryRateWindow(),
      moderator: createMemoryModerator(),
    });
    expect(removed.decision.action).toBe("delete");
    expect(removed.decision.reasons).toContain("keyword_match");

    await runtime.addKeyword("local", "-100880447", "已有词");
    await runtime.addKeyword("local", "-1001047", keyword);
    const kept = await normalizeUpdate({
      update: {
        update_id: 10412,
        message: {
          message_id: 10412,
          date: 1761955200,
          chat: { id: -100880447, type: "supergroup" },
          from: { id: 98 },
          migrate_from_chat_id: -1001047,
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
    await screenTelegramEvent(kept.event, {
      runtime,
      policyStore,
      cache: createMemoryCache(),
      rateWindow: createMemoryRateWindow(),
    });
    expect(await runtime.listKeywords("local", "-100880447")).toEqual([
      "已有词",
    ]);
    expect(await runtime.listKeywords("local", "-1001047")).toEqual([keyword]);

    const broken = {
      ...runtime,
      async getDryRun() {
        throw new Error("runtime_down");
      },
    };
    const failedLog = createMemoryLogger();
    const failed = await screenTelegramEvent(moved.event, {
      runtime: broken,
      logger: failedLog,
      rateWindow: createMemoryRateWindow(),
    });
    expect(failed.decision.action).toBe("allow");
    expect(JSON.stringify(failedLog.entries)).toContain("chat_move_failed");
    expect(JSON.stringify(failedLog.entries)).not.toContain(keyword);
  });

  it("keeps a checklist notice until that chat asks", async () => {
    const title = "勾完的广告事项";
    const actor = "勾任务的人";
    const doneId = 90196;
    async function posted(input: {
      updateId: number;
      chatId: number;
      done?: boolean;
      undone?: boolean;
      flag?: boolean;
      paid?: boolean;
    }) {
      const normalized = await normalizeUpdate({
        update: {
          update_id: input.updateId,
          message: {
            message_id: input.updateId,
            date: 1761955200,
            chat: { id: input.chatId, type: "supergroup" },
            from: { id: 97, first_name: actor },
            ...(input.paid ? { is_paid_post: true } : {}),
            ...(input.done
              ? {
                  checklist_tasks_done: {
                    marked_as_done_task_ids: [doneId],
                    checklist_message: { text: title },
                  },
                }
              : {}),
            ...(input.undone
              ? {
                  checklist_tasks_done: {
                    marked_as_not_done_task_ids: [90197],
                    checklist_message: { text: title },
                  },
                }
              : {}),
            ...(input.flag ? { checklist_tasks_done: true } : {}),
          },
        },
        tenantId: "local",
        adminUserIds: [],
        nowIso: "2026-11-01T00:00:00.000Z",
      });
      expect(normalized.status).toBe("event");
      if (normalized.status !== "event") {
        throw new Error("expected event");
      }
      return normalized.event;
    }
    const idle = await posted({
      updateId: 10400,
      chatId: -1001040,
      done: true,
    });
    expect(idle.message?.checklistNotice).toBe("done");
    expect(idle.message?.text).toBe("");
    expect(JSON.stringify(idle)).not.toContain(title);
    expect(JSON.stringify(idle)).not.toContain(actor);
    expect(JSON.stringify(idle)).not.toContain(String(doneId));
    const allowed = await screenTelegramEvent(idle, {
      rateWindow: createMemoryRateWindow(),
    });
    expect(allowed.decision.action).toBe("allow");
    const source: RuleSource = {
      async loadChat() {
        return {
          version: 1,
          aggregate: "max",
          rules: [
            {
              id: "checklist_notice",
              enabled: true,
              when: { eventKind: "message" },
              detectorIds: ["checklist_notice"],
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
    const removed = await screenTelegramEvent(
      await posted({ updateId: 10401, chatId: -1001041, undone: true }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: createMemoryModerator(),
      },
    );
    expect(removed.decision.action).toBe("delete");
    expect(removed.decision.reasons).toContain("checklist_notice");
    expect(removed.decision.ruleIds).toContain("checklist_notice");
    expect(removed.decision.evidence).toEqual([
      { kind: "feature", summary: "checklist:undone" },
    ]);
    const flag = await screenTelegramEvent(
      await posted({ updateId: 10402, chatId: -1001042, flag: true }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(flag.decision.action).toBe("allow");
    const paidModerator = createMemoryModerator();
    const skipped = await screenTelegramEvent(
      await posted({
        updateId: 10403,
        chatId: -1001043,
        done: true,
        paid: true,
      }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: paidModerator,
      },
    );
    expect(skipped.decision.action).toBe("delete");
    expect(skipped.actionResults).toContainEqual({
      actionId: "delete",
      status: "skipped",
      detail: "paid_post",
    });
    expect(paidModerator.deleted).toEqual([]);
    const dumped = JSON.stringify({
      removed: removed.decision,
      flag: flag.decision,
      skipped: skipped.decision,
    });
    expect(dumped).not.toContain(title);
    expect(dumped).not.toContain(actor);
    expect(dumped).not.toContain(String(doneId));
    expect(dumped).not.toContain("90197");
  });

  it("keeps a suggested-post notice until that chat asks", async () => {
    const title = "建议帖广告正文";
    const actor = "过稿的人";
    const sendDate = 90192;
    async function posted(input: {
      updateId: number;
      chatId: number;
      approved?: boolean;
      refunded?: boolean;
      flag?: boolean;
      paid?: boolean;
    }) {
      const normalized = await normalizeUpdate({
        update: {
          update_id: input.updateId,
          message: {
            message_id: input.updateId,
            date: 1761955200,
            chat: { id: input.chatId, type: "channel" },
            from: { id: 96, first_name: actor },
            ...(input.paid ? { is_paid_post: true } : {}),
            ...(input.approved
              ? {
                  suggested_post_approved: {
                    send_date: sendDate,
                    suggested_post_message: { text: title },
                  },
                }
              : {}),
            ...(input.refunded
              ? {
                  suggested_post_refunded: {
                    reason: "payment_refunded",
                    suggested_post_message: { text: title },
                  },
                }
              : {}),
            ...(input.flag ? { suggested_post_approved: true } : {}),
          },
        },
        tenantId: "local",
        adminUserIds: [],
        nowIso: "2026-11-01T00:00:00.000Z",
      });
      expect(normalized.status).toBe("event");
      if (normalized.status !== "event") {
        throw new Error("expected event");
      }
      return normalized.event;
    }
    const idle = await posted({
      updateId: 8900,
      chatId: -100890,
      approved: true,
    });
    expect(idle.message?.postNotice).toBe("approved");
    expect(idle.message?.text).toBe("");
    expect(JSON.stringify(idle)).not.toContain(title);
    expect(JSON.stringify(idle)).not.toContain(actor);
    expect(JSON.stringify(idle)).not.toContain(String(sendDate));
    const allowed = await screenTelegramEvent(idle, {
      rateWindow: createMemoryRateWindow(),
    });
    expect(allowed.decision.action).toBe("allow");
    const source: RuleSource = {
      async loadChat() {
        return {
          version: 1,
          aggregate: "max",
          rules: [
            {
              id: "post_notice",
              enabled: true,
              when: { eventKind: "message" },
              detectorIds: ["post_notice"],
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
    const removed = await screenTelegramEvent(
      await posted({ updateId: 8901, chatId: -100891, refunded: true }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: createMemoryModerator(),
      },
    );
    expect(removed.decision.action).toBe("delete");
    expect(removed.decision.reasons).toContain("post_notice");
    expect(removed.decision.ruleIds).toContain("post_notice");
    expect(removed.decision.evidence).toEqual([
      { kind: "feature", summary: "post:refunded" },
    ]);
    const flag = await screenTelegramEvent(
      await posted({ updateId: 8902, chatId: -100892, flag: true }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(flag.decision.action).toBe("allow");
    const paidModerator = createMemoryModerator();
    const skipped = await screenTelegramEvent(
      await posted({
        updateId: 8903,
        chatId: -100893,
        approved: true,
        paid: true,
      }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: paidModerator,
      },
    );
    expect(skipped.decision.action).toBe("delete");
    expect(skipped.actionResults).toContainEqual({
      actionId: "delete",
      status: "skipped",
      detail: "paid_post",
    });
    expect(paidModerator.deleted).toEqual([]);
    const dumped = JSON.stringify({
      removed: removed.decision,
      flag: flag.decision,
      skipped: skipped.decision,
    });
    expect(dumped).not.toContain(title);
    expect(dumped).not.toContain(actor);
    expect(dumped).not.toContain("payment_refunded");
    expect(dumped).not.toContain(String(sendDate));
  });

  it("keeps a price notice until that chat asks", async () => {
    const stars = 90188;
    const directStars = 90189;
    const actor = "改价的人";
    async function posted(input: {
      updateId: number;
      chatId: number;
      paid?: number;
      direct?: boolean;
      empty?: boolean;
      paidPost?: boolean;
    }) {
      const normalized = await normalizeUpdate({
        update: {
          update_id: input.updateId,
          message: {
            message_id: input.updateId,
            date: 1761955200,
            chat: {
              id: input.chatId,
              type: input.direct ? "channel" : "supergroup",
            },
            from: { id: 96, first_name: actor },
            ...(input.paidPost ? { is_paid_post: true } : {}),
            ...(input.paid === undefined
              ? {}
              : {
                  paid_message_price_changed: {
                    paid_message_star_count: input.paid,
                  },
                }),
            ...(input.direct
              ? {
                  direct_message_price_changed: {
                    are_direct_messages_enabled: false,
                    direct_message_star_count: directStars,
                  },
                }
              : {}),
            ...(input.empty ? { paid_message_price_changed: {} } : {}),
          },
        },
        tenantId: "local",
        adminUserIds: [],
        nowIso: "2026-11-01T00:00:00.000Z",
      });
      expect(normalized.status).toBe("event");
      if (normalized.status !== "event") {
        throw new Error("expected event");
      }
      return normalized.event;
    }
    const idle = await posted({
      updateId: 8800,
      chatId: -100880,
      paid: stars,
    });
    expect(idle.message?.priceNotice).toBe("paid");
    expect(idle.message?.text).toBe("");
    expect(JSON.stringify(idle)).not.toContain(String(stars));
    expect(JSON.stringify(idle)).not.toContain(actor);
    const allowed = await screenTelegramEvent(idle, {
      rateWindow: createMemoryRateWindow(),
    });
    expect(allowed.decision.action).toBe("allow");
    const source: RuleSource = {
      async loadChat() {
        return {
          version: 1,
          aggregate: "max",
          rules: [
            {
              id: "price_notice",
              enabled: true,
              when: { eventKind: "message" },
              detectorIds: ["price_notice"],
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
    const removed = await screenTelegramEvent(
      await posted({ updateId: 8801, chatId: -100881, direct: true }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: createMemoryModerator(),
      },
    );
    expect(removed.decision.action).toBe("delete");
    expect(removed.decision.reasons).toContain("price_notice");
    expect(removed.decision.ruleIds).toContain("price_notice");
    expect(removed.decision.evidence).toEqual([
      { kind: "feature", summary: "price:direct" },
    ]);
    const empty = await screenTelegramEvent(
      await posted({ updateId: 8802, chatId: -100882, empty: true }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(empty.decision.action).toBe("allow");
    const paidModerator = createMemoryModerator();
    const skipped = await screenTelegramEvent(
      await posted({
        updateId: 8803,
        chatId: -100883,
        paid: stars,
        paidPost: true,
      }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: paidModerator,
      },
    );
    expect(skipped.decision.action).toBe("delete");
    expect(skipped.actionResults).toContainEqual({
      actionId: "delete",
      status: "skipped",
      detail: "paid_post",
    });
    expect(paidModerator.deleted).toEqual([]);
    const dumped = JSON.stringify({
      removed: removed.decision,
      empty: empty.decision,
      skipped: skipped.decision,
    });
    expect(dumped).not.toContain(String(stars));
    expect(dumped).not.toContain(String(directStars));
    expect(dumped).not.toContain(actor);
  });

  it("keeps an auto-delete notice until that chat asks", async () => {
    const seconds = 90186;
    const actor = "改计时的人";
    async function posted(input: {
      updateId: number;
      chatId: number;
      seconds?: number;
      empty?: boolean;
      flag?: boolean;
      paid?: boolean;
    }) {
      const normalized = await normalizeUpdate({
        update: {
          update_id: input.updateId,
          message: {
            message_id: input.updateId,
            date: 1761955200,
            chat: { id: input.chatId, type: "supergroup" },
            from: { id: 96, first_name: actor },
            ...(input.paid ? { is_paid_post: true } : {}),
            ...(input.seconds === undefined
              ? {}
              : {
                  message_auto_delete_timer_changed: {
                    message_auto_delete_time: input.seconds,
                  },
                }),
            ...(input.empty ? { message_auto_delete_timer_changed: {} } : {}),
            ...(input.flag ? { message_auto_delete_timer_changed: true } : {}),
          },
        },
        tenantId: "local",
        adminUserIds: [],
        nowIso: "2026-11-01T00:00:00.000Z",
      });
      expect(normalized.status).toBe("event");
      if (normalized.status !== "event") {
        throw new Error("expected event");
      }
      return normalized.event;
    }
    const idle = await posted({
      updateId: 8700,
      chatId: -100870,
      seconds,
    });
    expect(idle.message?.asAutoDelete).toBe(true);
    expect(idle.message?.text).toBe("");
    expect(JSON.stringify(idle)).not.toContain(String(seconds));
    expect(JSON.stringify(idle)).not.toContain(actor);
    const allowed = await screenTelegramEvent(idle, {
      rateWindow: createMemoryRateWindow(),
    });
    expect(allowed.decision.action).toBe("allow");
    const source: RuleSource = {
      async loadChat() {
        return {
          version: 1,
          aggregate: "max",
          rules: [
            {
              id: "autodelete_notice",
              enabled: true,
              when: { eventKind: "message" },
              detectorIds: ["autodelete_notice"],
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
    const removed = await screenTelegramEvent(
      await posted({ updateId: 8701, chatId: -100871, seconds: 0 }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: createMemoryModerator(),
      },
    );
    expect(removed.decision.action).toBe("delete");
    expect(removed.decision.reasons).toContain("autodelete_notice");
    expect(removed.decision.ruleIds).toContain("autodelete_notice");
    expect(removed.decision.evidence).toEqual([
      { kind: "feature", summary: "autodelete:changed" },
    ]);
    const empty = await screenTelegramEvent(
      await posted({ updateId: 8702, chatId: -100872, empty: true }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(empty.decision.action).toBe("allow");
    const paidModerator = createMemoryModerator();
    const skipped = await screenTelegramEvent(
      await posted({
        updateId: 8703,
        chatId: -100873,
        seconds,
        paid: true,
      }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: paidModerator,
      },
    );
    expect(skipped.decision.action).toBe("delete");
    expect(skipped.actionResults).toContainEqual({
      actionId: "delete",
      status: "skipped",
      detail: "paid_post",
    });
    expect(paidModerator.deleted).toEqual([]);
    const dumped = JSON.stringify({
      removed: removed.decision,
      empty: empty.decision,
      skipped: skipped.decision,
    });
    expect(dumped).not.toContain(String(seconds));
    expect(dumped).not.toContain(actor);
  });

  it("keeps a forum notice until that chat asks", async () => {
    const title = "关掉广告名";
    async function posted(input: {
      updateId: number;
      chatId: number;
      closed?: boolean;
      reopened?: boolean;
      flag?: boolean;
      paid?: boolean;
    }) {
      const normalized = await normalizeUpdate({
        update: {
          update_id: input.updateId,
          message: {
            message_id: input.updateId,
            date: 1761955200,
            chat: { id: input.chatId, type: "supergroup" },
            from: { id: 96, first_name: "关话题的人" },
            ...(input.paid ? { is_paid_post: true } : {}),
            ...(input.closed ? { forum_topic_closed: { name: title } } : {}),
            ...(input.reopened ? { forum_topic_reopened: {} } : {}),
            ...(input.flag ? { forum_topic_closed: true } : {}),
          },
        },
        tenantId: "local",
        adminUserIds: [],
        nowIso: "2026-11-01T00:00:00.000Z",
      });
      expect(normalized.status).toBe("event");
      if (normalized.status !== "event") {
        throw new Error("expected event");
      }
      return normalized.event;
    }
    const idle = await posted({
      updateId: 8600,
      chatId: -100860,
      closed: true,
    });
    expect(idle.message?.forumNotice).toBe("closed");
    expect(idle.message?.text).toBe("");
    expect(JSON.stringify(idle)).not.toContain(title);
    expect(JSON.stringify(idle)).not.toContain("关话题的人");
    const allowed = await screenTelegramEvent(idle, {
      rateWindow: createMemoryRateWindow(),
    });
    expect(allowed.decision.action).toBe("allow");
    const source: RuleSource = {
      async loadChat() {
        return {
          version: 1,
          aggregate: "max",
          rules: [
            {
              id: "forum_notice",
              enabled: true,
              when: { eventKind: "message" },
              detectorIds: ["forum_notice"],
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
    const removed = await screenTelegramEvent(
      await posted({ updateId: 8601, chatId: -100861, reopened: true }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: createMemoryModerator(),
      },
    );
    expect(removed.decision.action).toBe("delete");
    expect(removed.decision.reasons).toContain("forum_notice");
    expect(removed.decision.ruleIds).toContain("forum_notice");
    expect(removed.decision.evidence).toEqual([
      { kind: "feature", summary: "forum:reopened" },
    ]);
    const flag = await screenTelegramEvent(
      await posted({ updateId: 8602, chatId: -100862, flag: true }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(flag.decision.action).toBe("allow");
    const paidModerator = createMemoryModerator();
    const skipped = await screenTelegramEvent(
      await posted({
        updateId: 8603,
        chatId: -100863,
        closed: true,
        paid: true,
      }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: paidModerator,
      },
    );
    expect(skipped.decision.action).toBe("delete");
    expect(skipped.actionResults).toContainEqual({
      actionId: "delete",
      status: "skipped",
      detail: "paid_post",
    });
    expect(paidModerator.deleted).toEqual([]);
    const dumped = JSON.stringify({
      removed: removed.decision,
      flag: flag.decision,
      skipped: skipped.decision,
    });
    expect(dumped).not.toContain(title);
    expect(dumped).not.toContain("关话题的人");
  });

  it("keeps a boost until that chat asks", async () => {
    const booster = "助推的人";
    const count = 90185;
    async function posted(input: {
      updateId: number;
      chatId: number;
      boost?: boolean;
      empty?: boolean;
      paid?: boolean;
    }) {
      const normalized = await normalizeUpdate({
        update: {
          update_id: input.updateId,
          message: {
            message_id: input.updateId,
            date: 1761955200,
            chat: { id: input.chatId, type: "supergroup" },
            from: { id: 96, first_name: booster },
            ...(input.paid ? { is_paid_post: true } : {}),
            ...(input.boost ? { boost_added: { boost_count: count } } : {}),
            ...(input.empty ? { boost_added: {} } : {}),
          },
        },
        tenantId: "local",
        adminUserIds: [],
        nowIso: "2026-11-01T00:00:00.000Z",
      });
      expect(normalized.status).toBe("event");
      if (normalized.status !== "event") {
        throw new Error("expected event");
      }
      return normalized.event;
    }
    const idle = await posted({
      updateId: 8500,
      chatId: -100850,
      boost: true,
    });
    expect(idle.message?.asBoost).toBe(true);
    expect(idle.message?.text).toBe("");
    expect(JSON.stringify(idle)).not.toContain(booster);
    expect(JSON.stringify(idle)).not.toContain(String(count));
    const allowed = await screenTelegramEvent(idle, {
      rateWindow: createMemoryRateWindow(),
    });
    expect(allowed.decision.action).toBe("allow");
    const source: RuleSource = {
      async loadChat() {
        return {
          version: 1,
          aggregate: "max",
          rules: [
            {
              id: "chat_boost",
              enabled: true,
              when: { eventKind: "message" },
              detectorIds: ["chat_boost"],
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
    const removed = await screenTelegramEvent(
      await posted({ updateId: 8501, chatId: -100851, boost: true }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: createMemoryModerator(),
      },
    );
    expect(removed.decision.action).toBe("delete");
    expect(removed.decision.reasons).toContain("chat_boost");
    expect(removed.decision.ruleIds).toContain("chat_boost");
    expect(removed.decision.evidence).toEqual([
      { kind: "feature", summary: "boost:added" },
    ]);
    const empty = await screenTelegramEvent(
      await posted({ updateId: 8502, chatId: -100852, empty: true }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(empty.decision.action).toBe("allow");
    const paidModerator = createMemoryModerator();
    const skipped = await screenTelegramEvent(
      await posted({
        updateId: 8503,
        chatId: -100853,
        boost: true,
        paid: true,
      }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: paidModerator,
      },
    );
    expect(skipped.decision.action).toBe("delete");
    expect(skipped.actionResults).toContainEqual({
      actionId: "delete",
      status: "skipped",
      detail: "paid_post",
    });
    expect(paidModerator.deleted).toEqual([]);
    const dumped = JSON.stringify({
      removed: removed.decision,
      empty: empty.decision,
      skipped: skipped.decision,
    });
    expect(dumped).not.toContain(booster);
    expect(dumped).not.toContain(String(count));
  });

  it("keeps a giveaway notice until that chat asks", async () => {
    const prize = "抽奖广告正文";
    const prizeId = 90184;
    async function posted(input: {
      updateId: number;
      chatId: number;
      created?: boolean;
      completed?: boolean;
      empty?: boolean;
      paid?: boolean;
    }) {
      const normalized = await normalizeUpdate({
        update: {
          update_id: input.updateId,
          message: {
            message_id: input.updateId,
            date: 1761955200,
            chat: { id: input.chatId, type: "supergroup" },
            from: { id: 96 },
            ...(input.paid ? { is_paid_post: true } : {}),
            ...(input.created ? { giveaway_created: {} } : {}),
            ...(input.completed
              ? {
                  giveaway_completed: {
                    winner_count: 3,
                    giveaway_message: {
                      message_id: prizeId,
                      text: `${prize} https://bit.ly/gw451`,
                      from: { id: 97, first_name: "开奖的人" },
                    },
                  },
                }
              : {}),
            ...(input.empty ? { giveaway_completed: {} } : {}),
          },
        },
        tenantId: "local",
        adminUserIds: [],
        nowIso: "2026-11-01T00:00:00.000Z",
      });
      expect(normalized.status).toBe("event");
      if (normalized.status !== "event") {
        throw new Error("expected event");
      }
      return normalized.event;
    }
    const idle = await posted({
      updateId: 8400,
      chatId: -100840,
      created: true,
    });
    expect(idle.message?.giveawayNotice).toBe("created");
    expect(idle.message?.text).toBe("");
    const allowed = await screenTelegramEvent(idle, {
      rateWindow: createMemoryRateWindow(),
    });
    expect(allowed.decision.action).toBe("allow");
    const source: RuleSource = {
      async loadChat() {
        return {
          version: 1,
          aggregate: "max",
          rules: [
            {
              id: "giveaway_notice",
              enabled: true,
              when: { eventKind: "message" },
              detectorIds: ["giveaway_notice"],
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
    const removed = await screenTelegramEvent(
      await posted({ updateId: 8401, chatId: -100841, completed: true }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: createMemoryModerator(),
      },
    );
    expect(removed.decision.action).toBe("delete");
    expect(removed.decision.reasons).toContain("giveaway_notice");
    expect(removed.decision.ruleIds).toContain("giveaway_notice");
    expect(removed.decision.evidence).toEqual([
      { kind: "feature", summary: "giveaway:completed" },
    ]);
    const empty = await screenTelegramEvent(
      await posted({ updateId: 8402, chatId: -100842, empty: true }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(empty.decision.action).toBe("allow");
    const paidModerator = createMemoryModerator();
    const skipped = await screenTelegramEvent(
      await posted({
        updateId: 8403,
        chatId: -100843,
        created: true,
        paid: true,
      }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: paidModerator,
      },
    );
    expect(skipped.decision.action).toBe("delete");
    expect(skipped.actionResults).toContainEqual({
      actionId: "delete",
      status: "skipped",
      detail: "paid_post",
    });
    expect(paidModerator.deleted).toEqual([]);
    const dumped = JSON.stringify({
      removed: removed.decision,
      empty: empty.decision,
      skipped: skipped.decision,
    });
    expect(dumped).not.toContain(prize);
    expect(dumped).not.toContain("gw451");
    expect(dumped).not.toContain("bit.ly");
    expect(dumped).not.toContain("开奖的人");
    expect(dumped).not.toContain("90184");
  });

  it("keeps a pin until that chat asks", async () => {
    const pinnedText = "置顶广告正文";
    const pinnedId = 90182;
    async function posted(input: {
      updateId: number;
      chatId: number;
      pinned?: boolean;
      empty?: boolean;
      paid?: boolean;
    }) {
      const normalized = await normalizeUpdate({
        update: {
          update_id: input.updateId,
          message: {
            message_id: input.updateId,
            date: 1761955200,
            chat: { id: input.chatId, type: "supergroup" },
            from: { id: 96 },
            ...(input.paid ? { is_paid_post: true } : {}),
            ...(input.pinned
              ? {
                  pinned_message: {
                    message_id: pinnedId,
                    text: `${pinnedText} https://bit.ly/pin450`,
                    from: { id: 97, first_name: "置顶的人" },
                  },
                }
              : {}),
            ...(input.empty ? { pinned_message: {} } : {}),
          },
        },
        tenantId: "local",
        adminUserIds: [],
        nowIso: "2026-11-01T00:00:00.000Z",
      });
      expect(normalized.status).toBe("event");
      if (normalized.status !== "event") {
        throw new Error("expected event");
      }
      return normalized.event;
    }
    const idle = await posted({
      updateId: 8300,
      chatId: -100830,
      pinned: true,
    });
    expect(idle.message?.asPin).toBe(true);
    expect(idle.message?.text).toBe("");
    expect(JSON.stringify(idle)).not.toContain(pinnedText);
    expect(JSON.stringify(idle)).not.toContain("90182");
    const allowed = await screenTelegramEvent(idle, {
      rateWindow: createMemoryRateWindow(),
    });
    expect(allowed.decision.action).toBe("allow");
    const source: RuleSource = {
      async loadChat() {
        return {
          version: 1,
          aggregate: "max",
          rules: [
            {
              id: "pin_notice",
              enabled: true,
              when: { eventKind: "message" },
              detectorIds: ["pin_notice"],
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
    const removed = await screenTelegramEvent(
      await posted({ updateId: 8301, chatId: -100831, pinned: true }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: createMemoryModerator(),
      },
    );
    expect(removed.decision.action).toBe("delete");
    expect(removed.decision.reasons).toContain("pin_notice");
    expect(removed.decision.ruleIds).toContain("pin_notice");
    expect(removed.decision.evidence).toEqual([
      { kind: "feature", summary: "pin:notice" },
    ]);
    const empty = await screenTelegramEvent(
      await posted({ updateId: 8302, chatId: -100832, empty: true }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(empty.decision.action).toBe("allow");
    const paidModerator = createMemoryModerator();
    const skipped = await screenTelegramEvent(
      await posted({
        updateId: 8303,
        chatId: -100833,
        pinned: true,
        paid: true,
      }),
      {
        source,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
        moderator: paidModerator,
      },
    );
    expect(skipped.decision.action).toBe("delete");
    expect(skipped.actionResults).toContainEqual({
      actionId: "delete",
      status: "skipped",
      detail: "paid_post",
    });
    expect(paidModerator.deleted).toEqual([]);
    const dumped = JSON.stringify({
      removed: removed.decision,
      empty: empty.decision,
      skipped: skipped.decision,
    });
    expect(dumped).not.toContain(pinnedText);
    expect(dumped).not.toContain("pin450");
    expect(dumped).not.toContain("bit.ly");
    expect(dumped).not.toContain("置顶的人");
    expect(dumped).not.toContain("90182");
  });

  it("keeps a linked channel mirror and still deletes its short link", async () => {
    const phrase = "请免费领取礼品";
    const title = "机密频道";
    const mirror = await normalizeUpdate({
      update: {
        update_id: 4810,
        message: {
          message_id: 12,
          date: 1761955200,
          chat: { id: -100890, type: "supergroup" },
          from: { id: 8910 },
          text: "今天站会",
          is_automatic_forward: true,
          sender_chat: { id: -1008900, type: "channel", title },
          forward_origin: {
            type: "channel",
            date: 1761955200,
            chat: {
              id: -1008900,
              type: "channel",
              title: `https://bit.ly/${title}`,
            },
          },
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(mirror.status).toBe("event");
    if (mirror.status !== "event") {
      return;
    }
    expect(mirror.event.message?.forward).toBeUndefined();
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const kept = await screenTelegramEvent(mirror.event, {
      logger,
      moderator,
      rateWindow: createMemoryRateWindow(),
    });
    expect(kept.decision.action).toBe("allow");
    expect(kept.decision.reasons).not.toContain("forward_channel");
    expect(moderator.deleted).toEqual([]);
    const logged = JSON.stringify(logger.entries);
    expect(logged).not.toContain(phrase);
    expect(logged).not.toContain(title);
    expect(logged).not.toContain("bit.ly");

    const spam = await normalizeUpdate({
      update: {
        update_id: 4811,
        message: {
          message_id: 13,
          date: 1761955200,
          chat: { id: -100891, type: "supergroup" },
          from: { id: 8911 },
          text: `${phrase} https://bit.ly/ad891`,
          is_automatic_forward: true,
          forward_origin: {
            type: "channel",
            date: 1761955200,
            chat: { id: -1008910, type: "channel", title },
          },
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(spam.status).toBe("event");
    if (spam.status !== "event") {
      return;
    }
    expect(spam.event.message?.forward).toBeUndefined();
    const spamLog = createMemoryLogger();
    const spamModerator = createMemoryModerator();
    const removed = await screenTelegramEvent(spam.event, {
      logger: spamLog,
      moderator: spamModerator,
      rateWindow: createMemoryRateWindow(),
    });
    expect(removed.decision.action).toBe("delete");
    expect(removed.decision.reasons).toContain("keyword_match");
    expect(removed.decision.reasons).not.toContain("forward_channel");
    expect(spamModerator.deleted).toEqual([
      { tenantId: "local", chatId: "-100891", messageId: "13" },
    ]);
    const spamLogged = JSON.stringify(spamLog.entries);
    expect(spamLogged).not.toContain(phrase);
    expect(spamLogged).not.toContain(title);
    expect(spamLogged).not.toContain("ad891");
  });

  it("deletes a short link written on a linked channel mirror's author signature", async () => {
    const phrase = "请免费领取礼品";
    const title = "机密频道";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 4937,
        message: {
          message_id: 15,
          date: 1761955200,
          chat: { id: -100893, type: "supergroup" },
          from: { id: 8913 },
          text: "今天站会",
          is_automatic_forward: true,
          sender_chat: { id: -1008930, type: "channel", title },
          forward_origin: {
            type: "channel",
            date: 1761955200,
            chat: {
              id: -1008930,
              type: "channel",
              title: `https://example.com/${title}`,
            },
            author_signature: `${phrase} https://bit.ly/ad893`,
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
    expect(outcome.event.message?.forward).toBeUndefined();
    expect(outcome.event.message?.hosts).toEqual(["bit.ly"]);
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const removed = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
      rateWindow: createMemoryRateWindow(),
    });
    expect(removed.decision.action).toBe("delete");
    expect(removed.decision.reasons).toContain("short_link");
    expect(removed.decision.reasons).not.toContain("forward_channel");
    expect(moderator.deleted).toEqual([
      { tenantId: "local", chatId: "-100893", messageId: "15" },
    ]);
    const logged = JSON.stringify(logger.entries);
    expect(logged).not.toContain(phrase);
    expect(logged).not.toContain(title);
    expect(logged).not.toContain("ad893");

    const words = await normalizeUpdate({
      update: {
        update_id: 4938,
        message: {
          message_id: 16,
          date: 1761955200,
          chat: { id: -100894, type: "supergroup" },
          from: { id: 8914 },
          text: "今天站会",
          is_automatic_forward: true,
          forward_origin: {
            type: "channel",
            date: 1761955200,
            chat: { id: -1008940, type: "channel", title },
            author_signature: phrase,
          },
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(words.status).toBe("event");
    if (words.status !== "event") {
      return;
    }
    expect(words.event.message?.text).toBe("今天站会");
    const wordLog = createMemoryLogger();
    const wordModerator = createMemoryModerator();
    const kept = await screenTelegramEvent(words.event, {
      logger: wordLog,
      moderator: wordModerator,
      rateWindow: createMemoryRateWindow(),
    });
    expect(kept.decision.action).toBe("allow");
    expect(wordModerator.deleted).toEqual([]);
    const wordLogged = JSON.stringify(wordLog.entries);
    expect(wordLogged).not.toContain(phrase);
    expect(wordLogged).not.toContain(title);

    const only = await normalizeUpdate({
      update: {
        update_id: 4939,
        message: {
          message_id: 17,
          date: 1761955200,
          chat: { id: -100895, type: "supergroup" },
          from: { id: 8915 },
          photo: [
            {
              file_id: "ph-4939",
              file_unique_id: "ph-4939",
              width: 1,
              height: 1,
            },
          ],
          is_automatic_forward: true,
          forward_origin: {
            type: "channel",
            date: 1761955200,
            chat: { id: -1008950, type: "channel", title },
            author_signature: phrase,
          },
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(only.status).toBe("event");
    if (only.status !== "event") {
      return;
    }
    expect(only.event.message?.text).toBe(phrase);
    const onlyLog = createMemoryLogger();
    const onlyModerator = createMemoryModerator();
    const named = await screenTelegramEvent(only.event, {
      logger: onlyLog,
      moderator: onlyModerator,
      rateWindow: createMemoryRateWindow(),
    });
    expect(named.decision.action).toBe("delete");
    expect(named.decision.reasons).toContain("keyword_match");
    expect(named.decision.reasons).not.toContain("forward_channel");
    expect(onlyModerator.deleted).toEqual([
      { tenantId: "local", chatId: "-100895", messageId: "17" },
    ]);
    const onlyLogged = JSON.stringify(onlyLog.entries);
    expect(onlyLogged).not.toContain(phrase);
    expect(onlyLogged).not.toContain(title);
    expect(onlyLogged).not.toContain("ph-4939");
  });

  it("deletes a short link written on the name drawn for a guest bot reply", async () => {
    const phrase = "请免费领取礼品";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 4947,
        message: {
          message_id: 25,
          date: 1761955200,
          chat: { id: -100903, type: "supergroup" },
          from: { id: 8923, first_name: phrase },
          text: "今天站会",
          guest_bot_caller_user: {
            id: 89230,
            is_bot: false,
            first_name: `${phrase} https://bit.ly/ad903`,
            last_name: "https://tinyurl.com/last903",
            username: "cutt.ly",
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
    expect(outcome.event.message?.text).toBe("今天站会");
    expect(outcome.event.message?.hosts).toEqual(["bit.ly"]);
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const removed = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
      rateWindow: createMemoryRateWindow(),
    });
    expect(removed.decision.action).toBe("delete");
    expect(removed.decision.reasons).toContain("short_link");
    expect(moderator.deleted).toEqual([
      { tenantId: "local", chatId: "-100903", messageId: "25" },
    ]);
    const logged = JSON.stringify(logger.entries);
    expect(logged).not.toContain(phrase);
    expect(logged).not.toContain("ad903");
    expect(logged).not.toContain("last903");
    expect(logged).not.toContain("tinyurl.com");
    expect(logged).not.toContain("cutt.ly");

    const words = await normalizeUpdate({
      update: {
        update_id: 4948,
        message: {
          message_id: 26,
          date: 1761955200,
          chat: { id: -100904, type: "supergroup" },
          from: { id: 8924 },
          text: "今天站会",
          guest_bot_caller_user: {
            id: 89240,
            is_bot: false,
            first_name: phrase,
          },
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(words.status).toBe("event");
    if (words.status !== "event") {
      return;
    }
    expect(words.event.message?.text).toBe("今天站会");
    expect(words.event.message?.hosts).toBeUndefined();
    const wordLog = createMemoryLogger();
    const wordModerator = createMemoryModerator();
    const kept = await screenTelegramEvent(words.event, {
      logger: wordLog,
      moderator: wordModerator,
      rateWindow: createMemoryRateWindow(),
    });
    expect(kept.decision.action).toBe("allow");
    expect(wordModerator.deleted).toEqual([]);
    const wordLogged = JSON.stringify(wordLog.entries);
    expect(wordLogged).not.toContain(phrase);
  });

  it("deletes a short link written on a login button's forwarded label", async () => {
    const phrase = "请免费领取礼品";
    const outcome = await normalizeUpdate({
      update: {
        update_id: 4923,
        message: {
          message_id: 14,
          date: 1761955200,
          chat: { id: -100892, type: "supergroup" },
          from: { id: 8912 },
          text: "今天站会",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "登录",
                  login_url: {
                    url: "https://example.com/login892",
                    forward_text: `${phrase} https://bit.ly/ad892`,
                    bot_username: phrase,
                  },
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
    expect(outcome.event.message?.hosts).toEqual(["example.com", "bit.ly"]);
    const logger = createMemoryLogger();
    const moderator = createMemoryModerator();
    const result = await screenTelegramEvent(outcome.event, {
      logger,
      moderator,
      rateWindow: createMemoryRateWindow(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toContain("short_link");
    expect(moderator.deleted).toEqual([
      { tenantId: "local", chatId: "-100892", messageId: "14" },
    ]);
    const logged = JSON.stringify(logger.entries);
    expect(logged).not.toContain(phrase);
    expect(logged).not.toContain("ad892");
    expect(logged).not.toContain("login892");
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
      { ...(await event(phrase, false, "-100584")), id: "tg_2" },
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

  it("reads a folder username draft and leaves an invite code", async () => {
    const path = "offer219";
    const slug = "slug.219";
    const opened = await normalizeUpdate({
      update: {
        update_id: 2355,
        message: {
          message_id: 2355,
          date: 1761955200,
          chat: { id: -1008313, type: "supergroup", title: "机密群名" },
          from: { id: 219, first_name: "Ada" },
          text: `https://t.me/folder?text=https://bit.ly/${path}`,
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
        update_id: 2356,
        message: {
          message_id: 2356,
          date: 1761955200,
          chat: { id: -1008314, type: "supergroup", title: "机密群名" },
          from: { id: 219, first_name: "https://tinyurl.com/from219" },
          text: `https://t.me/folder/${slug}?text=https://bit.ly/${path}`,
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
    expect(appDump).not.toContain("from219");
    expect(appDump).not.toContain("机密群名");
  });

  it("reads an addlist username draft and leaves a list slug", async () => {
    const path = "offer220";
    const slug = "slug.220";
    const opened = await normalizeUpdate({
      update: {
        update_id: 2357,
        message: {
          message_id: 2357,
          date: 1761955200,
          chat: { id: -1008316, type: "supergroup", title: "机密群名" },
          from: { id: 220, first_name: "Ada" },
          text: `https://t.me/addlist?text=https://bit.ly/${path}`,
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
        update_id: 2358,
        message: {
          message_id: 2358,
          date: 1761955200,
          chat: { id: -1008317, type: "supergroup", title: "机密群名" },
          from: { id: 220, first_name: "https://tinyurl.com/from220" },
          text: `https://t.me/AddList/${slug}?text=https://bit.ly/${path}`,
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
    expect(appDump).not.toContain("from220");
    expect(appDump).not.toContain("机密群名");
  });

  it("reads a joinchat username draft and leaves an invite code", async () => {
    const path = "offer221";
    const slug = "slug.221";
    const opened = await normalizeUpdate({
      update: {
        update_id: 2359,
        message: {
          message_id: 2359,
          date: 1761955200,
          chat: { id: -1008319, type: "supergroup", title: "机密群名" },
          from: { id: 221, first_name: "Ada" },
          text: `https://t.me/joinchat?text=https://bit.ly/${path}`,
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
        update_id: 2360,
        message: {
          message_id: 2360,
          date: 1761955200,
          chat: { id: -1008320, type: "supergroup", title: "机密群名" },
          from: { id: 221, first_name: "https://tinyurl.com/from221" },
          text: `https://t.me/JoinChat/${slug}?text=https://bit.ly/${path}`,
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
    expect(appDump).not.toContain("from221");
    expect(appDump).not.toContain("机密群名");
  });

  it("reads an m username draft and leaves a business chat slug", async () => {
    const path = "offer222";
    const slug = "slug.222";
    const opened = await normalizeUpdate({
      update: {
        update_id: 2361,
        message: {
          message_id: 2361,
          date: 1761955200,
          chat: { id: -1008322, type: "supergroup", title: "机密群名" },
          from: { id: 222, first_name: "Ada" },
          text: `https://t.me/m?text=https://bit.ly/${path}`,
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
        update_id: 2362,
        message: {
          message_id: 2362,
          date: 1761955200,
          chat: { id: -1008323, type: "supergroup", title: "机密群名" },
          from: { id: 222, first_name: "https://tinyurl.com/from222" },
          text: `https://t.me/M/${slug}?text=https://bit.ly/${path}`,
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
    expect(deleted.decision.reasons).toEqual(["invite", "short_link"]);
    const appDump = JSON.stringify({
      result: deleted,
      logs: appLogger.entries,
    });
    expect(appDump).not.toContain(path);
    expect(appDump).not.toContain(slug);
    expect(appDump).not.toContain("from222");
    expect(appDump).not.toContain("机密群名");
  });

  it("reads a c username draft and leaves a private post", async () => {
    const path = "offer223";
    const slug = "slug.223";
    const opened = await normalizeUpdate({
      update: {
        update_id: 2363,
        message: {
          message_id: 2363,
          date: 1761955200,
          chat: { id: -1008325, type: "supergroup", title: "机密群名" },
          from: { id: 223, first_name: "Ada" },
          text: `https://t.me/c?text=https://bit.ly/${path}`,
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
        update_id: 2364,
        message: {
          message_id: 2364,
          date: 1761955200,
          chat: { id: -1008326, type: "supergroup", title: "机密群名" },
          from: { id: 223, first_name: "https://tinyurl.com/from223" },
          text: `https://t.me/C/${slug}?text=https://bit.ly/${path}`,
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
    expect(appDump).not.toContain("from223");
    expect(appDump).not.toContain("机密群名");
  });

  it("reads an iv username draft including an app name", async () => {
    const path = "offer224";
    const slug = "slug.224";
    const opened = await normalizeUpdate({
      update: {
        update_id: 2365,
        message: {
          message_id: 2365,
          date: 1761955200,
          chat: { id: -1008328, type: "supergroup", title: "机密群名" },
          from: { id: 224, first_name: "Ada" },
          text: `https://t.me/iv/slug224?text=https://bit.ly/${path}`,
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
    expect(dumped).not.toContain("slug224");
    expect(dumped).not.toContain("机密群名");

    const openedApp = await normalizeUpdate({
      update: {
        update_id: 2366,
        message: {
          message_id: 2366,
          date: 1761955200,
          chat: { id: -1008329, type: "supergroup", title: "机密群名" },
          from: { id: 224, first_name: "https://tinyurl.com/from224" },
          text: `https://t.me/Iv/${slug}?text=https://bit.ly/${path}`,
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
    expect(appDump).not.toContain("from224");
    expect(appDump).not.toContain("机密群名");
  });

  it("reads a confirmphone username draft and leaves the phone check", async () => {
    const path = "offer225";
    const slug = "slug.225";
    const opened = await normalizeUpdate({
      update: {
        update_id: 2367,
        message: {
          message_id: 2367,
          date: 1761955200,
          chat: { id: -1008331, type: "supergroup", title: "机密群名" },
          from: { id: 225, first_name: "Ada" },
          text: `https://t.me/confirmphone/slug225?text=https://bit.ly/${path}`,
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
    expect(dumped).not.toContain("slug225");
    expect(dumped).not.toContain("机密群名");

    const openedApp = await normalizeUpdate({
      update: {
        update_id: 2368,
        message: {
          message_id: 2368,
          date: 1761955200,
          chat: { id: -1008332, type: "supergroup", title: "机密群名" },
          from: { id: 225, first_name: "https://tinyurl.com/from225" },
          text: `https://t.me/ConfirmPhone/${slug}?text=https://bit.ly/${path}`,
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
    expect(appDump).not.toContain("from225");
    expect(appDump).not.toContain("机密群名");
  });

  it("reads a proxy username draft and keeps the server check", async () => {
    const path = "offer226";
    const slug = "slug.226";
    const opened = await normalizeUpdate({
      update: {
        update_id: 2369,
        message: {
          message_id: 2369,
          date: 1761955200,
          chat: { id: -1008334, type: "supergroup", title: "机密群名" },
          from: { id: 226, first_name: "Ada" },
          text: `https://t.me/proxy/slug226?text=https://bit.ly/${path}`,
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
    expect(dumped).not.toContain("slug226");
    expect(dumped).not.toContain("机密群名");

    const openedApp = await normalizeUpdate({
      update: {
        update_id: 2370,
        message: {
          message_id: 2370,
          date: 1761955200,
          chat: { id: -1008335, type: "supergroup", title: "机密群名" },
          from: { id: 226, first_name: "https://tinyurl.com/from226" },
          text: `https://t.me/Proxy/${slug}?text=https://bit.ly/${path}`,
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
    expect(appDump).not.toContain("from226");
    expect(appDump).not.toContain("机密群名");
  });

  it("reads a socks username draft and keeps the server check", async () => {
    const path = "offer227";
    const slug = "slug.227";
    const opened = await normalizeUpdate({
      update: {
        update_id: 2371,
        message: {
          message_id: 2371,
          date: 1761955200,
          chat: { id: -1008337, type: "supergroup", title: "机密群名" },
          from: { id: 227, first_name: "Ada" },
          text: `https://t.me/socks/slug227?text=https://bit.ly/${path}`,
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
    expect(dumped).not.toContain("slug227");
    expect(dumped).not.toContain("机密群名");

    const openedApp = await normalizeUpdate({
      update: {
        update_id: 2372,
        message: {
          message_id: 2372,
          date: 1761955200,
          chat: { id: -1008338, type: "supergroup", title: "机密群名" },
          from: { id: 227, first_name: "https://tinyurl.com/from227" },
          text: `https://t.me/Socks/${slug}?text=https://bit.ly/${path}`,
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
    expect(appDump).not.toContain("from227");
    expect(appDump).not.toContain("机密群名");
  });

  it("reads a webproxy username draft and keeps the server check", async () => {
    const path = "offer228";
    const slug = "slug.228";
    const opened = await normalizeUpdate({
      update: {
        update_id: 2373,
        message: {
          message_id: 2373,
          date: 1761955200,
          chat: { id: -1008340, type: "supergroup", title: "机密群名" },
          from: { id: 228, first_name: "Ada" },
          text: `https://t.me/webproxy/slug228?text=https://bit.ly/${path}`,
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
    expect(dumped).not.toContain("slug228");
    expect(dumped).not.toContain("机密群名");

    const openedApp = await normalizeUpdate({
      update: {
        update_id: 2374,
        message: {
          message_id: 2374,
          date: 1761955200,
          chat: { id: -1008341, type: "supergroup", title: "机密群名" },
          from: { id: 228, first_name: "https://tinyurl.com/from228" },
          text: `https://t.me/WebProxy/${slug}?text=https://bit.ly/${path}`,
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
    expect(appDump).not.toContain("from228");
    expect(appDump).not.toContain("机密群名");
  });

  it("reads a capital S username draft and leaves the preview", async () => {
    const path = "offer229";
    const slug = "slug.229";
    const opened = await normalizeUpdate({
      update: {
        update_id: 2375,
        message: {
          message_id: 2375,
          date: 1761955200,
          chat: { id: -1008343, type: "supergroup", title: "机密群名" },
          from: { id: 229, first_name: "Ada" },
          text: `https://t.me/S?text=https://bit.ly/${path}`,
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
        update_id: 2376,
        message: {
          message_id: 2376,
          date: 1761955200,
          chat: { id: -1008344, type: "supergroup", title: "机密群名" },
          from: { id: 229, first_name: "https://tinyurl.com/from229" },
          text: `https://t.me/S/${slug}?text=https://bit.ly/${path}`,
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
    expect(appDump).not.toContain("from229");
    expect(appDump).not.toContain("机密群名");
  });

  it("reads a short link after a query plus and keeps a literal plus", async () => {
    const path = "offer230";
    const opened = await normalizeUpdate({
      update: {
        update_id: 2377,
        message: {
          message_id: 2377,
          date: 1761955200,
          chat: { id: -1008346, type: "supergroup", title: "机密群名" },
          from: { id: 230, first_name: "Ada" },
          text: `https://t.me/durov?text=https://example.com/a+http://bit.ly/${path}`,
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

    const shared = await normalizeUpdate({
      update: {
        update_id: 2378,
        message: {
          message_id: 2378,
          date: 1761955200,
          chat: { id: -1008347, type: "supergroup", title: "机密群名" },
          from: { id: 230, first_name: "Ada" },
          text: `tg://msg_url?url=https://example.com/a+http://bit.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(shared.status).toBe("event");
    if (shared.status !== "event") {
      return;
    }
    const sharedLogger = createMemoryLogger();
    const sharedModerator = createMemoryModerator();
    const deleted = await screenTelegramEvent(shared.event, {
      logger: sharedLogger,
      moderator: sharedModerator,
    });
    expect(deleted.decision.action).toBe("delete");
    expect(deleted.decision.reasons).toEqual(["short_link"]);
    const sharedDump = JSON.stringify({
      result: deleted,
      logs: sharedLogger.entries,
    });
    expect(sharedDump).not.toContain(path);
    expect(sharedDump).not.toContain("机密群名");

    const glued = await normalizeUpdate({
      update: {
        update_id: 2379,
        message: {
          message_id: 2379,
          date: 1761955200,
          chat: { id: -1008348, type: "supergroup", title: "机密群名" },
          from: { id: 230, first_name: "Ada" },
          text: `https://example.com/a+http://bit.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(glued.status).toBe("event");
    if (glued.status !== "event") {
      return;
    }
    const kept = await screenTelegramEvent(glued.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(kept.decision.action).toBe("allow");
    expect(JSON.stringify(kept.decision)).not.toContain(path);
    expect(JSON.stringify(kept.decision)).not.toContain("bit.ly");

    const encoded = await normalizeUpdate({
      update: {
        update_id: 2380,
        message: {
          message_id: 2380,
          date: 1761955200,
          chat: { id: -1008349, type: "supergroup", title: "机密群名" },
          from: { id: 230, first_name: "Ada" },
          text: `https://t.me/durov?text=${encodeURIComponent(`https://example.com/a+http://bit.ly/${path}`)}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(encoded.status).toBe("event");
    if (encoded.status !== "event") {
      return;
    }
    const unread = await screenTelegramEvent(encoded.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(unread.decision.action).toBe("allow");
    expect(JSON.stringify(unread.decision)).not.toContain(path);
    expect(JSON.stringify(unread.decision)).not.toContain("bit.ly");
  });

  it("reads a short link after an invalid percent in a query", async () => {
    const path = "offer231";
    const opened = await normalizeUpdate({
      update: {
        update_id: 2381,
        message: {
          message_id: 2381,
          date: 1761955200,
          chat: { id: -1008351, type: "supergroup", title: "机密群名" },
          from: { id: 231, first_name: "Ada" },
          text: `https://t.me/durov?text=http://bit.ly/%FF${path}`,
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

    const stuck = await normalizeUpdate({
      update: {
        update_id: 2382,
        message: {
          message_id: 2382,
          date: 1761955200,
          chat: { id: -1008352, type: "supergroup", title: "机密群名" },
          from: { id: 231, first_name: "Ada" },
          text: `https://t.me/durov?text=https://example.com/%2http://bit.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(stuck.status).toBe("event");
    if (stuck.status !== "event") {
      return;
    }
    const kept = await screenTelegramEvent(stuck.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(kept.decision.action).toBe("allow");
    expect(JSON.stringify(kept.decision)).not.toContain(path);
    expect(JSON.stringify(kept.decision)).not.toContain("bit.ly");
  });

  it("reads a short link in a long share url", async () => {
    const path = "offer232";
    const padding = "a".repeat(2100);
    const opened = await normalizeUpdate({
      update: {
        update_id: 2383,
        message: {
          message_id: 2383,
          date: 1761955200,
          chat: { id: -1008354, type: "supergroup", title: "机密群名" },
          from: { id: 232, first_name: "Ada" },
          text: `https://t.me/share/url?url=http://bit.ly/${path}%20${padding}`,
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
    const result = await screenTelegramEvent(opened.event, {
      logger,
      moderator: createMemoryModerator(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const later = await normalizeUpdate({
      update: {
        update_id: 2384,
        message: {
          message_id: 2384,
          date: 1761955200,
          chat: { id: -1008355, type: "supergroup", title: "机密群名" },
          from: { id: 232, first_name: "Ada" },
          text: `https://t.me/share/url?url=${padding}%20http://bit.ly/${path}`,
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(later.status).toBe("event");
    if (later.status !== "event") {
      return;
    }
    const tail = await screenTelegramEvent(later.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(tail.decision.action).toBe("delete");
    expect(tail.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(tail.decision)).not.toContain(path);
  });

  it("reads a short link in a long share text", async () => {
    const path = "offer233";
    const padding = "a".repeat(4100);
    const opened = await normalizeUpdate({
      update: {
        update_id: 2385,
        message: {
          message_id: 2385,
          date: 1761955200,
          chat: { id: -1008357, type: "supergroup", title: "机密群名" },
          from: { id: 233, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=http://bit.ly/${path}%20${padding}`,
            },
          ],
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
    const result = await screenTelegramEvent(opened.event, {
      logger,
      moderator: createMemoryModerator(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const user = await normalizeUpdate({
      update: {
        update_id: 2386,
        message: {
          message_id: 2386,
          date: 1761955200,
          chat: { id: -1008359, type: "supergroup", title: "机密群名" },
          from: { id: 233, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/durov?text=http://bit.ly/${path}%20${padding}`,
            },
          ],
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(user.status).toBe("event");
    if (user.status !== "event") {
      return;
    }
    const kept = await screenTelegramEvent(user.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(kept.decision.action).toBe("allow");
    expect(JSON.stringify(kept.decision)).not.toContain(path);
    expect(JSON.stringify(kept.decision)).not.toContain("bit.ly");
  });

  it("reads a short link after a draft stop", async () => {
    const path = "offer234";
    const opened = await normalizeUpdate({
      update: {
        update_id: 2387,
        message: {
          message_id: 2387,
          date: 1761955200,
          chat: { id: -1008360, type: "supergroup", title: "机密群名" },
          from: { id: 234, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=https://example.com/%7Chttp://bit.ly/${path}`,
            },
          ],
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
    const result = await screenTelegramEvent(opened.event, {
      logger,
      moderator: createMemoryModerator(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const stuck = await normalizeUpdate({
      update: {
        update_id: 2388,
        message: {
          message_id: 2388,
          date: 1761955200,
          chat: { id: -1008362, type: "supergroup", title: "机密群名" },
          from: { id: 234, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/durov?text=https://example.com/%2http://bit.ly/${path}`,
            },
          ],
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(stuck.status).toBe("event");
    if (stuck.status !== "event") {
      return;
    }
    const kept = await screenTelegramEvent(stuck.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(kept.decision.action).toBe("allow");
    expect(JSON.stringify(kept.decision)).not.toContain(path);
    expect(JSON.stringify(kept.decision)).not.toContain("bit.ly");
  });

  it("reads a short link after an emoji in a hidden draft", async () => {
    const path = "offer235";
    const opened = await normalizeUpdate({
      update: {
        update_id: 2389,
        message: {
          message_id: 2389,
          date: 1761955200,
          chat: { id: -1008364, type: "supergroup", title: "机密群名" },
          from: { id: 235, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=https://example.com/%F0%9F%98%80http://bit.ly/${path}`,
            },
          ],
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
    const result = await screenTelegramEvent(opened.event, {
      logger,
      moderator: createMemoryModerator(),
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
        update_id: 2390,
        message: {
          message_id: 2390,
          date: 1761955200,
          chat: { id: -1008365, type: "supergroup", title: "机密群名" },
          from: { id: 235, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=https://example.com/%F0%A0%80%80http://bit.ly/${path}`,
            },
          ],
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
    const allowed = await screenTelegramEvent(kept.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(allowed.decision.action).toBe("allow");
    expect(JSON.stringify(allowed.decision)).not.toContain(path);
    expect(JSON.stringify(allowed.decision)).not.toContain("bit.ly");
  });

  it("reads a bare ip in a hidden draft", async () => {
    const path = "offer236";
    const address = "203.0.113.236";
    const opened = await normalizeUpdate({
      update: {
        update_id: 2391,
        message: {
          message_id: 2391,
          date: 1761955200,
          chat: { id: -1008366, type: "supergroup", title: "机密群名" },
          from: { id: 236, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=${address}/${path}`,
            },
          ],
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
    const result = await screenTelegramEvent(opened.event, {
      logger,
      moderator: createMemoryModerator(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["ip_host"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      `ip_host:${address}`,
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const buried = await normalizeUpdate({
      update: {
        update_id: 2392,
        message: {
          message_id: 2392,
          date: 1761955200,
          chat: { id: -1008368, type: "supergroup", title: "机密群名" },
          from: { id: 236, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=https://example.com/${address}/${path}`,
            },
          ],
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(buried.status).toBe("event");
    if (buried.status !== "event") {
      return;
    }
    const kept = await screenTelegramEvent(buried.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(kept.decision.action).toBe("allow");
    expect(JSON.stringify(kept.decision)).not.toContain(path);
    expect(JSON.stringify(kept.decision)).not.toContain(address);
  });

  it("reads a short link after user info that is too long", async () => {
    const path = "offer237";
    const user = "a".repeat(65);
    const fitted = "a".repeat(64);
    const opened = await normalizeUpdate({
      update: {
        update_id: 2393,
        message: {
          message_id: 2393,
          date: 1761955200,
          chat: { id: -1008371, type: "supergroup", title: "机密群名" },
          from: { id: 237, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=http://${user}@http://bit.ly/${path}`,
            },
          ],
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
    const result = await screenTelegramEvent(opened.event, {
      logger,
      moderator: createMemoryModerator(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain(user);
    expect(dumped).not.toContain("机密群名");

    const within = await normalizeUpdate({
      update: {
        update_id: 2394,
        message: {
          message_id: 2394,
          date: 1761955200,
          chat: { id: -1008372, type: "supergroup", title: "机密群名" },
          from: { id: 237, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=http://${fitted}@http://bit.ly/${path}`,
            },
          ],
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(within.status).toBe("event");
    if (within.status !== "event") {
      return;
    }
    const kept = await screenTelegramEvent(within.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(kept.decision.action).toBe("allow");
    expect(JSON.stringify(kept.decision)).not.toContain(path);
    expect(JSON.stringify(kept.decision)).not.toContain("bit.ly");
    expect(JSON.stringify(kept.decision)).not.toContain(fitted);
  });

  it("reads a short link after a label that does not fit", async () => {
    const path = "offer238";
    const over = "a".repeat(59);
    const opened = await normalizeUpdate({
      update: {
        update_id: 2395,
        message: {
          message_id: 2395,
          date: 1761955200,
          chat: { id: -1008375, type: "supergroup", title: "机密群名" },
          from: { id: 238, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=http://${over}-http://bit.ly/${path}`,
            },
          ],
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
    const result = await screenTelegramEvent(opened.event, {
      logger,
      moderator: createMemoryModerator(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const fitted = "a".repeat(58);
    const within = await normalizeUpdate({
      update: {
        update_id: 2396,
        message: {
          message_id: 2396,
          date: 1761955200,
          chat: { id: -1008376, type: "supergroup", title: "机密群名" },
          from: { id: 238, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=http://${fitted}-http://bit.ly/${path}`,
            },
          ],
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(within.status).toBe("event");
    if (within.status !== "event") {
      return;
    }
    const kept = await screenTelegramEvent(within.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(kept.decision.action).toBe("allow");
    expect(JSON.stringify(kept.decision)).not.toContain(path);
    expect(JSON.stringify(kept.decision)).not.toContain("bit.ly");

    const code = "CODE238";
    const invited = await normalizeUpdate({
      update: {
        update_id: 2397,
        message: {
          message_id: 2397,
          date: 1761955200,
          chat: { id: -1008385, type: "supergroup", title: "机密群名" },
          from: { id: 238, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=http://${"a".repeat(63)}-https://t.me/%2B${code}`,
            },
          ],
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(invited.status).toBe("event");
    if (invited.status !== "event") {
      return;
    }
    const invite = await screenTelegramEvent(invited.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(invite.decision.action).toBe("delete");
    expect(invite.decision.reasons).toContain("invite");
    const inviteDump = JSON.stringify(invite.decision);
    expect(inviteDump).not.toContain(code);
    expect(inviteDump).not.toContain("机密群名");
  });

  it("reads the host before an @ that cannot finish user info", async () => {
    const path = "offer239";
    const tail = "tail239.example";
    const opened = await normalizeUpdate({
      update: {
        update_id: 2398,
        message: {
          message_id: 2398,
          date: 1761955200,
          chat: { id: -1008389, type: "supergroup", title: "机密群名" },
          from: { id: 239, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=http://bit.ly@.${tail}/${path}`,
            },
          ],
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
    const result = await screenTelegramEvent(opened.event, {
      logger,
      moderator: createMemoryModerator(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain(tail);
    expect(dumped).not.toContain("机密群名");

    const real = await normalizeUpdate({
      update: {
        update_id: 2399,
        message: {
          message_id: 2399,
          date: 1761955200,
          chat: { id: -1008391, type: "supergroup", title: "机密群名" },
          from: { id: 239, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=http://bit.ly@example.com/${path}`,
            },
          ],
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(real.status).toBe("event");
    if (real.status !== "event") {
      return;
    }
    const kept = await screenTelegramEvent(real.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(kept.decision.action).toBe("allow");
    expect(JSON.stringify(kept.decision)).not.toContain("bit.ly");
    expect(JSON.stringify(kept.decision)).not.toContain(path);

    const bang = await normalizeUpdate({
      update: {
        update_id: 2400,
        message: {
          message_id: 2400,
          date: 1761955200,
          chat: { id: -1008398, type: "supergroup", title: "机密群名" },
          from: { id: 239, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: "https://t.me/share/url?text=http://bit.ly@!",
            },
          ],
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(bang.status).toBe("event");
    if (bang.status !== "event") {
      return;
    }
    const marked = await screenTelegramEvent(bang.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(marked.decision.action).toBe("delete");
    expect(marked.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(marked.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    expect(JSON.stringify(marked.decision)).not.toContain("机密群名");
  });

  it("reads a short link after punctuation that ends the host", async () => {
    const path = "offer240";
    const opened = await normalizeUpdate({
      update: {
        update_id: 2401,
        message: {
          message_id: 2401,
          date: 1761955200,
          chat: { id: -1008401, type: "supergroup", title: "机密群名" },
          from: { id: 240, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=http://example.com!http://bit.ly/${path}`,
            },
          ],
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
    const result = await screenTelegramEvent(opened.event, {
      logger,
      moderator: createMemoryModerator(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const keptUpdate = await normalizeUpdate({
      update: {
        update_id: 2402,
        message: {
          message_id: 2402,
          date: 1761955200,
          chat: { id: -1008404, type: "supergroup", title: "机密群名" },
          from: { id: 240, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=http://example.com/!http://bit.ly/${path}`,
            },
          ],
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(keptUpdate.status).toBe("event");
    if (keptUpdate.status !== "event") {
      return;
    }
    const kept = await screenTelegramEvent(keptUpdate.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(kept.decision.action).toBe("allow");
    expect(JSON.stringify(kept.decision)).not.toContain("bit.ly");
    expect(JSON.stringify(kept.decision)).not.toContain(path);
  });

  it("reads a short link after a bare domain ends", async () => {
    const path = "offer241";
    const opened = await normalizeUpdate({
      update: {
        update_id: 2403,
        message: {
          message_id: 2403,
          date: 1761955200,
          chat: { id: -1008410, type: "supergroup", title: "机密群名" },
          from: { id: 241, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=www.example.com-http://bit.ly/${path}`,
            },
          ],
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
    const result = await screenTelegramEvent(opened.event, {
      logger,
      moderator: createMemoryModerator(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const keptUpdate = await normalizeUpdate({
      update: {
        update_id: 2404,
        message: {
          message_id: 2404,
          date: 1761955200,
          chat: { id: -1008416, type: "supergroup", title: "机密群名" },
          from: { id: 241, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=www.example.com/!http://bit.ly/${path}`,
            },
          ],
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(keptUpdate.status).toBe("event");
    if (keptUpdate.status !== "event") {
      return;
    }
    const kept = await screenTelegramEvent(keptUpdate.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(kept.decision.action).toBe("allow");
    expect(JSON.stringify(kept.decision)).not.toContain("bit.ly");
    expect(JSON.stringify(kept.decision)).not.toContain(path);
  });

  it("reads a short link after a dot that does not start a label", async () => {
    const path = "offer242";
    const opened = await normalizeUpdate({
      update: {
        update_id: 2405,
        message: {
          message_id: 2405,
          date: 1761955200,
          chat: { id: -1008424, type: "supergroup", title: "机密群名" },
          from: { id: 242, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=http://example.com.:80!http://bit.ly/${path}`,
            },
          ],
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
    const result = await screenTelegramEvent(opened.event, {
      logger,
      moderator: createMemoryModerator(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const keptUpdate = await normalizeUpdate({
      update: {
        update_id: 2406,
        message: {
          message_id: 2406,
          date: 1761955200,
          chat: { id: -1008425, type: "supergroup", title: "机密群名" },
          from: { id: 242, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=http://example.com._http://bit.ly/${path}`,
            },
          ],
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(keptUpdate.status).toBe("event");
    if (keptUpdate.status !== "event") {
      return;
    }
    const kept = await screenTelegramEvent(keptUpdate.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(kept.decision.action).toBe("allow");
    expect(JSON.stringify(kept.decision)).not.toContain("bit.ly");
    expect(JSON.stringify(kept.decision)).not.toContain(path);
  });

  it("keeps a question mark on the bare host in a hidden draft", async () => {
    const path = "offer243";
    const opened = await normalizeUpdate({
      update: {
        update_id: 2407,
        message: {
          message_id: 2407,
          date: 1761955200,
          chat: { id: -1008433, type: "supergroup", title: "机密群名" },
          from: { id: 243, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=bit.ly?http://t.co/${path}`,
            },
          ],
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
    const result = await screenTelegramEvent(opened.event, {
      logger,
      moderator: createMemoryModerator(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain("t.co");
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const keptUpdate = await normalizeUpdate({
      update: {
        update_id: 2408,
        message: {
          message_id: 2408,
          date: 1761955200,
          chat: { id: -1008430, type: "supergroup", title: "机密群名" },
          from: { id: 243, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=example.com?http://bit.ly/${path}`,
            },
          ],
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(keptUpdate.status).toBe("event");
    if (keptUpdate.status !== "event") {
      return;
    }
    const kept = await screenTelegramEvent(keptUpdate.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(kept.decision.action).toBe("allow");
    expect(JSON.stringify(kept.decision)).not.toContain("bit.ly");
    expect(JSON.stringify(kept.decision)).not.toContain(path);
  });

  it("reads a short link after tg: without slashes", async () => {
    const path = "offer244";
    const opened = await normalizeUpdate({
      update: {
        update_id: 2409,
        message: {
          message_id: 2409,
          date: 1761955200,
          chat: { id: -1008439, type: "supergroup", title: "机密群名" },
          from: { id: 244, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=tg:http://bit.ly/${path}`,
            },
          ],
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
    const result = await screenTelegramEvent(opened.event, {
      logger,
      moderator: createMemoryModerator(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const keptUpdate = await normalizeUpdate({
      update: {
        update_id: 2410,
        message: {
          message_id: 2410,
          date: 1761955200,
          chat: { id: -1008442, type: "supergroup", title: "机密群名" },
          from: { id: 244, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=tg://http://bit.ly/${path}`,
            },
          ],
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(keptUpdate.status).toBe("event");
    if (keptUpdate.status !== "event") {
      return;
    }
    const kept = await screenTelegramEvent(keptUpdate.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(kept.decision.action).toBe("allow");
    expect(JSON.stringify(kept.decision)).not.toContain("bit.ly");
    expect(JSON.stringify(kept.decision)).not.toContain(path);
  });

  it("keeps a path apostrophe inside one hidden draft", async () => {
    const path = "offer245";
    const opened = await normalizeUpdate({
      update: {
        update_id: 2411,
        message: {
          message_id: 2411,
          date: 1761955200,
          chat: { id: -1008455, type: "supergroup", title: "机密群名" },
          from: { id: 245, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=example.com'bit.ly/${path}`,
            },
          ],
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
    const result = await screenTelegramEvent(opened.event, {
      logger,
      moderator: createMemoryModerator(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const keptUpdate = await normalizeUpdate({
      update: {
        update_id: 2412,
        message: {
          message_id: 2412,
          date: 1761955200,
          chat: { id: -1008448, type: "supergroup", title: "机密群名" },
          from: { id: 245, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=http://example.com/'http://bit.ly/${path}`,
            },
          ],
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(keptUpdate.status).toBe("event");
    if (keptUpdate.status !== "event") {
      return;
    }
    const kept = await screenTelegramEvent(keptUpdate.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(kept.decision.action).toBe("allow");
    expect(JSON.stringify(kept.decision)).not.toContain("bit.ly");
    expect(JSON.stringify(kept.decision)).not.toContain(path);
  });

  it("keeps a label space inside one hidden draft", async () => {
    const path = "offer246";
    const opened = await normalizeUpdate({
      update: {
        update_id: 2413,
        message: {
          message_id: 2413,
          date: 1761955200,
          chat: { id: -1008468, type: "supergroup", title: "机密群名" },
          from: { id: 246, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=http://example.com/\u00A0http://bit.ly/${path}`,
            },
          ],
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
    const result = await screenTelegramEvent(opened.event, {
      logger,
      moderator: createMemoryModerator(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const keptUpdate = await normalizeUpdate({
      update: {
        update_id: 2414,
        message: {
          message_id: 2414,
          date: 1761955200,
          chat: { id: -1008461, type: "supergroup", title: "机密群名" },
          from: { id: 246, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=http://example.com/\u1680http://bit.ly/${path}`,
            },
          ],
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(keptUpdate.status).toBe("event");
    if (keptUpdate.status !== "event") {
      return;
    }
    const kept = await screenTelegramEvent(keptUpdate.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(kept.decision.action).toBe("allow");
    expect(JSON.stringify(kept.decision)).not.toContain("bit.ly");
    expect(JSON.stringify(kept.decision)).not.toContain(path);
  });

  it("reads the host before a division slash in a hidden draft", async () => {
    const path = "offer247";
    const slash = "\u2215";
    const opened = await normalizeUpdate({
      update: {
        update_id: 2415,
        message: {
          message_id: 2415,
          date: 1761955200,
          chat: { id: -1008475, type: "supergroup", title: "机密群名" },
          from: { id: 247, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?url=http://bit.ly${slash}@example.com/${path}`,
            },
          ],
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
    const result = await screenTelegramEvent(opened.event, {
      logger,
      moderator: createMemoryModerator(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const keptUpdate = await normalizeUpdate({
      update: {
        update_id: 2416,
        message: {
          message_id: 2416,
          date: 1761955200,
          chat: { id: -1008474, type: "supergroup", title: "机密群名" },
          from: { id: 247, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: "https://t.me/share/url?text=http://bit.ly，广告",
            },
          ],
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(keptUpdate.status).toBe("event");
    if (keptUpdate.status !== "event") {
      return;
    }
    const kept = await screenTelegramEvent(keptUpdate.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(kept.decision.action).toBe("allow");
    expect(JSON.stringify(kept.decision)).not.toContain("bit.ly");
  });

  it("reads a short link after a dot on a bare www host", async () => {
    const path = "offer248";
    const opened = await normalizeUpdate({
      update: {
        update_id: 2417,
        message: {
          message_id: 2417,
          date: 1761955200,
          chat: { id: -1008476, type: "supergroup", title: "机密群名" },
          from: { id: 248, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=www.example.com./http://bit.ly/${path}`,
            },
          ],
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
    const result = await screenTelegramEvent(opened.event, {
      logger,
      moderator: createMemoryModerator(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const keptUpdate = await normalizeUpdate({
      update: {
        update_id: 2418,
        message: {
          message_id: 2418,
          date: 1761955200,
          chat: { id: -1008482, type: "supergroup", title: "机密群名" },
          from: { id: 248, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=http://www.example.com./http://bit.ly/${path}`,
            },
          ],
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(keptUpdate.status).toBe("event");
    if (keptUpdate.status !== "event") {
      return;
    }
    const kept = await screenTelegramEvent(keptUpdate.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(kept.decision.action).toBe("allow");
    expect(JSON.stringify(kept.decision)).not.toContain("bit.ly");
    expect(JSON.stringify(kept.decision)).not.toContain(path);
  });

  it("reads a short link after a suffix Android does not treat as a TLD", async () => {
    const path = "offer249";
    const opened = await normalizeUpdate({
      update: {
        update_id: 2419,
        message: {
          message_id: 2419,
          date: 1761955200,
          chat: { id: -1008487, type: "supergroup", title: "机密群名" },
          from: { id: 249, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=foo.example/http://bit.ly/${path}`,
            },
          ],
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
    const result = await screenTelegramEvent(opened.event, {
      logger,
      moderator: createMemoryModerator(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const keptUpdate = await normalizeUpdate({
      update: {
        update_id: 2420,
        message: {
          message_id: 2420,
          date: 1761955200,
          chat: { id: -1008492, type: "supergroup", title: "机密群名" },
          from: { id: 249, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=example.com/http://bit.ly/${path}`,
            },
          ],
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(keptUpdate.status).toBe("event");
    if (keptUpdate.status !== "event") {
      return;
    }
    const kept = await screenTelegramEvent(keptUpdate.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(kept.decision.action).toBe("allow");
    expect(JSON.stringify(kept.decision)).not.toContain("bit.ly");
    expect(JSON.stringify(kept.decision)).not.toContain(path);
  });

  it("keeps an underscore inside a bare draft label", async () => {
    const path = "offer250";
    const opened = await normalizeUpdate({
      update: {
        update_id: 2421,
        message: {
          message_id: 2421,
          date: 1761955200,
          chat: { id: -1008502, type: "supergroup", title: "机密群名" },
          from: { id: 250, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=foo_.com/http://bit.ly/${path}`,
            },
          ],
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
    const result = await screenTelegramEvent(opened.event, {
      logger,
      moderator: createMemoryModerator(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const keptUpdate = await normalizeUpdate({
      update: {
        update_id: 2422,
        message: {
          message_id: 2422,
          date: 1761955200,
          chat: { id: -1008500, type: "supergroup", title: "机密群名" },
          from: { id: 250, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=foo_bar.com/http://bit.ly/${path}`,
            },
          ],
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(keptUpdate.status).toBe("event");
    if (keptUpdate.status !== "event") {
      return;
    }
    const kept = await screenTelegramEvent(keptUpdate.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(kept.decision.action).toBe("allow");
    expect(JSON.stringify(kept.decision)).not.toContain("bit.ly");
    expect(JSON.stringify(kept.decision)).not.toContain(path);
  });

  it("keeps a bridged bare label in a hidden draft", async () => {
    const path = "offer251";
    const opened = await normalizeUpdate({
      update: {
        update_id: 2423,
        message: {
          message_id: 2423,
          date: 1761955200,
          chat: { id: -1008513, type: "supergroup", title: "机密群名" },
          from: { id: 251, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=例_.com/http://bit.ly/${path}`,
            },
          ],
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
    const result = await screenTelegramEvent(opened.event, {
      logger,
      moderator: createMemoryModerator(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain("机密群名");

    const keptUpdate = await normalizeUpdate({
      update: {
        update_id: 2424,
        message: {
          message_id: 2424,
          date: 1761955200,
          chat: { id: -1008509, type: "supergroup", title: "机密群名" },
          from: { id: 251, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=例_foo.com/http://bit.ly/${path}`,
            },
          ],
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(keptUpdate.status).toBe("event");
    if (keptUpdate.status !== "event") {
      return;
    }
    const kept = await screenTelegramEvent(keptUpdate.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(kept.decision.action).toBe("allow");
    expect(JSON.stringify(kept.decision)).not.toContain("bit.ly");
    expect(JSON.stringify(kept.decision)).not.toContain(path);
  });

  it("keeps a short link after a letter that ends a bare host", async () => {
    const path = "offer252";
    const letter = "\u03b1";
    const opened = await normalizeUpdate({
      update: {
        update_id: 2425,
        message: {
          message_id: 2425,
          date: 1761955200,
          chat: { id: -1008520, type: "supergroup", title: "机密群名" },
          from: { id: 252, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=example.com${letter}/http://bit.ly/${path}`,
            },
          ],
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
    const result = await screenTelegramEvent(opened.event, {
      logger,
      moderator: createMemoryModerator(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain(letter);
    expect(dumped).not.toContain("机密群名");

    const keptUpdate = await normalizeUpdate({
      update: {
        update_id: 2426,
        message: {
          message_id: 2426,
          date: 1761955200,
          chat: { id: -1008525, type: "supergroup", title: "机密群名" },
          from: { id: 252, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=http://example.com${letter}/http://bit.ly/${path}`,
            },
          ],
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(keptUpdate.status).toBe("event");
    if (keptUpdate.status !== "event") {
      return;
    }
    const kept = await screenTelegramEvent(keptUpdate.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(kept.decision.action).toBe("allow");
    expect(JSON.stringify(kept.decision)).not.toContain("bit.ly");
    expect(JSON.stringify(kept.decision)).not.toContain(path);
  });

  it("keeps a dot lookalike that follows an ascii dot inside one draft url", async () => {
    const path = "offer253";
    const fullwidth = "\uFF0E";
    const opened = await normalizeUpdate({
      update: {
        update_id: 2427,
        message: {
          message_id: 2427,
          date: 1761955200,
          chat: { id: -1008537, type: "supergroup", title: "机密群名" },
          from: { id: 253, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=www.example.com.${fullwidth}http://bit.ly/${path}`,
            },
          ],
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
    const result = await screenTelegramEvent(opened.event, {
      logger,
      moderator: createMemoryModerator(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain(fullwidth);
    expect(dumped).not.toContain("机密群名");

    const keptUpdate = await normalizeUpdate({
      update: {
        update_id: 2428,
        message: {
          message_id: 2428,
          date: 1761955200,
          chat: { id: -1008532, type: "supergroup", title: "机密群名" },
          from: { id: 253, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=http://example.com.${fullwidth}http://bit.ly/${path}`,
            },
          ],
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(keptUpdate.status).toBe("event");
    if (keptUpdate.status !== "event") {
      return;
    }
    const kept = await screenTelegramEvent(keptUpdate.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(kept.decision.action).toBe("allow");
    expect(JSON.stringify(kept.decision)).not.toContain("bit.ly");
    expect(JSON.stringify(kept.decision)).not.toContain(path);
  });

  it("opens the short link after a dot lookalike written before @", async () => {
    const path = "offer254";
    const fullwidth = "\uFF0E";
    const opened = await normalizeUpdate({
      update: {
        update_id: 2429,
        message: {
          message_id: 2429,
          date: 1761955200,
          chat: { id: -1008542, type: "supergroup", title: "机密群名" },
          from: { id: 254, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=http://example.com${fullwidth}@http://bit.ly/${path}`,
            },
          ],
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
    const result = await screenTelegramEvent(opened.event, {
      logger,
      moderator: createMemoryModerator(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain(fullwidth);
    expect(dumped).not.toContain("机密群名");

    const keptUpdate = await normalizeUpdate({
      update: {
        update_id: 2430,
        message: {
          message_id: 2430,
          date: 1761955200,
          chat: { id: -1008546, type: "supergroup", title: "机密群名" },
          from: { id: 254, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=http://example.com.@http://bit.ly/${path}`,
            },
          ],
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(keptUpdate.status).toBe("event");
    if (keptUpdate.status !== "event") {
      return;
    }
    const kept = await screenTelegramEvent(keptUpdate.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(kept.decision.action).toBe("allow");
    expect(JSON.stringify(kept.decision)).not.toContain("bit.ly");
    expect(JSON.stringify(kept.decision)).not.toContain(path);
  });

  it("opens the short link after a host written with dot lookalikes", async () => {
    const path = "offer255";
    const fullwidth = "\uFF0E";
    const opened = await normalizeUpdate({
      update: {
        update_id: 2431,
        message: {
          message_id: 2431,
          date: 1761955200,
          chat: { id: -1008554, type: "supergroup", title: "机密群名" },
          from: { id: 255, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=safe${fullwidth}com/http://bit.ly/${path}`,
            },
          ],
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
    const result = await screenTelegramEvent(opened.event, {
      logger,
      moderator: createMemoryModerator(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain(fullwidth);
    expect(dumped).not.toContain("机密群名");

    const keptUpdate = await normalizeUpdate({
      update: {
        update_id: 2432,
        message: {
          message_id: 2432,
          date: 1761955200,
          chat: { id: -1008557, type: "supergroup", title: "机密群名" },
          from: { id: 255, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=http://bit${fullwidth}ly${fullwidth}com/http://t.co/${path}`,
            },
          ],
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(keptUpdate.status).toBe("event");
    if (keptUpdate.status !== "event") {
      return;
    }
    const kept = await screenTelegramEvent(keptUpdate.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(kept.decision.action).toBe("allow");
    expect(JSON.stringify(kept.decision)).not.toContain("t.co");
    expect(JSON.stringify(kept.decision)).not.toContain(path);
  });

  it("opens the short link after a lookalike letter before the scheme", async () => {
    const path = "offer256";
    const cyr = "\u0410";
    const opened = await normalizeUpdate({
      update: {
        update_id: 2433,
        message: {
          message_id: 2433,
          date: 1761955200,
          chat: { id: -1008567, type: "supergroup", title: "机密群名" },
          from: { id: 256, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=b${cyr}http://bit.ly/${path}`,
            },
          ],
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
    const result = await screenTelegramEvent(opened.event, {
      logger,
      moderator: createMemoryModerator(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    const dumped = JSON.stringify({ result, logs: logger.entries });
    expect(dumped).not.toContain(path);
    expect(dumped).not.toContain(cyr);
    expect(dumped).not.toContain("机密群名");

    const keptUpdate = await normalizeUpdate({
      update: {
        update_id: 2434,
        message: {
          message_id: 2434,
          date: 1761955200,
          chat: { id: -1008571, type: "supergroup", title: "机密群名" },
          from: { id: 256, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=http://example.com${cyr}http://bit.ly/${path}`,
            },
          ],
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(keptUpdate.status).toBe("event");
    if (keptUpdate.status !== "event") {
      return;
    }
    const kept = await screenTelegramEvent(keptUpdate.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(kept.decision.action).toBe("allow");
    expect(JSON.stringify(kept.decision)).not.toContain("bit.ly");
    expect(JSON.stringify(kept.decision)).not.toContain(path);
    expect(JSON.stringify(kept.decision)).not.toContain(cyr);
  });

  it("leaves a short link glued through a non-spacing mark", async () => {
    const path = "offer257";
    const mark = "\u0300";
    const glued = await normalizeUpdate({
      update: {
        update_id: 2435,
        message: {
          message_id: 2435,
          date: 1761955200,
          chat: { id: -1008578, type: "supergroup", title: "机密群名" },
          from: { id: 257, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=example.com${mark}http://bit.ly/${path}`,
            },
          ],
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(glued.status).toBe("event");
    if (glued.status !== "event") {
      return;
    }
    const logger = createMemoryLogger();
    const kept = await screenTelegramEvent(glued.event, {
      logger,
      moderator: createMemoryModerator(),
    });
    expect(kept.decision.action).toBe("allow");
    const keptDump = JSON.stringify({ kept, logs: logger.entries });
    expect(keptDump).not.toContain("bit.ly");
    expect(keptDump).not.toContain(path);
    expect(keptDump).not.toContain(mark);
    expect(keptDump).not.toContain("机密群名");

    const opened = await normalizeUpdate({
      update: {
        update_id: 2436,
        message: {
          message_id: 2436,
          date: 1761955200,
          chat: { id: -1008590, type: "supergroup", title: "机密群名" },
          from: { id: 257, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=example.com${mark}/http://bit.ly/${path}`,
            },
          ],
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
    const result = await screenTelegramEvent(opened.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    expect(JSON.stringify(result.decision)).not.toContain(path);
    expect(JSON.stringify(result.decision)).not.toContain(mark);
  });

  it("leaves a short link glued on by a percent-encoded dot", async () => {
    const path = "offer258";
    const glued = await normalizeUpdate({
      update: {
        update_id: 2437,
        message: {
          message_id: 2437,
          date: 1761955200,
          chat: { id: -1008607, type: "supergroup", title: "机密群名" },
          from: { id: 258, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=example.com%252Ehttp://bit.ly/${path}`,
            },
          ],
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(glued.status).toBe("event");
    if (glued.status !== "event") {
      return;
    }
    const logger = createMemoryLogger();
    const kept = await screenTelegramEvent(glued.event, {
      logger,
      moderator: createMemoryModerator(),
    });
    expect(kept.decision.action).toBe("allow");
    const keptDump = JSON.stringify({ kept, logs: logger.entries });
    expect(keptDump).not.toContain("bit.ly");
    expect(keptDump).not.toContain(path);
    expect(keptDump).not.toContain("机密群名");

    const opened = await normalizeUpdate({
      update: {
        update_id: 2438,
        message: {
          message_id: 2438,
          date: 1761955200,
          chat: { id: -1008618, type: "supergroup", title: "机密群名" },
          from: { id: 258, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=http://bit.ly%252Eevil.example/${path}`,
            },
          ],
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
    const result = await screenTelegramEvent(opened.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    expect(JSON.stringify(result.decision)).not.toContain(path);
    expect(JSON.stringify(result.decision)).not.toContain("evil.example");
  });

  it("leaves a short link spelled with a percent-encoded slash", async () => {
    const path = "offer259";
    const glued = await normalizeUpdate({
      update: {
        update_id: 2439,
        message: {
          message_id: 2439,
          date: 1761955200,
          chat: { id: -1008625, type: "supergroup", title: "机密群名" },
          from: { id: 259, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=example.com%252Fhttp://bit.ly/${path}`,
            },
          ],
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(glued.status).toBe("event");
    if (glued.status !== "event") {
      return;
    }
    const logger = createMemoryLogger();
    const kept = await screenTelegramEvent(glued.event, {
      logger,
      moderator: createMemoryModerator(),
    });
    expect(kept.decision.action).toBe("allow");
    const keptDump = JSON.stringify({ kept, logs: logger.entries });
    expect(keptDump).not.toContain("bit.ly");
    expect(keptDump).not.toContain(path);
    expect(keptDump).not.toContain("机密群名");

    const opened = await normalizeUpdate({
      update: {
        update_id: 2440,
        message: {
          message_id: 2440,
          date: 1761955200,
          chat: { id: -1008637, type: "supergroup", title: "机密群名" },
          from: { id: 259, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=http:%252F/bit.ly/${path}`,
            },
          ],
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
    const result = await screenTelegramEvent(opened.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    expect(JSON.stringify(result.decision)).not.toContain(path);
  });

  it("leaves a short link glued on by a percent-encoded plus host", async () => {
    const path = "offer260";
    const glued = await normalizeUpdate({
      update: {
        update_id: 2441,
        message: {
          message_id: 2441,
          date: 1761955200,
          chat: { id: -1008657, type: "supergroup", title: "机密群名" },
          from: { id: 260, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=example.com%252Bt.co/${path}`,
            },
          ],
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(glued.status).toBe("event");
    if (glued.status !== "event") {
      return;
    }
    const logger = createMemoryLogger();
    const kept = await screenTelegramEvent(glued.event, {
      logger,
      moderator: createMemoryModerator(),
    });
    expect(kept.decision.action).toBe("allow");
    const keptDump = JSON.stringify({ kept, logs: logger.entries });
    expect(keptDump).not.toContain("bit.ly");
    expect(keptDump).not.toContain(path);
    expect(keptDump).not.toContain("机密群名");

    const opened = await normalizeUpdate({
      update: {
        update_id: 2442,
        message: {
          message_id: 2442,
          date: 1761955200,
          chat: { id: -1008672, type: "supergroup", title: "机密群名" },
          from: { id: 260, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=example.com%252Bwww.bit.ly/${path}`,
            },
          ],
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
    const result = await screenTelegramEvent(opened.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:2bwww.bit.ly",
    );
    expect(JSON.stringify(result.decision)).not.toContain(path);
  });

  it("leaves a short link glued on by a percent-encoded slash host", async () => {
    const path = "offer261";
    const glued = await normalizeUpdate({
      update: {
        update_id: 2443,
        message: {
          message_id: 2443,
          date: 1761955200,
          chat: { id: -1008687, type: "supergroup", title: "机密群名" },
          from: { id: 261, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=%252Fhttp://bit.ly/${path}`,
            },
          ],
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(glued.status).toBe("event");
    if (glued.status !== "event") {
      return;
    }
    const logger = createMemoryLogger();
    const kept = await screenTelegramEvent(glued.event, {
      logger,
      moderator: createMemoryModerator(),
    });
    expect(kept.decision.action).toBe("allow");
    const keptDump = JSON.stringify({ kept, logs: logger.entries });
    expect(keptDump).not.toContain("bit.ly");
    expect(keptDump).not.toContain(path);
    expect(keptDump).not.toContain("机密群名");

    const opened = await normalizeUpdate({
      update: {
        update_id: 2444,
        message: {
          message_id: 2444,
          date: 1761955200,
          chat: { id: -1008697, type: "supergroup", title: "机密群名" },
          from: { id: 261, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=example.com%252Fwww.bit.ly/${path}`,
            },
          ],
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
    const result = await screenTelegramEvent(opened.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:2fwww.bit.ly",
    );
    expect(JSON.stringify(result.decision)).not.toContain(path);
  });

  it("leaves a short link glued on by a percent-encoded hyphen host", async () => {
    const path = "offer262";
    const glued = await normalizeUpdate({
      update: {
        update_id: 2445,
        message: {
          message_id: 2445,
          date: 1761955200,
          chat: { id: -1008711, type: "supergroup", title: "机密群名" },
          from: { id: 262, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=bit%252Dly/${path}`,
            },
          ],
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(glued.status).toBe("event");
    if (glued.status !== "event") {
      return;
    }
    const logger = createMemoryLogger();
    const kept = await screenTelegramEvent(glued.event, {
      logger,
      moderator: createMemoryModerator(),
    });
    expect(kept.decision.action).toBe("allow");
    const keptDump = JSON.stringify({ kept, logs: logger.entries });
    expect(keptDump).not.toContain("bit.ly");
    expect(keptDump).not.toContain(path);
    expect(keptDump).not.toContain("机密群名");

    const opened = await normalizeUpdate({
      update: {
        update_id: 2446,
        message: {
          message_id: 2446,
          date: 1761955200,
          chat: { id: -1008720, type: "supergroup", title: "机密群名" },
          from: { id: 262, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=%252Dwww.bit.ly/${path}`,
            },
          ],
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
    const result = await screenTelegramEvent(opened.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:2dwww.bit.ly",
    );
    expect(JSON.stringify(result.decision)).not.toContain(path);
  });

  it("leaves a short link glued on by a percent-encoded host body", async () => {
    const path = "offer263";
    const glued = await normalizeUpdate({
      update: {
        update_id: 2447,
        message: {
          message_id: 2447,
          date: 1761955200,
          chat: { id: -1008730, type: "supergroup", title: "机密群名" },
          from: { id: 263, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=example.com%252B%0Ab%2569t.ly/${path}`,
            },
          ],
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(glued.status).toBe("event");
    if (glued.status !== "event") {
      return;
    }
    const logger = createMemoryLogger();
    const kept = await screenTelegramEvent(glued.event, {
      logger,
      moderator: createMemoryModerator(),
    });
    expect(kept.decision.action).toBe("allow");
    const keptDump = JSON.stringify({ kept, logs: logger.entries });
    expect(keptDump).not.toContain("bit.ly");
    expect(keptDump).not.toContain(path);
    expect(keptDump).not.toContain("机密群名");

    const opened = await normalizeUpdate({
      update: {
        update_id: 2448,
        message: {
          message_id: 2448,
          date: 1761955200,
          chat: { id: -1008751, type: "supergroup", title: "机密群名" },
          from: { id: 263, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=%252B2b%2577ww.bit.ly/${path}`,
            },
          ],
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
    const result = await screenTelegramEvent(opened.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:77ww.bit.ly",
    );
    expect(JSON.stringify(result.decision)).not.toContain(path);
  });

  it("leaves a short link glued on by a percent-encoded gap", async () => {
    const path = "offer264";
    const glued = await normalizeUpdate({
      update: {
        update_id: 2449,
        message: {
          message_id: 2449,
          date: 1761955200,
          chat: { id: -1008768, type: "supergroup", title: "机密群名" },
          from: { id: 264, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=%2509http://bit.ly/${path}`,
            },
          ],
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(glued.status).toBe("event");
    if (glued.status !== "event") {
      return;
    }
    const logger = createMemoryLogger();
    const kept = await screenTelegramEvent(glued.event, {
      logger,
      moderator: createMemoryModerator(),
    });
    expect(kept.decision.action).toBe("allow");
    const keptDump = JSON.stringify({ kept, logs: logger.entries });
    expect(keptDump).not.toContain("bit.ly");
    expect(keptDump).not.toContain(path);
    expect(keptDump).not.toContain("机密群名");

    const opened = await normalizeUpdate({
      update: {
        update_id: 2450,
        message: {
          message_id: 2450,
          date: 1761955200,
          chat: { id: -1008782, type: "supergroup", title: "机密群名" },
          from: { id: 264, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=%250Awww.bit.ly/${path}`,
            },
          ],
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
    const result = await screenTelegramEvent(opened.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:0awww.bit.ly",
    );
    expect(JSON.stringify(result.decision)).not.toContain(path);
  });

  it("leaves a short link glued on by a percent-encoded dot mark", async () => {
    const path = "offer265";
    const glued = await normalizeUpdate({
      update: {
        update_id: 2451,
        message: {
          message_id: 2451,
          date: 1761955200,
          chat: { id: -1008793, type: "supergroup", title: "机密群名" },
          from: { id: 265, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=%252Ehttp://bit.ly/${path}`,
            },
          ],
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(glued.status).toBe("event");
    if (glued.status !== "event") {
      return;
    }
    const logger = createMemoryLogger();
    const kept = await screenTelegramEvent(glued.event, {
      logger,
      moderator: createMemoryModerator(),
    });
    expect(kept.decision.action).toBe("allow");
    const keptDump = JSON.stringify({ kept, logs: logger.entries });
    expect(keptDump).not.toContain("bit.ly");
    expect(keptDump).not.toContain(path);
    expect(keptDump).not.toContain("机密群名");

    const opened = await normalizeUpdate({
      update: {
        update_id: 2452,
        message: {
          message_id: 2452,
          date: 1761955200,
          chat: { id: -1008805, type: "supergroup", title: "机密群名" },
          from: { id: 265, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=%252Ewww.bit.ly/${path}`,
            },
          ],
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
    const result = await screenTelegramEvent(opened.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:2ewww.bit.ly",
    );
    expect(JSON.stringify(result.decision)).not.toContain(path);
  });

  it("leaves a short link glued on by a percent-encoded bracket", async () => {
    const path = "offer266";
    const glued = await normalizeUpdate({
      update: {
        update_id: 2453,
        message: {
          message_id: 2453,
          date: 1761955200,
          chat: { id: -1008824, type: "supergroup", title: "机密群名" },
          from: { id: 266, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=%255B.%255Dhttp://bit.ly/${path}`,
            },
          ],
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(glued.status).toBe("event");
    if (glued.status !== "event") {
      return;
    }
    const logger = createMemoryLogger();
    const kept = await screenTelegramEvent(glued.event, {
      logger,
      moderator: createMemoryModerator(),
    });
    expect(kept.decision.action).toBe("allow");
    const keptDump = JSON.stringify({ kept, logs: logger.entries });
    expect(keptDump).not.toContain("bit.ly");
    expect(keptDump).not.toContain(path);
    expect(keptDump).not.toContain("机密群名");

    const opened = await normalizeUpdate({
      update: {
        update_id: 2454,
        message: {
          message_id: 2454,
          date: 1761955200,
          chat: { id: -1008839, type: "supergroup", title: "机密群名" },
          from: { id: 266, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=%255B.%255Dwww.bit.ly/${path}`,
            },
          ],
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
    const result = await screenTelegramEvent(opened.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:5dwww.bit.ly",
    );
    expect(JSON.stringify(result.decision)).not.toContain(path);
  });

  it("leaves a multi-byte percent encoding outside a schemed draft host", async () => {
    const path = "offer267";
    const glued = await normalizeUpdate({
      update: {
        update_id: 2455,
        message: {
          message_id: 2455,
          date: 1761955200,
          chat: { id: -1008847, type: "supergroup", title: "机密群名" },
          from: { id: 267, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=http://b%25E2%2585%25A0t.ly/${path}`,
            },
          ],
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(glued.status).toBe("event");
    if (glued.status !== "event") {
      return;
    }
    const logger = createMemoryLogger();
    const kept = await screenTelegramEvent(glued.event, {
      logger,
      moderator: createMemoryModerator(),
    });
    expect(kept.decision.action).toBe("allow");
    const keptDump = JSON.stringify({ kept, logs: logger.entries });
    expect(keptDump).not.toContain("bit.ly");
    expect(keptDump).not.toContain(path);
    expect(keptDump).not.toContain("机密群名");

    const opened = await normalizeUpdate({
      update: {
        update_id: 2456,
        message: {
          message_id: 2456,
          date: 1761955200,
          chat: { id: -1008855, type: "supergroup", title: "机密群名" },
          from: { id: 267, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=http://b%2569t.ly/${path}`,
            },
          ],
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
    const result = await screenTelegramEvent(opened.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    expect(JSON.stringify(result.decision)).not.toContain(path);
  });

  it("opens a draft host after a hash on an empty authority", async () => {
    const path = "offer268";
    const glued = await normalizeUpdate({
      update: {
        update_id: 2457,
        message: {
          message_id: 2457,
          date: 1761955200,
          chat: { id: -1008861, type: "supergroup", title: "机密群名" },
          from: { id: 268, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=http://?bit.ly/${path}`,
            },
          ],
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(glued.status).toBe("event");
    if (glued.status !== "event") {
      return;
    }
    const logger = createMemoryLogger();
    const kept = await screenTelegramEvent(glued.event, {
      logger,
      moderator: createMemoryModerator(),
    });
    expect(kept.decision.action).toBe("allow");
    const keptDump = JSON.stringify({ kept, logs: logger.entries });
    expect(keptDump).not.toContain("bit.ly");
    expect(keptDump).not.toContain(path);
    expect(keptDump).not.toContain("机密群名");

    const opened = await normalizeUpdate({
      update: {
        update_id: 2458,
        message: {
          message_id: 2458,
          date: 1761955200,
          chat: { id: -1008872, type: "supergroup", title: "机密群名" },
          from: { id: 268, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=http://%23bit.ly/${path}`,
            },
          ],
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
    const result = await screenTelegramEvent(opened.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    expect(JSON.stringify(result.decision)).not.toContain(path);
  });

  it("opens a draft host after a hostless port that is not one to five digits", async () => {
    const path = "offer269";
    const glued = await normalizeUpdate({
      update: {
        update_id: 2459,
        message: {
          message_id: 2459,
          date: 1761955200,
          chat: { id: -1008884, type: "supergroup", title: "机密群名" },
          from: { id: 269, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=http://:80/bit.ly/${path}`,
            },
          ],
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(glued.status).toBe("event");
    if (glued.status !== "event") {
      return;
    }
    const logger = createMemoryLogger();
    const kept = await screenTelegramEvent(glued.event, {
      logger,
      moderator: createMemoryModerator(),
    });
    expect(kept.decision.action).toBe("allow");
    const keptDump = JSON.stringify({ kept, logs: logger.entries });
    expect(keptDump).not.toContain("bit.ly");
    expect(keptDump).not.toContain(path);
    expect(keptDump).not.toContain("机密群名");

    const opened = await normalizeUpdate({
      update: {
        update_id: 2460,
        message: {
          message_id: 2460,
          date: 1761955200,
          chat: { id: -1008893, type: "supergroup", title: "机密群名" },
          from: { id: 269, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=http://:999999/bit.ly/${path}`,
            },
          ],
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
    const result = await screenTelegramEvent(opened.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    expect(JSON.stringify(result.decision)).not.toContain(path);
  });

  it("keeps a schemed label character on a draft host", async () => {
    const path = "offer270";
    const mark = "\u4e00";
    const glued = await normalizeUpdate({
      update: {
        update_id: 2461,
        message: {
          message_id: 2461,
          date: 1761955200,
          chat: { id: -1008903, type: "supergroup", title: "机密群名" },
          from: { id: 270, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=http://bit.ly${mark}/${path}`,
            },
          ],
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(glued.status).toBe("event");
    if (glued.status !== "event") {
      return;
    }
    const logger = createMemoryLogger();
    const kept = await screenTelegramEvent(glued.event, {
      logger,
      moderator: createMemoryModerator(),
    });
    expect(kept.decision.action).toBe("allow");
    const keptDump = JSON.stringify({ kept, logs: logger.entries });
    expect(keptDump).not.toContain("bit.ly");
    expect(keptDump).not.toContain(path);
    expect(keptDump).not.toContain("机密群名");

    const opened = await normalizeUpdate({
      update: {
        update_id: 2462,
        message: {
          message_id: 2462,
          date: 1761955200,
          chat: { id: -1008922, type: "supergroup", title: "机密群名" },
          from: { id: 270, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=bit.ly${mark}/${path}`,
            },
          ],
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
    const result = await screenTelegramEvent(opened.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    expect(JSON.stringify(result.decision)).not.toContain(path);
  });

  it("keeps a supplementary label character on a draft host", async () => {
    const path = "offer271";
    const ext = "\u{20000}";
    const glued = await normalizeUpdate({
      update: {
        update_id: 2463,
        message: {
          message_id: 2463,
          date: 1761955200,
          chat: { id: -1008931, type: "supergroup", title: "机密群名" },
          from: { id: 271, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=http://bit.ly-${ext}/${path}`,
            },
          ],
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(glued.status).toBe("event");
    if (glued.status !== "event") {
      return;
    }
    const logger = createMemoryLogger();
    const kept = await screenTelegramEvent(glued.event, {
      logger,
      moderator: createMemoryModerator(),
    });
    expect(kept.decision.action).toBe("allow");
    const keptDump = JSON.stringify({ kept, logs: logger.entries });
    expect(keptDump).not.toContain("bit.ly");
    expect(keptDump).not.toContain(path);
    expect(keptDump).not.toContain("机密群名");

    const opened = await normalizeUpdate({
      update: {
        update_id: 2464,
        message: {
          message_id: 2464,
          date: 1761955200,
          chat: { id: -1008945, type: "supergroup", title: "机密群名" },
          from: { id: 271, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=http://bit.ly${"\u{10140}"}/${path}`,
            },
          ],
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
    const result = await screenTelegramEvent(opened.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    expect(JSON.stringify(result.decision)).not.toContain(path);
  });

  it("keeps a mapped letter off a finished draft host when a domain continues", async () => {
    const path = "offer272";
    const glued = await normalizeUpdate({
      update: {
        update_id: 2465,
        message: {
          message_id: 2465,
          date: 1761955200,
          chat: { id: -1008968, type: "supergroup", title: "机密群名" },
          from: { id: 272, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=b\u0430it.ly/${path}`,
            },
          ],
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(glued.status).toBe("event");
    if (glued.status !== "event") {
      return;
    }
    const logger = createMemoryLogger();
    const kept = await screenTelegramEvent(glued.event, {
      logger,
      moderator: createMemoryModerator(),
    });
    expect(kept.decision.action).toBe("allow");
    const keptDump = JSON.stringify({ kept, logs: logger.entries });
    expect(keptDump).not.toContain("bit.ly");
    expect(keptDump).not.toContain(path);
    expect(keptDump).not.toContain("机密群名");

    const opened = await normalizeUpdate({
      update: {
        update_id: 2466,
        message: {
          message_id: 2466,
          date: 1761955200,
          chat: { id: -1008952, type: "supergroup", title: "机密群名" },
          from: { id: 272, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=bit.ly\u00AA/${path}`,
            },
          ],
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
    const result = await screenTelegramEvent(opened.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    expect(JSON.stringify(result.decision)).not.toContain(path);
  });

  it("joins an ideographic stop after a finished draft host", async () => {
    const path = "offer273";
    const stop = "\u3002";
    const glued = await normalizeUpdate({
      update: {
        update_id: 2467,
        message: {
          message_id: 2467,
          date: 1761955200,
          chat: { id: -1008975, type: "supergroup", title: "机密群名" },
          from: { id: 273, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=b\u0430it.ly${stop}evil.com/${path}`,
            },
          ],
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(glued.status).toBe("event");
    if (glued.status !== "event") {
      return;
    }
    const logger = createMemoryLogger();
    const kept = await screenTelegramEvent(glued.event, {
      logger,
      moderator: createMemoryModerator(),
    });
    expect(kept.decision.action).toBe("allow");
    const keptDump = JSON.stringify({ kept, logs: logger.entries });
    expect(keptDump).not.toContain("bit.ly");
    expect(keptDump).not.toContain(path);
    expect(keptDump).not.toContain("机密群名");

    const opened = await normalizeUpdate({
      update: {
        update_id: 2468,
        message: {
          message_id: 2468,
          date: 1761955200,
          chat: { id: -1008980, type: "supergroup", title: "机密群名" },
          from: { id: 273, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=bit.ly${stop}/${path}`,
            },
          ],
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
    const result = await screenTelegramEvent(opened.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    expect(JSON.stringify(result.decision)).not.toContain(path);
  });

  it("joins a dot lookalike after a finished draft host", async () => {
    const path = "offer274";
    const dot = "\u00B7";
    const glued = await normalizeUpdate({
      update: {
        update_id: 2469,
        message: {
          message_id: 2469,
          date: 1761955200,
          chat: { id: -1008985, type: "supergroup", title: "机密群名" },
          from: { id: 274, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=b\u0430it.ly${dot}evil.com/${path}`,
            },
          ],
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(glued.status).toBe("event");
    if (glued.status !== "event") {
      return;
    }
    const logger = createMemoryLogger();
    const kept = await screenTelegramEvent(glued.event, {
      logger,
      moderator: createMemoryModerator(),
    });
    expect(kept.decision.action).toBe("allow");
    const keptDump = JSON.stringify({ kept, logs: logger.entries });
    expect(keptDump).not.toContain("bit.ly");
    expect(keptDump).not.toContain(path);
    expect(keptDump).not.toContain("机密群名");

    const opened = await normalizeUpdate({
      update: {
        update_id: 2470,
        message: {
          message_id: 2470,
          date: 1761955200,
          chat: { id: -1008992, type: "supergroup", title: "机密群名" },
          from: { id: 274, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=bit.ly${dot}evil${dot}com/${path}`,
            },
          ],
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
    const result = await screenTelegramEvent(opened.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    expect(JSON.stringify(result.decision)).not.toContain(path);
  });

  it("opens a finished draft host when the label tail is not a domain", async () => {
    const path = "offer275";
    const mark = "\u70B9";
    const glued = await normalizeUpdate({
      update: {
        update_id: 2471,
        message: {
          message_id: 2471,
          date: 1761955200,
          chat: { id: -1009003, type: "supergroup", title: "机密群名" },
          from: { id: 275, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=b\u0430it.ly${mark}evil.com/${path}`,
            },
          ],
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(glued.status).toBe("event");
    if (glued.status !== "event") {
      return;
    }
    const logger = createMemoryLogger();
    const kept = await screenTelegramEvent(glued.event, {
      logger,
      moderator: createMemoryModerator(),
    });
    expect(kept.decision.action).toBe("allow");
    const keptDump = JSON.stringify({ kept, logs: logger.entries });
    expect(keptDump).not.toContain("bit.ly");
    expect(keptDump).not.toContain(path);
    expect(keptDump).not.toContain("机密群名");

    const opened = await normalizeUpdate({
      update: {
        update_id: 2472,
        message: {
          message_id: 2472,
          date: 1761955200,
          chat: { id: -1008995, type: "supergroup", title: "机密群名" },
          from: { id: 275, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=bit.ly${mark}free/${path}`,
            },
          ],
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
    const result = await screenTelegramEvent(opened.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    expect(JSON.stringify(result.decision)).not.toContain(path);
  });

  it("folds a label run before a dotted strict domain in a draft", async () => {
    const path = "offer276";
    const mark = "\u70B9\u65E5\u672C";
    const glued = await normalizeUpdate({
      update: {
        update_id: 2473,
        message: {
          message_id: 2473,
          date: 1761955200,
          chat: { id: -1009009, type: "supergroup", title: "机密群名" },
          from: { id: 276, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=b\u0430it.ly${mark}.com/${path}`,
            },
          ],
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(glued.status).toBe("event");
    if (glued.status !== "event") {
      return;
    }
    const logger = createMemoryLogger();
    const kept = await screenTelegramEvent(glued.event, {
      logger,
      moderator: createMemoryModerator(),
    });
    expect(kept.decision.action).toBe("allow");
    const keptDump = JSON.stringify({ kept, logs: logger.entries });
    expect(keptDump).not.toContain("bit.ly");
    expect(keptDump).not.toContain(path);
    expect(keptDump).not.toContain("机密群名");

    const opened = await normalizeUpdate({
      update: {
        update_id: 2474,
        message: {
          message_id: 2474,
          date: 1761955200,
          chat: { id: -1009018, type: "supergroup", title: "机密群名" },
          from: { id: 276, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=bit.ly${mark}.notarealtld/${path}`,
            },
          ],
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
    const result = await screenTelegramEvent(opened.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    expect(JSON.stringify(result.decision)).not.toContain(path);
  });

  it("keeps hostnames from web app data without storing the payload", async () => {
    const path = "offer285";
    const kept = await normalizeUpdate({
      update: {
        update_id: 2491,
        message: {
          message_id: 2491,
          date: 1761955200,
          chat: { id: -1009236, type: "supergroup", title: "机密群名" },
          from: { id: 285, first_name: "Ada" },
          web_app_data: {
            data: `https://example.com/${path}`,
            button_text: "打开",
          },
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
    const logger = createMemoryLogger();
    const allowed = await screenTelegramEvent(kept.event, {
      logger,
      moderator: createMemoryModerator(),
    });
    expect(allowed.decision.action).toBe("allow");
    const keptDump = JSON.stringify({ allowed, logs: logger.entries });
    expect(keptDump).not.toContain("bit.ly");
    expect(keptDump).not.toContain(path);
    expect(keptDump).not.toContain("机密群名");

    const opened = await normalizeUpdate({
      update: {
        update_id: 2492,
        message: {
          message_id: 2492,
          date: 1761955200,
          chat: { id: -1009237, type: "supergroup", title: "机密群名" },
          from: { id: 285, first_name: "Ada" },
          web_app_data: {
            data: `https://bit.ly/${path}`,
            button_text: "打开",
          },
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
    const result = await screenTelegramEvent(opened.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    expect(JSON.stringify(result.decision)).not.toContain(path);
  });

  it("keeps the hostname from the website a user logged in on", async () => {
    const path = "offer286";
    const kept = await normalizeUpdate({
      update: {
        update_id: 2493,
        message: {
          message_id: 2493,
          date: 1761955200,
          chat: { id: -1009242, type: "supergroup", title: "机密群名" },
          from: { id: 286, first_name: "Ada" },
          text: "今天站会",
          connected_website: "example.com",
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
    const logger = createMemoryLogger();
    const allowed = await screenTelegramEvent(kept.event, {
      logger,
      moderator: createMemoryModerator(),
    });
    expect(allowed.decision.action).toBe("allow");
    const keptDump = JSON.stringify({ allowed, logs: logger.entries });
    expect(keptDump).not.toContain("bit.ly");
    expect(keptDump).not.toContain(path);
    expect(keptDump).not.toContain("机密群名");

    const opened = await normalizeUpdate({
      update: {
        update_id: 2494,
        message: {
          message_id: 2494,
          date: 1761955200,
          chat: { id: -1009243, type: "supergroup", title: "机密群名" },
          from: { id: 286, first_name: "Ada" },
          text: "今天站会",
          connected_website: `https://bit.ly/${path}`,
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
    const result = await screenTelegramEvent(opened.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    expect(JSON.stringify(result.decision)).not.toContain(path);
  });

  it("keeps hostnames from a shared chat title", async () => {
    const path = "offer287";
    const kept = await normalizeUpdate({
      update: {
        update_id: 2495,
        message: {
          message_id: 2495,
          date: 1761955200,
          chat: { id: -1009247, type: "supergroup", title: "机密群名" },
          from: { id: 287, first_name: "Ada" },
          chat_shared: {
            request_id: 287290,
            chat_id: -1009287290,
            title: `https://example.com/${path}`,
          },
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
    const logger = createMemoryLogger();
    const allowed = await screenTelegramEvent(kept.event, {
      logger,
      moderator: createMemoryModerator(),
    });
    expect(allowed.decision.action).toBe("allow");
    const keptDump = JSON.stringify({ allowed, logs: logger.entries });
    expect(keptDump).not.toContain("bit.ly");
    expect(keptDump).not.toContain(path);
    expect(keptDump).not.toContain("机密群名");

    const opened = await normalizeUpdate({
      update: {
        update_id: 2496,
        message: {
          message_id: 2496,
          date: 1761955200,
          chat: { id: -1009248, type: "supergroup", title: "机密群名" },
          from: { id: 287, first_name: "Ada" },
          text: "今天站会",
          chat_shared: {
            request_id: 287291,
            chat_id: -1009287291,
            title: `https://bit.ly/${path}`,
          },
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
    const result = await screenTelegramEvent(opened.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    expect(JSON.stringify(result.decision)).not.toContain(path);
  });

  it("keeps a shared user name and drops the sender name", async () => {
    const path = "offer288";
    const kept = await normalizeUpdate({
      update: {
        update_id: 2497,
        message: {
          message_id: 2497,
          date: 1761955200,
          chat: { id: -1009252, type: "supergroup", title: "机密群名" },
          from: { id: 288, first_name: "Ada" },
          users_shared: {
            request_id: 288291,
            users: [
              { user_id: 288005, first_name: `https://example.com/${path}` },
            ],
          },
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
    const logger = createMemoryLogger();
    const allowed = await screenTelegramEvent(kept.event, {
      logger,
      moderator: createMemoryModerator(),
    });
    expect(allowed.decision.action).toBe("allow");
    const keptDump = JSON.stringify({ allowed, logs: logger.entries });
    expect(keptDump).not.toContain("bit.ly");
    expect(keptDump).not.toContain(path);
    expect(keptDump).not.toContain("机密群名");

    const opened = await normalizeUpdate({
      update: {
        update_id: 2498,
        message: {
          message_id: 2498,
          date: 1761955200,
          chat: { id: -1009253, type: "supergroup", title: "机密群名" },
          from: { id: 288, first_name: "Ada" },
          text: "今天站会",
          users_shared: {
            request_id: 288292,
            users: [{ user_id: 288006, first_name: `https://bit.ly/${path}` }],
          },
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
    const result = await screenTelegramEvent(opened.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    expect(JSON.stringify(result.decision)).not.toContain(path);
  });

  it("keeps a managed bot name and drops the sender name", async () => {
    const path = "offer289";
    const kept = await normalizeUpdate({
      update: {
        update_id: 2499,
        message: {
          message_id: 2499,
          date: 1761955200,
          chat: { id: -1009257, type: "supergroup", title: "机密群名" },
          from: { id: 289, first_name: "Ada" },
          managed_bot_created: {
            bot: {
              id: 289004,
              is_bot: true,
              first_name: `https://example.com/${path}`,
            },
          },
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
    const logger = createMemoryLogger();
    const allowed = await screenTelegramEvent(kept.event, {
      logger,
      moderator: createMemoryModerator(),
    });
    expect(allowed.decision.action).toBe("allow");
    const keptDump = JSON.stringify({ allowed, logs: logger.entries });
    expect(keptDump).not.toContain("bit.ly");
    expect(keptDump).not.toContain(path);
    expect(keptDump).not.toContain("机密群名");

    const opened = await normalizeUpdate({
      update: {
        update_id: 2500,
        message: {
          message_id: 2500,
          date: 1761955200,
          chat: { id: -1009258, type: "supergroup", title: "机密群名" },
          from: { id: 289, first_name: "Ada" },
          text: "今天站会",
          managed_bot_created: {
            bot: {
              id: 289005,
              is_bot: true,
              first_name: `https://bit.ly/${path}`,
            },
          },
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
    const result = await screenTelegramEvent(opened.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    expect(JSON.stringify(result.decision)).not.toContain(path);
  });

  it("keeps a write access web app name and drops the sender name", async () => {
    const path = "offer290";
    const kept = await normalizeUpdate({
      update: {
        update_id: 2501,
        message: {
          message_id: 2501,
          date: 1761955200,
          chat: { id: -1009262, type: "supergroup", title: "机密群名" },
          from: { id: 290, first_name: "Ada" },
          write_access_allowed: {
            web_app_name: `https://example.com/${path}`,
          },
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
    const logger = createMemoryLogger();
    const allowed = await screenTelegramEvent(kept.event, {
      logger,
      moderator: createMemoryModerator(),
    });
    expect(allowed.decision.action).toBe("allow");
    const keptDump = JSON.stringify({ allowed, logs: logger.entries });
    expect(keptDump).not.toContain("bit.ly");
    expect(keptDump).not.toContain(path);
    expect(keptDump).not.toContain("机密群名");

    const opened = await normalizeUpdate({
      update: {
        update_id: 2502,
        message: {
          message_id: 2502,
          date: 1761955200,
          chat: { id: -1009263, type: "supergroup", title: "机密群名" },
          from: { id: 290, first_name: "Ada" },
          text: "今天站会",
          write_access_allowed: {
            web_app_name: `https://bit.ly/${path}`,
          },
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
    const result = await screenTelegramEvent(opened.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    expect(JSON.stringify(result.decision)).not.toContain(path);
  });

  it("keeps a unique gift name and drops the publisher title", async () => {
    const path = "offer291";
    const kept = await normalizeUpdate({
      update: {
        update_id: 2503,
        message: {
          message_id: 2503,
          date: 1761955200,
          chat: { id: -1009271, type: "supergroup", title: "机密群名" },
          from: { id: 291, first_name: "Ada" },
          unique_gift: {
            gift: {
              name: "PlushPepe-291",
              base_name: `https://example.com/${path}`,
            },
            origin: "upgrade",
          },
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
    const logger = createMemoryLogger();
    const allowed = await screenTelegramEvent(kept.event, {
      logger,
      moderator: createMemoryModerator(),
    });
    expect(allowed.decision.action).toBe("allow");
    const keptDump = JSON.stringify({ allowed, logs: logger.entries });
    expect(keptDump).not.toContain("bit.ly");
    expect(keptDump).not.toContain(path);
    expect(keptDump).not.toContain("机密群名");
    expect(keptDump).not.toContain("PlushPepe-291");

    const opened = await normalizeUpdate({
      update: {
        update_id: 2504,
        message: {
          message_id: 2504,
          date: 1761955200,
          chat: { id: -1009272, type: "supergroup", title: "机密群名" },
          from: { id: 291, first_name: "Ada" },
          text: "今天站会",
          unique_gift: {
            gift: {
              name: "PlushPepe-291",
              base_name: `https://bit.ly/${path}`,
            },
            origin: "upgrade",
          },
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
    const result = await screenTelegramEvent(opened.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    expect(JSON.stringify(result.decision)).not.toContain(path);
    expect(JSON.stringify(result.decision)).not.toContain("PlushPepe-291");
  });

  it("keeps a story poster name and drops the username", async () => {
    const path = "offer292";
    const kept = await normalizeUpdate({
      update: {
        update_id: 2505,
        message: {
          message_id: 2505,
          date: 1761955200,
          chat: { id: -1009277, type: "supergroup", title: "机密群名" },
          from: { id: 292, first_name: "Ada" },
          story: {
            chat: {
              id: -1009292295,
              type: "channel",
              title: `https://example.com/${path}`,
              username: "bit.ly",
            },
            id: 880296,
          },
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
    const logger = createMemoryLogger();
    const allowed = await screenTelegramEvent(kept.event, {
      logger,
      moderator: createMemoryModerator(),
    });
    expect(allowed.decision.action).toBe("allow");
    const keptDump = JSON.stringify({ allowed, logs: logger.entries });
    expect(keptDump).not.toContain("bit.ly");
    expect(keptDump).not.toContain(path);
    expect(keptDump).not.toContain("机密群名");
    expect(keptDump).not.toContain("880296");

    const opened = await normalizeUpdate({
      update: {
        update_id: 2506,
        message: {
          message_id: 2506,
          date: 1761955200,
          chat: { id: -1009278, type: "supergroup", title: "机密群名" },
          from: { id: 292, first_name: "Ada" },
          text: "今天站会",
          reply_to_story: {
            chat: {
              id: 292002,
              type: "private",
              first_name: `https://bit.ly/${path}`,
              username: "example.com",
            },
            id: 880297,
          },
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
    const result = await screenTelegramEvent(opened.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    expect(JSON.stringify(result.decision)).not.toContain(path);
    expect(JSON.stringify(result.decision)).not.toContain("880297");
  });

  it("keeps a script letter after a schemed hyphen in a draft", async () => {
    const path = "offer284";
    const greek = "\u03B1";
    const glued = await normalizeUpdate({
      update: {
        update_id: 2489,
        message: {
          message_id: 2489,
          date: 1761955200,
          chat: { id: -1009211, type: "supergroup", title: "机密群名" },
          from: { id: 284, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=http://b\u0430it.ly-${greek}/${path}`,
            },
          ],
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(glued.status).toBe("event");
    if (glued.status !== "event") {
      return;
    }
    const logger = createMemoryLogger();
    const kept = await screenTelegramEvent(glued.event, {
      logger,
      moderator: createMemoryModerator(),
    });
    expect(kept.decision.action).toBe("allow");
    const keptDump = JSON.stringify({ kept, logs: logger.entries });
    expect(keptDump).not.toContain("bit.ly");
    expect(keptDump).not.toContain(path);
    expect(keptDump).not.toContain("机密群名");

    const opened = await normalizeUpdate({
      update: {
        update_id: 2490,
        message: {
          message_id: 2490,
          date: 1761955200,
          chat: { id: -1009224, type: "supergroup", title: "机密群名" },
          from: { id: 284, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=http://bit.ly-${greek}@evil.com/${path}`,
            },
          ],
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
    const result = await screenTelegramEvent(opened.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    expect(JSON.stringify(result.decision)).not.toContain(path);
  });

  it("keeps a script letter after a buried schemed mark in a draft", async () => {
    const path = "offer283";
    const greek = "\u03B1";
    const gap = "\u200B";
    const glued = await normalizeUpdate({
      update: {
        update_id: 2487,
        message: {
          message_id: 2487,
          date: 1761955200,
          chat: { id: -1009179, type: "supergroup", title: "机密群名" },
          from: { id: 283, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=http://b\u0430it${gap}.ly${greek}/${path}`,
            },
          ],
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(glued.status).toBe("event");
    if (glued.status !== "event") {
      return;
    }
    const logger = createMemoryLogger();
    const kept = await screenTelegramEvent(glued.event, {
      logger,
      moderator: createMemoryModerator(),
    });
    expect(kept.decision.action).toBe("allow");
    const keptDump = JSON.stringify({ kept, logs: logger.entries });
    expect(keptDump).not.toContain("bit.ly");
    expect(keptDump).not.toContain(path);
    expect(keptDump).not.toContain("机密群名");

    const opened = await normalizeUpdate({
      update: {
        update_id: 2488,
        message: {
          message_id: 2488,
          date: 1761955200,
          chat: { id: -1009203, type: "supergroup", title: "机密群名" },
          from: { id: 283, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=http://bit${gap}.ly${greek}@evil.com/${path}`,
            },
          ],
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
    const result = await screenTelegramEvent(opened.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    expect(JSON.stringify(result.decision)).not.toContain(path);
  });

  it("keeps a script letter after an ignored schemed mark in a draft", async () => {
    const path = "offer282";
    const greek = "\u03B1";
    const gap = "\u200B";
    const glued = await normalizeUpdate({
      update: {
        update_id: 2485,
        message: {
          message_id: 2485,
          date: 1761955200,
          chat: { id: -1009152, type: "supergroup", title: "机密群名" },
          from: { id: 282, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=http://b\u0430it.ly${gap}${greek}/${path}`,
            },
          ],
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(glued.status).toBe("event");
    if (glued.status !== "event") {
      return;
    }
    const logger = createMemoryLogger();
    const kept = await screenTelegramEvent(glued.event, {
      logger,
      moderator: createMemoryModerator(),
    });
    expect(kept.decision.action).toBe("allow");
    const keptDump = JSON.stringify({ kept, logs: logger.entries });
    expect(keptDump).not.toContain("bit.ly");
    expect(keptDump).not.toContain(path);
    expect(keptDump).not.toContain("机密群名");

    const opened = await normalizeUpdate({
      update: {
        update_id: 2486,
        message: {
          message_id: 2486,
          date: 1761955200,
          chat: { id: -1009172, type: "supergroup", title: "机密群名" },
          from: { id: 282, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=http://bit.ly${gap}${greek}@evil.com/${path}`,
            },
          ],
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
    const result = await screenTelegramEvent(opened.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    expect(JSON.stringify(result.decision)).not.toContain(path);
  });

  it("keeps a dotted script label on a schemed draft host", async () => {
    const path = "offer281";
    const greek = "\u03B1";
    const glued = await normalizeUpdate({
      update: {
        update_id: 2483,
        message: {
          message_id: 2483,
          date: 1761955200,
          chat: { id: -1009127, type: "supergroup", title: "机密群名" },
          from: { id: 281, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=http://b\u0430it.ly.${greek}/${path}`,
            },
          ],
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(glued.status).toBe("event");
    if (glued.status !== "event") {
      return;
    }
    const logger = createMemoryLogger();
    const kept = await screenTelegramEvent(glued.event, {
      logger,
      moderator: createMemoryModerator(),
    });
    expect(kept.decision.action).toBe("allow");
    const keptDump = JSON.stringify({ kept, logs: logger.entries });
    expect(keptDump).not.toContain("bit.ly");
    expect(keptDump).not.toContain(path);
    expect(keptDump).not.toContain("机密群名");

    const opened = await normalizeUpdate({
      update: {
        update_id: 2484,
        message: {
          message_id: 2484,
          date: 1761955200,
          chat: { id: -1009144, type: "supergroup", title: "机密群名" },
          from: { id: 281, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=http://bit.ly.${greek}@evil.com/${path}`,
            },
          ],
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
    const result = await screenTelegramEvent(opened.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    expect(JSON.stringify(result.decision)).not.toContain(path);
  });

  it("keeps a schemed script letter inside a draft label", async () => {
    const path = "offer280";
    const greek = "\u03B1";
    const glued = await normalizeUpdate({
      update: {
        update_id: 2481,
        message: {
          message_id: 2481,
          date: 1761955200,
          chat: { id: -1009097, type: "supergroup", title: "机密群名" },
          from: { id: 280, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=http://b\u0430it.ly${greek}/${path}`,
            },
          ],
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(glued.status).toBe("event");
    if (glued.status !== "event") {
      return;
    }
    const logger = createMemoryLogger();
    const kept = await screenTelegramEvent(glued.event, {
      logger,
      moderator: createMemoryModerator(),
    });
    expect(kept.decision.action).toBe("allow");
    const keptDump = JSON.stringify({ kept, logs: logger.entries });
    expect(keptDump).not.toContain("bit.ly");
    expect(keptDump).not.toContain(path);
    expect(keptDump).not.toContain("机密群名");

    const opened = await normalizeUpdate({
      update: {
        update_id: 2482,
        message: {
          message_id: 2482,
          date: 1761955200,
          chat: { id: -1009118, type: "supergroup", title: "机密群名" },
          from: { id: 280, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=http://bit.ly${greek}@evil.com/${path}`,
            },
          ],
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
    const result = await screenTelegramEvent(opened.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    expect(JSON.stringify(result.decision)).not.toContain(path);
  });

  it("keeps a dot lookalike inside a schemed draft label", async () => {
    const path = "offer279";
    const dot = "\u00B7";
    const glued = await normalizeUpdate({
      update: {
        update_id: 2479,
        message: {
          message_id: 2479,
          date: 1761955200,
          chat: { id: -1009072, type: "supergroup", title: "机密群名" },
          from: { id: 279, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=http://b\u0430it.ly${dot}/${path}`,
            },
          ],
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(glued.status).toBe("event");
    if (glued.status !== "event") {
      return;
    }
    const logger = createMemoryLogger();
    const kept = await screenTelegramEvent(glued.event, {
      logger,
      moderator: createMemoryModerator(),
    });
    expect(kept.decision.action).toBe("allow");
    const keptDump = JSON.stringify({ kept, logs: logger.entries });
    expect(keptDump).not.toContain("bit.ly");
    expect(keptDump).not.toContain(path);
    expect(keptDump).not.toContain("机密群名");

    const opened = await normalizeUpdate({
      update: {
        update_id: 2480,
        message: {
          message_id: 2480,
          date: 1761955200,
          chat: { id: -1009086, type: "supergroup", title: "机密群名" },
          from: { id: 279, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=bit.ly${dot}/${path}`,
            },
          ],
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
    const result = await screenTelegramEvent(opened.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    expect(JSON.stringify(result.decision)).not.toContain(path);
  });

  it("joins an ideographic stop before a unicode draft domain", async () => {
    const path = "offer278";
    const stop = "\u3002";
    const japan = "\u65E5\u672C";
    const glued = await normalizeUpdate({
      update: {
        update_id: 2477,
        message: {
          message_id: 2477,
          date: 1761955200,
          chat: { id: -1009049, type: "supergroup", title: "机密群名" },
          from: { id: 278, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=b\u0430it.ly${stop}${japan}.com/${path}`,
            },
          ],
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(glued.status).toBe("event");
    if (glued.status !== "event") {
      return;
    }
    const logger = createMemoryLogger();
    const kept = await screenTelegramEvent(glued.event, {
      logger,
      moderator: createMemoryModerator(),
    });
    expect(kept.decision.action).toBe("allow");
    const keptDump = JSON.stringify({ kept, logs: logger.entries });
    expect(keptDump).not.toContain("bit.ly");
    expect(keptDump).not.toContain(path);
    expect(keptDump).not.toContain("机密群名");

    const opened = await normalizeUpdate({
      update: {
        update_id: 2478,
        message: {
          message_id: 2478,
          date: 1761955200,
          chat: { id: -1009063, type: "supergroup", title: "机密群名" },
          from: { id: 278, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=bit.ly${stop}com/${path}`,
            },
          ],
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
    const result = await screenTelegramEvent(opened.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    expect(JSON.stringify(result.decision)).not.toContain(path);
  });

  it("keeps a unicode label on a dotted draft host", async () => {
    const path = "offer277";
    const mark = "\u70B9";
    const japan = "\u65E5\u672C";
    const glued = await normalizeUpdate({
      update: {
        update_id: 2475,
        message: {
          message_id: 2475,
          date: 1761955200,
          chat: { id: -1009024, type: "supergroup", title: "机密群名" },
          from: { id: 277, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=b\u0430it.ly${mark}.${japan}.com/${path}`,
            },
          ],
        },
      },
      tenantId: "local",
      adminUserIds: [],
      nowIso: "2026-11-01T00:00:00.000Z",
    });
    expect(glued.status).toBe("event");
    if (glued.status !== "event") {
      return;
    }
    const logger = createMemoryLogger();
    const kept = await screenTelegramEvent(glued.event, {
      logger,
      moderator: createMemoryModerator(),
    });
    expect(kept.decision.action).toBe("allow");
    const keptDump = JSON.stringify({ kept, logs: logger.entries });
    expect(keptDump).not.toContain("bit.ly");
    expect(keptDump).not.toContain(path);
    expect(keptDump).not.toContain("机密群名");

    const opened = await normalizeUpdate({
      update: {
        update_id: 2476,
        message: {
          message_id: 2476,
          date: 1761955200,
          chat: { id: -1009039, type: "supergroup", title: "机密群名" },
          from: { id: 277, first_name: "Ada" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://t.me/share/url?text=bit.ly${mark}.${japan}.notarealtld/${path}`,
            },
          ],
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
    const result = await screenTelegramEvent(opened.event, {
      logger: createMemoryLogger(),
      moderator: createMemoryModerator(),
    });
    expect(result.decision.action).toBe("delete");
    expect(result.decision.reasons).toEqual(["short_link"]);
    expect(JSON.stringify(result.decision.evidence)).toContain(
      "short_link:bit.ly",
    );
    expect(JSON.stringify(result.decision)).not.toContain(path);
  });
});
