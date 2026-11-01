import {
  createMemoryBlocklistStore,
  createMemoryCache,
  createMemoryCaptchaStore,
  createMemoryModerator,
  createMemoryPolicyStore,
  createMemoryReply,
  createMemoryReviewQueue,
  createMemoryRulePackArchive,
  createMemoryRuleSubscriptionStore,
  createMemoryRuntimeStore,
  createMemoryStorage,
} from "@tasb/adapter-memory";
import {
  createMemoryChatDirectory,
  createMemoryQuotaStore,
  defaultBasicDetectorIds,
  quotaPolicyFromEnv,
} from "@tasb/cloud";
import {
  type BlocklistStore,
  createFixedClock,
  createMemoryLogger,
  parseEvent,
} from "@tasb/core";
import { createMemoryRateWindow } from "@tasb/detector-rate";
import { sha256Hex } from "@tasb/platform-telegram";
import { describe, expect, it } from "vitest";
import { handleIncomingEvent } from "./operate.js";

const phrase = "请免费领取礼品";

async function incoming(input: {
  readonly text: string;
  readonly direct?: boolean;
  readonly chatId?: string;
  readonly actorId?: string;
}) {
  return parseEvent({
    id: "evt_op",
    tenantId: "local",
    chatId: input.chatId ?? "42",
    kind: "message",
    occurredAt: "2026-11-01T00:00:00.000Z",
    actor: { id: input.actorId ?? "42", isAdmin: false },
    ...(input.direct ? { direct: true } : {}),
    message: {
      id: "1",
      text: input.text,
      textSha256: await sha256Hex(input.text),
    },
  });
}

function deps() {
  return {
    logger: createMemoryLogger(),
    cache: createMemoryCache(),
    storage: createMemoryStorage(),
    policyStore: createMemoryPolicyStore(),
    runtime: createMemoryRuntimeStore(),
    reply: createMemoryReply(),
    adminActorIds: ["42"],
  };
}

describe("handleIncomingEvent", () => {
  it("screens a group command and leaves config unchanged", async () => {
    const kit = deps();
    await handleIncomingEvent(
      await incoming({
        text: `/whitelist -100 add 9 ${phrase}`,
        chatId: "-100",
      }),
      kit,
    );
    expect(kit.reply.sent).toHaveLength(0);
    expect(await kit.policyStore.get("local", "-100")).toBeNull();
    expect(
      kit.logger.entries.some((entry) => entry.fields.action === "delete"),
    ).toBe(true);
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
  });

  it("lets a configured admin manage one chat from a private command", async () => {
    const kit = deps();
    await handleIncomingEvent(
      await incoming({ text: `/help ${phrase}`, direct: true }),
      kit,
    );
    expect(kit.reply.sent[0]?.text).toContain("/whitelist");
    expect(kit.reply.sent[0]?.text).not.toContain(phrase);

    const denied = deps();
    await handleIncomingEvent(
      await incoming({
        text: `/dryrun -100 on ${phrase}`,
        direct: true,
        actorId: "7",
      }),
      denied,
    );
    expect(denied.reply.sent[0]?.text).toBe("没有权限");
    expect(await denied.runtime.getDryRun("local", "-100")).toBe(false);

    await handleIncomingEvent(
      await incoming({ text: "/dryrun -100 on", direct: true }),
      kit,
    );
    await handleIncomingEvent(
      await incoming({
        text: "/dryrun -100 off",
        chatId: "-100",
        actorId: "42",
      }),
      kit,
    );
    expect(await kit.runtime.getDryRun("local", "-100")).toBe(true);

    await handleIncomingEvent(
      await incoming({ text: phrase, chatId: "-100", actorId: "5" }),
      kit,
    );
    expect(kit.storage.records).toHaveLength(0);
    expect(
      kit.logger.entries.some((entry) => entry.fields.dryRun === true),
    ).toBe(true);

    await handleIncomingEvent(
      await incoming({ text: "/dryrun -100 off", direct: true }),
      kit,
    );
    await handleIncomingEvent(
      await incoming({ text: phrase, chatId: "-100", actorId: "5" }),
      kit,
    );
    expect(kit.storage.records).toHaveLength(1);
    const logs = await handleIncomingEvent(
      await incoming({ text: "/logs -100", direct: true }),
      kit,
    );
    expect(logs).toBeUndefined();
    const logReply = kit.reply.sent.at(-1)?.text ?? "";
    expect(logReply).toContain("delete");
    expect(logReply).not.toContain(phrase);
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
  });

  it("releases a join when the captcha button cannot be sent", async () => {
    const kit = deps();
    const moderator = createMemoryModerator();
    const captchaStore = createMemoryCaptchaStore();
    const nonce = "0123456789abcdef";
    await handleIncomingEvent(
      parseEvent({
        id: "evt_join",
        tenantId: "local",
        chatId: "-100123",
        kind: "chat_member",
        occurredAt: "2026-11-01T00:00:00.000Z",
        actor: { id: "77", isAdmin: false },
        membership: "join",
      }),
      { ...kit, moderator, captchaStore, createNonce: () => nonce },
    );
    expect(moderator.restricted).toHaveLength(1);
    expect(moderator.released).toHaveLength(1);
    expect(await captchaStore.get("local", "-100123", "77")).toBeNull();
    expect(
      kit.logger.entries.some(
        (entry) => entry.message === "captcha_prompt_failed",
      ),
    ).toBe(true);
    expect(JSON.stringify(kit.logger.entries)).not.toContain(nonce);
    expect(JSON.stringify(kit.storage.records)).not.toContain(nonce);
  });

  it("audits a passed challenge and a timeout without the nonce", async () => {
    const nonce = "abcdef0123456789";
    const passedStore = createMemoryCaptchaStore();
    const passedMod = createMemoryModerator();
    const passed = deps();
    const clock = createFixedClock("2026-11-01T00:00:00.000Z");
    await passedStore.put({
      tenantId: "local",
      chatId: "-100",
      actorId: "77",
      nonce,
      expiresAt: "2026-11-01T00:05:00.000Z",
    });
    await handleIncomingEvent(
      parseEvent({
        id: "evt_pass",
        tenantId: "local",
        chatId: "-100",
        kind: "challenge",
        occurredAt: "2026-11-01T00:00:00.000Z",
        actor: { id: "77", isAdmin: false },
        challenge: { nonce },
      }),
      { ...passed, moderator: passedMod, captchaStore: passedStore, clock },
    );
    expect(passedMod.released).toHaveLength(1);
    expect(passed.storage.records[0]?.reasons).toEqual(["captcha_passed"]);
    expect(JSON.stringify(passed.storage.records)).not.toContain(nonce);
    expect(JSON.stringify(passed.storage.records)).not.toContain("text");

    const expiredStore = createMemoryCaptchaStore();
    const expiredMod = createMemoryModerator();
    const expired = deps();
    await expiredStore.put({
      tenantId: "local",
      chatId: "-100",
      actorId: "77",
      nonce,
      expiresAt: "2026-11-01T00:00:00.000Z",
    });
    await handleIncomingEvent(
      parseEvent({
        id: "evt_late",
        tenantId: "local",
        chatId: "-100",
        kind: "challenge",
        occurredAt: "2026-11-01T00:00:00.000Z",
        actor: { id: "77", isAdmin: false },
        challenge: { nonce },
      }),
      {
        ...expired,
        moderator: expiredMod,
        captchaStore: expiredStore,
        clock,
      },
    );
    expect(expiredMod.released).toEqual([]);
    expect(expired.storage.records[0]?.reasons).toEqual(["captcha_expired"]);
    expect(JSON.stringify(expired.storage.records)).not.toContain(nonce);
  });

  it("keeps the member restricted after the button is sent", async () => {
    const kit = deps();
    const moderator = createMemoryModerator();
    const captchaStore = createMemoryCaptchaStore();
    const nonce = "0123456789abcdef";
    let body = "";
    await handleIncomingEvent(
      parseEvent({
        id: "evt_button",
        tenantId: "local",
        chatId: "-100123",
        kind: "chat_member",
        occurredAt: "2026-11-01T00:00:00.000Z",
        actor: { id: "77", isAdmin: false },
        membership: "join",
      }),
      {
        ...kit,
        moderator,
        captchaStore,
        createNonce: () => nonce,
        botToken: "bot-token",
        fetchImpl: async (_input, init) => {
          body = String(init?.body ?? "");
          return new Response("ok", { status: 200 });
        },
      },
    );
    expect(moderator.restricted).toHaveLength(1);
    expect(moderator.released).toEqual([]);
    expect(await captchaStore.get("local", "-100123", "77")).not.toBeNull();
    expect(body).toContain(`c:${nonce}`);
    expect(body).not.toContain(phrase);
    expect(JSON.stringify(kit.logger.entries)).not.toContain("bot-token");
  });

  it("stops reading the shared blocklist as soon as the chat turns it off", async () => {
    const kit = deps();
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
    const note = "今天站会改到三点";
    const base = {
      ...kit,
      blocklist: wrapped,
      rateWindow: createMemoryRateWindow(),
    };
    await handleIncomingEvent(
      await incoming({ text: note, chatId: "-100", actorId: "5" }),
      base,
    );
    expect(reads).toBe(0);
    expect(kit.storage.records).toHaveLength(0);

    await handleIncomingEvent(
      await incoming({ text: "/blocklist -100 add actor 5", direct: true }),
      base,
    );
    expect(kit.reply.sent.at(-1)?.text).toBe("blocklist -100 off\nadded");
    await handleIncomingEvent(
      await incoming({ text: "明天下午见", chatId: "-100", actorId: "5" }),
      base,
    );
    expect(reads).toBe(0);

    await handleIncomingEvent(
      await incoming({ text: "/blocklist -100 on", direct: true }),
      base,
    );
    await handleIncomingEvent(
      await incoming({ text: "下周一同步", chatId: "-100", actorId: "5" }),
      base,
    );
    expect(kit.storage.records.at(-1)?.action).toBe("delete");
    expect(kit.storage.records.at(-1)?.reasons).toContain("shared_actor");
    expect(JSON.stringify(kit.storage.records)).not.toContain("下周一同步");
    const seen = reads;
    expect(seen).toBeGreaterThan(0);

    await handleIncomingEvent(
      await incoming({ text: "/blocklist -100 off", direct: true }),
      base,
    );
    await handleIncomingEvent(
      await incoming({ text: "周五再看", chatId: "-100", actorId: "5" }),
      base,
    );
    expect(reads).toBe(seen);
    expect(kit.storage.records).toHaveLength(1);
    expect(JSON.stringify(kit.logger.entries)).not.toContain(note);
  });

  it("replies in English when locale is en", async () => {
    const kit = deps();
    await handleIncomingEvent(
      await incoming({ text: "/help", direct: true, actorId: "7" }),
      { ...kit, locale: "en" },
    );
    expect(kit.reply.sent[0]?.text).toBe("No permission");
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
  });

  it("queues an appeal and leaves the rules untouched", async () => {
    const kit = deps();
    const review = createMemoryReviewQueue();
    const rules = {
      version: 1 as const,
      aggregate: "max" as const,
      rules: [
        {
          id: "spam_keywords",
          enabled: true,
          detectorIds: ["keyword"],
          threshold: 1,
          actions: ["delete" as const],
        },
      ],
    };
    await kit.storage.putRuleSet("local", "-100", rules);
    await kit.storage.appendAudit({
      tenantId: "local",
      chatId: "-100",
      eventId: "tg_9",
      textSha256: await sha256Hex(phrase),
      action: "delete",
      score: 1,
      reasons: ["keyword_match"],
      evidence: [{ kind: "keyword", summary: phrase }],
      ruleIds: ["spam_keywords"],
      createdAt: "2026-11-01T00:00:00.000Z",
    });
    await handleIncomingEvent(
      await incoming({ text: "/appeal -100 tg_9 false", direct: true }),
      { ...kit, review },
    );
    expect(kit.reply.sent.at(-1)?.text).toBe("appeal -100 tg_9 误判");
    const queued = await review.list({ tenantId: "local" });
    expect(queued).toHaveLength(1);
    expect(queued[0]?.label).toBe("false_positive");
    expect(JSON.stringify(queued)).not.toContain(phrase);
    expect(await kit.storage.getRuleSet("local", "-100")).toEqual(rules);
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
    expect(
      kit.logger.entries.some((entry) => entry.message === "review_queued"),
    ).toBe(true);
    await handleIncomingEvent(
      await incoming({ text: "/evals -100", direct: true }),
      { ...kit, review },
    );
    const exported = kit.reply.sent.at(-1)?.text ?? "";
    const doc = JSON.parse(exported) as {
      cases: { label: string; text?: string }[];
    };
    expect(doc.cases[0]?.label).toBe("ham");
    expect(doc.cases[0]?.text).toBeUndefined();
    expect(exported).not.toContain(phrase);
    expect(await kit.storage.getRuleSet("local", "-100")).toEqual(rules);
  });

  it("shares a rule pack between the command and the next message", async () => {
    const kit = deps();
    const store = createMemoryRuleSubscriptionStore();
    const archive = createMemoryRulePackArchive();
    let calls = 0;
    const rulePacks = {
      store,
      archive,
      source: {
        async load() {
          calls += 1;
          if (calls > 1) {
            throw new Error(phrase);
          }
          return { version: 1, aggregate: "max", rules: [] };
        },
      },
    };
    const rateWindow = createMemoryRateWindow();
    await handleIncomingEvent(
      await incoming({ text: "/packs -100558 community", direct: true }),
      { ...kit, rulePacks, rateWindow },
    );
    expect(kit.reply.sent.at(-1)?.text).toBe("packs -100558 community");
    await handleIncomingEvent(
      await incoming({ text: "/rules -100558", direct: true }),
      { ...kit, rulePacks, rateWindow },
    );
    expect(kit.reply.sent.at(-1)?.text).toBe("rules -100558 community\nnone");
    await handleIncomingEvent(
      await incoming({ text: phrase, chatId: "-100558", actorId: "5" }),
      { ...kit, rulePacks, rateWindow },
    );
    expect(
      kit.logger.entries.some((entry) => entry.fields.action === "allow"),
    ).toBe(true);
    const again = deps();
    await handleIncomingEvent(
      await incoming({ text: phrase, chatId: "-100558", actorId: "5" }),
      {
        ...again,
        rulePacks,
        cache: createMemoryCache(),
        rateWindow: createMemoryRateWindow(),
      },
    );
    expect(
      again.logger.entries.some(
        (entry) => entry.message === "pack_update_failed",
      ),
    ).toBe(true);
    expect(
      again.logger.entries.some((entry) => entry.fields.action === "allow"),
    ).toBe(true);
    expect(JSON.stringify(again.logger.entries)).not.toContain(phrase);
    expect(calls).toBe(2);
  });

  it("reports a hit to the first admin without the message", async () => {
    const kit = deps();
    await handleIncomingEvent(
      await incoming({ text: phrase, chatId: "-100567", actorId: "5" }),
      {
        ...kit,
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
                  id: "watch",
                  enabled: true,
                  detectorIds: ["keyword"],
                  threshold: 1,
                  actions: ["report"],
                },
              ],
            };
          },
        },
      },
    );
    expect(kit.reply.sent).toHaveLength(1);
    expect(kit.reply.sent[0]?.chatId).toBe("42");
    expect(kit.reply.sent[0]?.text).toContain("keyword_match");
    expect(kit.reply.sent[0]?.text).not.toContain(phrase);
  });

  it("marks paused rules after the free quota without counting the command", async () => {
    const kit = deps();
    const policy = quotaPolicyFromEnv({
      QUOTA_ENABLED: "true",
      QUOTA_LIMIT: "1",
      QUOTA_BASIC: "keyword",
    });
    const store = createMemoryQuotaStore();
    const usage = {
      tenantId: "local",
      chatId: "-100",
      atIso: "2026-11-01T00:00:00.000Z",
      policy,
    };
    await store.consume(usage);
    await store.consume(usage);
    const before = await store.read(usage);
    await handleIncomingEvent(
      await incoming({ text: "/rules -100", direct: true }),
      {
        ...kit,
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
                  id: "spam_keywords",
                  enabled: true,
                  detectorIds: ["keyword"],
                  threshold: 1,
                  actions: ["delete"],
                },
                {
                  id: "llm_hint",
                  enabled: false,
                  detectorIds: ["llm"],
                  threshold: 1,
                  actions: ["log"],
                },
              ],
            };
          },
        },
        quota: { policy, store },
      },
    );
    const text = kit.reply.sent.at(-1)?.text ?? "";
    expect(text).toContain(
      "spam_keywords enabled file threshold 1 actions delete\n",
    );
    expect(text).toContain(
      "llm_hint disabled file threshold 1 actions log paused",
    );
    expect(await store.read(usage)).toEqual(before);
    expect(text).not.toContain(phrase);
  });

  it("answers /quota from configuration and does not echo the text", async () => {
    const kit = deps();
    await handleIncomingEvent(
      await incoming({ text: `/quota -100 ${phrase}`, direct: true }),
      {
        ...kit,
        quota: {
          policy: quotaPolicyFromEnv({
            QUOTA_ENABLED: "true",
            QUOTA_LIMIT: "3000",
          }),
          store: createMemoryQuotaStore(),
        },
      },
    );
    expect(kit.reply.sent[0]?.text).toBe("用法：/quota <chatId>");
    await handleIncomingEvent(
      await incoming({ text: "/quota -100", direct: true }),
      {
        ...kit,
        quota: {
          policy: quotaPolicyFromEnv({
            QUOTA_ENABLED: "true",
            QUOTA_LIMIT: "3000",
          }),
          store: createMemoryQuotaStore(),
        },
      },
    );
    expect(kit.reply.sent[1]?.text).toBe(
      "quota -100 0/3000 calendar_month full",
    );
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
  });

  it("lists the default basic detectors when /quota is degraded", async () => {
    const kit = deps();
    const policy = quotaPolicyFromEnv({
      QUOTA_ENABLED: "true",
      QUOTA_LIMIT: "1",
    });
    const store = createMemoryQuotaStore();
    const usage = {
      tenantId: "local",
      chatId: "-100",
      atIso: "2026-11-01T00:00:00.000Z",
      policy,
    };
    await store.consume(usage);
    await store.consume(usage);
    await handleIncomingEvent(
      await incoming({ text: "/quota -100", direct: true }),
      { ...kit, quota: { policy, store } },
    );
    const text = kit.reply.sent.at(-1)?.text ?? "";
    expect(defaultBasicDetectorIds.join(",")).toBe(
      "keyword,join,flood,repeat,link,blocklist,forward,regex",
    );
    expect(text).toBe(
      `quota -100 2/1 calendar_month basic\n${defaultBasicDetectorIds.join(",")}`,
    );
    expect(text).not.toContain("llm");
    expect(text).not.toContain(phrase);
  });

  it("lets the person who promoted the bot manage that chat", async () => {
    const kit = deps();
    const chats = createMemoryChatDirectory();
    const title = "机密群名";
    await handleIncomingEvent(
      parseEvent({
        id: "evt_bot",
        tenantId: "local",
        chatId: "-100586",
        kind: "bot_membership",
        occurredAt: "2026-11-01T00:00:00.000Z",
        actor: { id: "7", isAdmin: false },
        bot: "admin",
      }),
      { ...kit, chats },
    );
    expect(kit.reply.sent).toHaveLength(0);
    expect(JSON.stringify(kit.logger.entries)).not.toContain(title);
    await handleIncomingEvent(
      await incoming({ text: "/chats", direct: true, actorId: "7" }),
      { ...kit, chats, adminActorIds: ["42"] },
    );
    expect(kit.reply.sent[0]?.text).toBe("chats\n-100586");
    await handleIncomingEvent(
      await incoming({
        text: `/quota -100587 ${phrase}`,
        direct: true,
        actorId: "7",
      }),
      {
        ...kit,
        chats,
        adminActorIds: ["42"],
        quota: {
          policy: quotaPolicyFromEnv({ QUOTA_ENABLED: "true" }),
          store: createMemoryQuotaStore(),
        },
      },
    );
    expect(kit.reply.sent[1]?.text).toBe("用法：/quota <chatId>");
    await handleIncomingEvent(
      await incoming({ text: "/quota -100586", direct: true, actorId: "7" }),
      {
        ...kit,
        chats,
        adminActorIds: ["42"],
        quota: {
          policy: quotaPolicyFromEnv({ QUOTA_ENABLED: "true" }),
          store: createMemoryQuotaStore(),
        },
      },
    );
    expect(kit.reply.sent[2]?.text).toBe(
      "quota -100586 0/3000 calendar_month full",
    );
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
  });
});
