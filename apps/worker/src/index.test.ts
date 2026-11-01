import { createMemoryLogger } from "@tasb/core";
import { describe, expect, it } from "vitest";
import {
  createApp,
  normalizeDeploymentMode,
  normalizeTenantId,
  parseAdminUserIds,
} from "./index.js";

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
});
