import { type Detector, defineDetector, type Event } from "@tasb/core";
import { z } from "zod";
import type { RateWindow } from "./window.js";

export { createMemoryRateWindow, type RateWindow } from "./window.js";

export const rateConfigSchema = z.strictObject({
  windowSeconds: z.number().int().positive().max(300),
  threshold: z.number().int().min(2).max(32),
});

export type RateConfig = z.input<typeof rateConfigSchema>;

export interface RateDetectorDeps extends RateConfig {
  readonly window: RateWindow;
}

export function createFloodDetector(config: RateDetectorDeps): Detector {
  return createRateDetector("flood", config);
}

export function createRepeatDetector(config: RateDetectorDeps): Detector {
  return createRateDetector("repeat", config);
}

function createRateDetector(
  id: "flood" | "repeat",
  config: RateDetectorDeps,
): Detector {
  return defineDetector({
    id,
    version: "0.1.0",
    capabilities: ["rate"],
    configSchema: rateConfigSchema,
    config: {
      windowSeconds: config.windowSeconds,
      threshold: config.threshold,
    },
    async detect(ctx, parsed) {
      const message = ctx.event.message;
      if (!message) {
        return null;
      }
      let key: string;
      if (id === "flood") {
        key = floodKey(ctx.event);
      } else {
        const digest = repeatDigest(message);
        if (digest === null) {
          return null;
        }
        key = repeatKey(ctx.event, digest);
      }
      let count: number | null;
      try {
        count = await config.window.observe({
          key,
          nowMs: Date.parse(ctx.event.occurredAt),
          windowMs: parsed.windowSeconds * 1000,
          eventId: ctx.event.id,
        });
      } catch {
        ctx.logger.warn("rate_window_failed", {
          eventId: ctx.event.id,
          tenantId: ctx.event.tenantId,
          chatId: ctx.event.chatId,
          detectorId: id,
        });
        return null;
      }
      if (count === null) {
        ctx.logger.warn("rate_window_skipped", {
          eventId: ctx.event.id,
          chatId: ctx.event.chatId,
          detectorId: id,
        });
        return null;
      }
      if (count < parsed.threshold) {
        return null;
      }
      return {
        detectorId: id,
        score: 1,
        reasons: [id],
        evidence: [{ kind: "feature" as const, summary: `${id}:${count}` }],
      };
    },
  });
}

function floodKey(event: Event): string {
  return `f\n${event.tenantId}\n${event.chatId}\n${event.actor.id}`;
}

function repeatDigest(message: NonNullable<Event["message"]>): string | null {
  if (message.text.length > 0) {
    return message.textSha256;
  }
  return message.mediaSha256 ?? null;
}

function repeatKey(event: Event, digest: string): string {
  return `r\n${event.tenantId}\n${event.chatId}\n${digest}`;
}
