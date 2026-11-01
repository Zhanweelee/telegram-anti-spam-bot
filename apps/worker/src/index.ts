import {
  createSystemClock,
  type Event,
  expireChallenges,
  type Logger,
} from "@tasb/core";
import {
  createTelegramReply,
  handleTelegramWebhook,
} from "@tasb/platform-telegram";
import { Hono } from "hono";
import { workerCaptcha } from "./captcha-runtime.js";
import { handleIncomingEvent } from "./operate.js";
import { createWorkerLogger } from "./screen.js";
import { resolveStores } from "./stores.js";

export type DeploymentMode = "self-host" | "cloud";

export type WorkerBindings = {
  DEPLOYMENT_MODE?: string;
  WEBHOOK_SECRET?: string;
  TENANT_ID?: string;
  ADMIN_USER_IDS?: string;
  TELEGRAM_BOT_TOKEN?: string;
  DB?: D1Database;
  POLICY_KV?: KVNamespace;
};

export interface CreateAppOptions {
  readonly onEvent?: (event: Event) => Promise<void>;
  readonly nowIso?: () => string;
  readonly logger?: Logger;
}

export function normalizeDeploymentMode(
  value: string | undefined,
): DeploymentMode {
  return value === "cloud" ? "cloud" : "self-host";
}

export function normalizeTenantId(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length === 0 || trimmed.length > 128) {
    return "local";
  }
  return trimmed;
}

export function parseAdminUserIds(
  value: string | undefined,
): readonly string[] {
  if (!value) {
    return [];
  }
  const ids: string[] = [];
  for (const part of value.split(",")) {
    const id = part.trim();
    if (id.length === 0 || id.length > 128) {
      continue;
    }
    ids.push(id);
    if (ids.length >= 64) {
      break;
    }
  }
  return ids;
}

export function createApp(
  options: CreateAppOptions = {},
): Hono<{ Bindings: WorkerBindings }> {
  const app = new Hono<{ Bindings: WorkerBindings }>();
  const logger = options.logger ?? createWorkerLogger();

  app.get("/health", (c) => {
    return c.json({
      ok: true,
      service: "tasb",
      deploymentMode: normalizeDeploymentMode(c.env?.DEPLOYMENT_MODE),
    });
  });

  app.post("/telegram/webhook", (c) => {
    return handleTelegramWebhook(c.req.raw, {
      secretToken: c.env?.WEBHOOK_SECRET,
      tenantId: normalizeTenantId(c.env?.TENANT_ID),
      adminUserIds: parseAdminUserIds(c.env?.ADMIN_USER_IDS),
      logger,
      ...(options.nowIso ? { nowIso: options.nowIso } : {}),
      onEvent: async (event) => {
        if (options.onEvent) {
          await options.onEvent(event);
          return;
        }
        const stores = resolveStores(c.env ?? {});
        await handleIncomingEvent(event, {
          logger,
          adminActorIds: parseAdminUserIds(c.env?.ADMIN_USER_IDS),
          reply: createTelegramReply({ token: c.env?.TELEGRAM_BOT_TOKEN }),
          storage: stores.storage,
          policyStore: stores.policyStore,
          ...(c.env?.TELEGRAM_BOT_TOKEN
            ? { botToken: c.env.TELEGRAM_BOT_TOKEN }
            : {}),
        });
      },
      ...(c.env?.TELEGRAM_BOT_TOKEN
        ? { botToken: c.env.TELEGRAM_BOT_TOKEN }
        : {}),
    });
  });

  app.all("*", (c) => c.json({ ok: false, error: "not_found" }, 404));
  return app;
}

const app = createApp();

export async function runScheduled(env: WorkerBindings = {}): Promise<void> {
  const logger = createWorkerLogger();
  const stores = resolveStores(env);
  try {
    await expireChallenges({
      store: workerCaptcha,
      storage: stores.storage,
      async restrict() {},
      async release() {},
      clock: createSystemClock(),
      logger,
    });
  } catch {
    logger.error("captcha_expire_failed", {});
  }
}

export default {
  fetch: app.fetch.bind(app),
  scheduled(
    _controller: ScheduledController,
    env: WorkerBindings,
  ): Promise<void> {
    return runScheduled(env);
  },
};
