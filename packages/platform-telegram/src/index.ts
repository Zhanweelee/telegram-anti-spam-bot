/**
 * Telegram platform adapter.
 * Verifies `secret_token` and normalizes updates into core Events.
 * Transport is a thin fetch wrapper. grammY stays out until command routing
 * justifies the dependency. See ADR 0001.
 */
export { sha256Hex } from "./hash.js";
export {
  answerCallbackQuery,
  captchaPrompt,
  createTelegramModerator,
  sendCaptchaButton,
} from "./moderate.js";
export { type NormalizeOutcome, normalizeUpdate } from "./normalize.js";
export { createTelegramReply } from "./reply.js";
export { secretsMatch } from "./secret.js";
export {
  handleTelegramWebhook,
  MAX_WEBHOOK_BODY_BYTES,
  TELEGRAM_SECRET_HEADER,
  type WebhookDependencies,
} from "./webhook.js";

export const telegramPlatform = {
  id: "telegram",
  version: "0.1.0",
  transport: "fetch",
} as const;
