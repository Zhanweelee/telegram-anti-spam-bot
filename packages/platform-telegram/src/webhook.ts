import type { Event, Logger } from "@tasb/core";
import { answerCallbackQuery, captchaDecoyHint } from "./moderate.js";
import { normalizeUpdate } from "./normalize.js";
import { secretsMatch } from "./secret.js";

export const TELEGRAM_SECRET_HEADER = "x-telegram-bot-api-secret-token";
export const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;

export interface WebhookDependencies {
  readonly secretToken: string | undefined;
  readonly tenantId: string;
  readonly adminUserIds?: readonly string[];
  readonly onEvent: (event: Event) => Promise<void>;
  /** Return "limited" to skip the pipeline and answer 200. */
  readonly gate?: (event: Event) => Promise<"allow" | "limited">;
  readonly nowIso?: () => string;
  readonly logger?: Logger;
  readonly botToken?: string;
  readonly fetchImpl?: typeof fetch;
}

export async function handleTelegramWebhook(
  request: Request,
  deps: WebhookDependencies,
): Promise<Response> {
  const configured = deps.secretToken ?? "";
  if (configured.length === 0) {
    deps.logger?.warn("webhook_unauthorized", { reason: "secret_unset" });
    return json(401, { ok: false, error: "unauthorized" });
  }
  const provided = request.headers.get(TELEGRAM_SECRET_HEADER) ?? "";
  const allowed = await secretsMatch(provided, configured);
  if (!allowed) {
    deps.logger?.warn("webhook_unauthorized", { reason: "secret_mismatch" });
    return json(401, { ok: false, error: "unauthorized" });
  }

  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_WEBHOOK_BODY_BYTES) {
    deps.logger?.warn("webhook_payload_too_large", {});
    return json(413, { ok: false, error: "payload_too_large" });
  }
  const raw = await request.text();
  if (raw.length > MAX_WEBHOOK_BODY_BYTES) {
    deps.logger?.warn("webhook_payload_too_large", {});
    return json(413, { ok: false, error: "payload_too_large" });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    deps.logger?.warn("webhook_invalid_json", {});
    return json(400, { ok: false, error: "invalid_json" });
  }

  const outcome = await normalizeUpdate({
    update: parsed,
    tenantId: deps.tenantId,
    adminUserIds: deps.adminUserIds ?? [],
    nowIso: deps.nowIso?.() ?? new Date().toISOString(),
  });
  if (outcome.status === "invalid") {
    deps.logger?.warn("webhook_invalid_update", {});
    return json(400, { ok: false, error: "invalid_update" });
  }
  const callbackId = callbackQueryId(parsed);
  if (outcome.status === "ignored") {
    deps.logger?.info("webhook_ignored", {});
    await ackCallback(callbackId, deps, decoyHint(parsed));
    return json(200, { ok: true, ignored: true });
  }

  let limited = false;
  if (deps.gate) {
    try {
      limited = (await deps.gate(outcome.event)) === "limited";
    } catch {
      deps.logger?.warn("webhook_budget_failed", {
        eventId: outcome.event.id,
        chatId: outcome.event.chatId,
        tenantId: outcome.event.tenantId,
      });
    }
  }
  if (limited) {
    deps.logger?.warn("webhook_limited", {
      eventId: outcome.event.id,
      chatId: outcome.event.chatId,
      tenantId: outcome.event.tenantId,
    });
    await ackCallback(callbackId, deps);
    return json(200, { ok: true, limited: true });
  }

  try {
    await deps.onEvent(outcome.event);
  } catch {
    deps.logger?.error("webhook_screen_failed", {
      eventId: outcome.event.id,
      chatId: outcome.event.chatId,
    });
  }
  await ackCallback(callbackId, deps);
  return json(200, { ok: true });
}

function callbackQueryId(update: unknown): string | null {
  if (!isRecord(update) || !isRecord(update.callback_query)) {
    return null;
  }
  const id = update.callback_query.id;
  if (typeof id !== "string" || id.length === 0 || id.length > 256) {
    return null;
  }
  return id;
}

async function ackCallback(
  callbackId: string | null,
  deps: WebhookDependencies,
  text?: string,
): Promise<void> {
  if (!callbackId) {
    return;
  }
  const token = deps.botToken?.trim() ?? "";
  if (token.length === 0) {
    return;
  }
  try {
    await answerCallbackQuery({
      token,
      callbackId,
      ...(text !== undefined ? { text } : {}),
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    });
  } catch {
    deps.logger?.warn("callback_ack_failed", {});
  }
}

function decoyHint(update: unknown): string | undefined {
  if (!isRecord(update) || !isRecord(update.callback_query)) {
    return undefined;
  }
  const data = update.callback_query.data;
  if (typeof data === "string" && /^n:[a-f0-9]{16}$/.test(data)) {
    return captchaDecoyHint;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
