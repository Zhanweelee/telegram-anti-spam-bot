import { createMemoryModerator } from "@tasb/adapter-memory";
import { createMemoryLogger } from "@tasb/core";
import { createMemoryRateWindow } from "@tasb/detector-rate";
import { describe, expect, it } from "vitest";
import { createWebhookBudget } from "./budget.js";
import { workerCaptcha } from "./captcha-runtime.js";
import {
  createApp,
  normalizeDeploymentMode,
  normalizeLocale,
  normalizeTenantId,
  parseAdminUserIds,
  runScheduled,
} from "./index.js";
import { workerRuntime, workerStorage } from "./screen.js";

const SECRET = "dev-secret";

const textUpdate = {
  update_id: 1001,
  message: {
    message_id: 10,
    date: 1761955200,
    chat: { id: -100123, type: "supergroup" },
    from: { id: 42 },
    text: "hello",
  },
};

describe("worker", () => {
  const app = createApp();

  it("reports deployment mode from the binding", async () => {
    expect(normalizeDeploymentMode(undefined)).toBe("self-host");
    expect(normalizeDeploymentMode("nope")).toBe("self-host");
    expect(normalizeDeploymentMode("cloud")).toBe("cloud");

    const selfHost = await app.request(
      "/health",
      {},
      { DEPLOYMENT_MODE: "self-host" },
    );
    expect(await selfHost.json()).toEqual({
      ok: true,
      service: "tasb",
      deploymentMode: "self-host",
    });

    const cloud = await app.request(
      "/health",
      {},
      { DEPLOYMENT_MODE: "cloud" },
    );
    expect(await cloud.json()).toEqual({
      ok: true,
      service: "tasb",
      deploymentMode: "cloud",
    });

    const missing = await app.request("/health");
    expect(await missing.json()).toEqual({
      ok: true,
      service: "tasb",
      deploymentMode: "self-host",
    });
  });

  it("returns not_found for unknown routes", async () => {
    const response = await app.request("/nope", { method: "POST" });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ ok: false, error: "not_found" });
  });

  it("parses tenant and admin bindings", () => {
    expect(normalizeTenantId(undefined)).toBe("local");
    expect(normalizeTenantId("  acme  ")).toBe("acme");
    expect(normalizeTenantId("x".repeat(129))).toBe("local");
    expect(parseAdminUserIds(undefined)).toEqual([]);
    expect(parseAdminUserIds(" 42, ,7 ")).toEqual(["42", "7"]);
    expect(normalizeLocale(undefined)).toBeUndefined();
    expect(normalizeLocale("nope")).toBeUndefined();
    expect(normalizeLocale("en")).toBe("en");
    expect(normalizeLocale("zh")).toBe("zh");
  });
});

describe("POST /telegram/webhook", () => {
  it("returns 401 and does not call the pipeline without a secret", async () => {
    let calls = 0;
    const app = createApp({
      onEvent: async () => {
        calls += 1;
      },
    });
    const response = await app.request(
      "/telegram/webhook",
      {
        method: "POST",
        body: JSON.stringify(textUpdate),
      },
      {},
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      ok: false,
      error: "unauthorized",
    });
    expect(calls).toBe(0);
  });

  it("returns 401 for a wrong secret and does not call the pipeline", async () => {
    let calls = 0;
    const app = createApp({
      onEvent: async () => {
        calls += 1;
      },
    });
    const response = await app.request(
      "/telegram/webhook",
      {
        method: "POST",
        headers: { "x-telegram-bot-api-secret-token": "wrong" },
        body: JSON.stringify(textUpdate),
      },
      { WEBHOOK_SECRET: SECRET },
    );
    expect(response.status).toBe(401);
    expect(calls).toBe(0);
  });

  it("normalizes a valid update inside the worker", async () => {
    const seen: { chatId?: string; isAdmin?: boolean; tenantId?: string }[] =
      [];
    const app = createApp({
      onEvent: async (event) => {
        seen.push({
          chatId: event.chatId,
          isAdmin: event.actor.isAdmin,
          tenantId: event.tenantId,
        });
      },
    });
    const response = await app.request(
      "/telegram/webhook",
      {
        method: "POST",
        headers: { "x-telegram-bot-api-secret-token": SECRET },
        body: JSON.stringify({
          ...textUpdate,
          message: { ...textUpdate.message, sender_chat: { id: -100123 } },
        }),
      },
      { WEBHOOK_SECRET: SECRET, TENANT_ID: "acme", ADMIN_USER_IDS: "42" },
    );
    const raw = await response.text();
    expect(response.status).toBe(200);
    expect(raw).not.toContain("hello");
    expect(JSON.parse(raw)).toEqual({ ok: true });
    expect(seen).toEqual([
      { chatId: "-100123", isAdmin: true, tenantId: "acme" },
    ]);
  });

  it("does not echo a private command when the bot token is unset", async () => {
    const phrase = "请免费领取礼品";
    const logger = createMemoryLogger();
    const app = createApp({ logger });
    const response = await app.request(
      "/telegram/webhook",
      {
        method: "POST",
        headers: { "x-telegram-bot-api-secret-token": SECRET },
        body: JSON.stringify({
          update_id: 80,
          message: {
            message_id: 1,
            date: 1761955200,
            chat: { id: 42, type: "private" },
            from: { id: 42 },
            text: `/help ${phrase}`,
          },
        }),
      },
      { WEBHOOK_SECRET: SECRET, ADMIN_USER_IDS: "42" },
    );
    const raw = await response.text();
    expect(response.status).toBe(200);
    expect(raw).not.toContain(phrase);
    const logged = JSON.stringify(logger.entries);
    expect(logged).toContain("reply_failed");
    expect(logged).not.toContain(phrase);
  });

  it("stores a private rule switch in POLICY_KV", async () => {
    const values = new Map<string, string>();
    const kv = {
      async get(key: string) {
        return values.get(key) ?? null;
      },
      async put(key: string, value: string) {
        values.set(key, value);
      },
    };
    const app = createApp();
    const response = await app.request(
      "/telegram/webhook",
      {
        method: "POST",
        headers: { "x-telegram-bot-api-secret-token": SECRET },
        body: JSON.stringify({
          update_id: 81,
          message: {
            message_id: 2,
            date: 1761955200,
            chat: { id: 42, type: "private" },
            from: { id: 42 },
            text: "/rule -100 via_inline on",
          },
        }),
      },
      {
        WEBHOOK_SECRET: SECRET,
        ADMIN_USER_IDS: "42",
        POLICY_KV: kv as unknown as KVNamespace,
      },
    );
    const raw = await response.text();
    expect(response.status).toBe(200);
    expect(raw).not.toContain("via_inline");
    expect([...values.values()].join("\n")).toContain("via_inline");
  });

  it("stores the granting user in POLICY_KV without the chat title", async () => {
    const title = "机密群名";
    const values = new Map<string, string>();
    const kv = {
      async get(key: string) {
        return values.get(key) ?? null;
      },
      async put(key: string, value: string) {
        values.set(key, value);
      },
    };
    const app = createApp();
    const response = await app.request(
      "/telegram/webhook",
      {
        method: "POST",
        headers: { "x-telegram-bot-api-secret-token": SECRET },
        body: JSON.stringify({
          update_id: 82,
          my_chat_member: {
            chat: { id: -100586, type: "supergroup", title },
            from: { id: 7, first_name: title },
            date: 1761955200,
            old_chat_member: {
              user: { id: 99, is_bot: true },
              status: "left",
            },
            new_chat_member: {
              user: { id: 99, is_bot: true },
              status: "administrator",
            },
          },
        }),
      },
      {
        WEBHOOK_SECRET: SECRET,
        POLICY_KV: kv as unknown as KVNamespace,
      },
    );
    const raw = await response.text();
    expect(response.status).toBe(200);
    expect(raw).not.toContain(title);
    const saved = [...values.values()].join("\n");
    expect(saved).toContain("-100586");
    expect(saved).toContain('"7"');
    expect(saved).not.toContain(title);
  });

  it("stores a private pack subscription in POLICY_KV", async () => {
    const values = new Map<string, string>();
    const kv = {
      async get(key: string) {
        return values.get(key) ?? null;
      },
      async put(key: string, value: string) {
        values.set(key, value);
      },
    };
    const app = createApp();
    const response = await app.request(
      "/telegram/webhook",
      {
        method: "POST",
        headers: { "x-telegram-bot-api-secret-token": SECRET },
        body: JSON.stringify({
          update_id: 83,
          message: {
            message_id: 3,
            date: 1761955200,
            chat: { id: 42, type: "private" },
            from: { id: 42 },
            text: "/packs -100 community",
          },
        }),
      },
      {
        WEBHOOK_SECRET: SECRET,
        ADMIN_USER_IDS: "42",
        POLICY_KV: kv as unknown as KVNamespace,
      },
    );
    const raw = await response.text();
    expect(response.status).toBe(200);
    expect(raw).not.toContain("community");
    expect([...values.values()].join("\n")).toContain("community");
  });

  it("screens with the default pipeline and omits message text from the body", async () => {
    const spam = "请免费领取礼品";
    const app = createApp();
    const response = await app.request(
      "/telegram/webhook",
      {
        method: "POST",
        headers: { "x-telegram-bot-api-secret-token": SECRET },
        body: JSON.stringify({
          ...textUpdate,
          message: { ...textUpdate.message, text: spam },
        }),
      },
      { WEBHOOK_SECRET: SECRET },
    );
    const raw = await response.text();
    expect(response.status).toBe(200);
    expect(raw).not.toContain(spam);
    expect(JSON.parse(raw)).toEqual({ ok: true });
  });

  it("sheds one chat after the budget and still screens another", async () => {
    const phrase = "加微x看看";
    const logger = createMemoryLogger();
    let calls = 0;
    const app = createApp({
      logger,
      webhookBudget: createWebhookBudget(createMemoryRateWindow(), 2),
      onEvent: async () => {
        calls += 1;
      },
    });
    let updateId = 5800;
    const send = (chatId: number) => {
      updateId += 1;
      return app.request(
        "/telegram/webhook",
        {
          method: "POST",
          headers: { "x-telegram-bot-api-secret-token": SECRET },
          body: JSON.stringify({
            update_id: updateId,
            message: {
              message_id: 10,
              date: 1761955200,
              chat: { id: chatId, type: "supergroup" },
              from: { id: 7 },
              text: phrase,
            },
          }),
        },
        { WEBHOOK_SECRET: SECRET },
      );
    };
    const first = await send(-100580);
    const second = await send(-100580);
    const third = await send(-100580);
    const other = await send(-100581);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true });
    expect(await second.json()).toEqual({ ok: true });
    expect(await third.json()).toEqual({ ok: true, limited: true });
    expect(await other.json()).toEqual({ ok: true });
    expect(calls).toBe(3);
    const logged = JSON.stringify(logger.entries);
    expect(logged).toContain("webhook_limited");
    expect(logged).not.toContain(phrase);
  });

  it("counts one update once against the webhook budget", async () => {
    const phrase = "加微x看看";
    let calls = 0;
    const app = createApp({
      webhookBudget: createWebhookBudget(createMemoryRateWindow(), 1),
      onEvent: async () => {
        calls += 1;
      },
    });
    const send = (updateId: number) =>
      app.request(
        "/telegram/webhook",
        {
          method: "POST",
          headers: { "x-telegram-bot-api-secret-token": SECRET },
          body: JSON.stringify({
            update_id: updateId,
            message: {
              message_id: 10,
              date: 1761955200,
              chat: { id: -100586, type: "supergroup" },
              from: { id: 7 },
              text: phrase,
            },
          }),
        },
        { WEBHOOK_SECRET: SECRET },
      );
    const first = await send(5860);
    const retry = await send(5860);
    const next = await send(5861);
    const nextBody = await next.text();
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true });
    expect(await retry.json()).toEqual({ ok: true });
    expect(JSON.parse(nextBody)).toEqual({ ok: true, limited: true });
    expect(calls).toBe(2);
    expect(nextBody).not.toContain(phrase);
  });

  it("expires a D1 captcha from the scheduled handler", async () => {
    const queries: string[] = [];
    const db = {
      prepare(sql: string) {
        queries.push(sql);
        const statement = {
          bind() {
            return statement;
          },
          async all() {
            return { results: [] };
          },
          async run() {
            return {};
          },
        };
        return statement;
      },
    };
    await runScheduled({ DB: db as unknown as D1Database });
    expect(queries.some((sql) => sql.includes("captcha_challenges"))).toBe(
      true,
    );
  });

  it("audits an expired captcha without storing the nonce", async () => {
    const nonce = "abcdef0123456789";
    await workerCaptcha.put({
      tenantId: "cron_tenant",
      chatId: "cron_chat",
      actorId: "cron_actor",
      nonce,
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    await runScheduled();
    const rows = await workerStorage.exportAudits({ tenantId: "cron_tenant" });
    expect(rows.some((row) => row.reasons.includes("captcha_expired"))).toBe(
      true,
    );
    expect(JSON.stringify(rows)).not.toContain(nonce);
    expect(
      await workerCaptcha.get("cron_tenant", "cron_chat", "cron_actor"),
    ).toBe(null);
    await workerStorage.deleteAudits({ tenantId: "cron_tenant" });
  });

  it("kicks from the scheduled handler when that chat asked", async () => {
    const nonce = "fedcba9876543210";
    const moderator = createMemoryModerator();
    await workerCaptcha.put({
      tenantId: "cron_tenant",
      chatId: "cron_chat",
      actorId: "cron_kick",
      nonce,
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    expect(
      await workerRuntime.setCaptchaFail("cron_tenant", "cron_chat", "kick"),
    ).toBe(true);
    try {
      await runScheduled({}, { moderator });
      expect(moderator.kicked).toEqual([
        {
          tenantId: "cron_tenant",
          chatId: "cron_chat",
          actorId: "cron_kick",
        },
      ]);
      expect(moderator.banned).toEqual([]);
      const rows = await workerStorage.exportAudits({
        tenantId: "cron_tenant",
      });
      expect(JSON.stringify(rows)).not.toContain(nonce);
    } finally {
      await workerRuntime.clearCaptchaFail("cron_tenant", "cron_chat");
      await workerStorage.deleteAudits({ tenantId: "cron_tenant" });
    }
  });
});
