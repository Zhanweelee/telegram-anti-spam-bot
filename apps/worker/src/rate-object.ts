import { DurableObject } from "cloudflare:workers";
import { createMemoryRateWindow, type RateWindow } from "@tasb/detector-rate";

type RateObservation = Parameters<RateWindow["observe"]>[0];

/**
 * Optional cross-isolate flood and repeat counts.
 * The committed wrangler config does not bind this class. One instance
 * serves one chat and one detector kind. Counts live in the object, so
 * an eviction undercounts and does not write SQLite rows.
 */
export class RateWindowObject extends DurableObject {
  private readonly window: RateWindow = createMemoryRateWindow();

  observe(input: RateObservation): Promise<number | null> {
    return this.window.observe(input);
  }
}

export interface RateWindowNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): unknown;
}

export function rateWindowFromEnv(env: {
  RATE_WINDOW?: RateWindowNamespace;
}): RateWindow | undefined {
  if (env.RATE_WINDOW === undefined) {
    return undefined;
  }
  return createDurableRateWindow(env.RATE_WINDOW);
}

export function createDurableRateWindow(
  namespace: RateWindowNamespace,
): RateWindow {
  return {
    async observe(input) {
      if (
        input.key.length === 0 ||
        !Number.isFinite(input.nowMs) ||
        !Number.isFinite(input.windowMs) ||
        input.windowMs <= 0
      ) {
        return null;
      }
      try {
        const stub = namespace.get(
          namespace.idFromName(shardName(input.key)),
        ) as {
          observe(value: RateObservation): Promise<number | null>;
        };
        return await stub.observe(input);
      } catch {
        throw new Error("rate_window_unavailable");
      }
    },
  };
}

function shardName(key: string): string {
  const parts = key.split("\n");
  const kind = parts[0];
  const tenantId = parts[1];
  const chatId = parts[2];
  if (
    parts.length >= 3 &&
    kind !== undefined &&
    kind.length > 0 &&
    tenantId !== undefined &&
    tenantId.length > 0 &&
    chatId !== undefined &&
    chatId.length > 0
  ) {
    return `${kind}\n${tenantId}\n${chatId}`;
  }
  return key.slice(0, 128);
}
