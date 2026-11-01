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
      if (id === "repeat" && message.text.length === 0) {
        return null;
      }
      const key =
        id === "flood"
          ? floodKey(ctx.event)
          : repeatKey(ctx.event, message.textSha256);
      let count: number | null;
      try {
        count = await config.window.observe({
          key,
          nowMs: Date.parse(ctx.event.occurredAt),
          windowMs: parsed.windowSeconds * 1000,
        });
      } catch {
        ctx.logger.warn("rate_window_failed", {
          eventId: ctx.event.id,
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

function repeatKey(event: Event, textSha256: string): string {
  return `r\n${event.tenantId}\n${event.chatId}\n${textSha256}`;
}
