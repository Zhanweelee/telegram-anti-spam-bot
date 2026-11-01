/**
 * Cloudflare bindings adapter.
 * D1 / KV / Queues / Durable Objects implementations land with P0 storage.
 * This module must not be imported by @tasb/core.
 */
export const cloudflareAdapter = {
  id: "cloudflare",
  version: "0.0.0",
  plannedBindings: ["d1", "kv", "queues", "durable_objects"],
} as const;
