import type { Event, Logger } from "@tasb/core";
import { handleTelegramWebhook } from "@tasb/platform-telegram";
import { Hono } from "hono";
import { createWorkerLogger, screenTelegramEvent } from "./screen.js";

export type DeploymentMode = "self-host" | "cloud";

export type WorkerBindings = {
  DEPLOYMENT_MODE?: string;
  WEBHOOK_SECRET?: string;
  TENANT_ID?: string;
  ADMIN_USER_IDS?: string;
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
        await screenTelegramEvent(event, logger);
      },
    });
  });

  app.all("*", (c) => c.json({ ok: false, error: "not_found" }, 404));
  return app;
}

const app = createApp();

export default app;
