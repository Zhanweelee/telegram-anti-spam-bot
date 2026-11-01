import type { Event, Logger } from "@tasb/core";
import { normalizeUpdate } from "./normalize.js";
import { secretsMatch } from "./secret.js";

export const TELEGRAM_SECRET_HEADER = "x-telegram-bot-api-secret-token";
export const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;

export interface WebhookDependencies {
  readonly secretToken: string | undefined;
  readonly tenantId: string;
  readonly adminUserIds?: readonly string[];
  readonly onEvent: (event: Event) => Promise<void>;
  readonly nowIso?: () => string;
  readonly logger?: Logger;
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
  if (outcome.status === "ignored") {
    deps.logger?.info("webhook_ignored", {});
    return json(200, { ok: true, ignored: true });
  }

  try {
    await deps.onEvent(outcome.event);
  } catch {
    deps.logger?.error("webhook_screen_failed", {
      eventId: outcome.event.id,
      chatId: outcome.event.chatId,
    });
  }
  return json(200, { ok: true });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
