/**
 * Hot-path cache. Values are opaque strings so the port stays free of
 * domain types. Adapters decide whether this is process memory or KV.
 * Durable stores such as D1 stay behind a miss, not on every event.
 */
export interface Cache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}
