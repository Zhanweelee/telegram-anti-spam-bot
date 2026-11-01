/**
 * Telegram platform adapter.
 * Webhook verification and Update → Event normalization are P0.
 * Transport will be a thin fetch wrapper. grammY stays out until command
 * routing is complex enough to justify the dependency. See ADR 0001.
 */
export const telegramPlatform = {
  id: "telegram",
  version: "0.0.0",
  transport: "fetch",
} as const;
