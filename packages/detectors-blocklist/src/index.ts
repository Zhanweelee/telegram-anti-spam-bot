import {
  type BlocklistEntry,
  type BlocklistStore,
  blocklistEntrySchema,
  type DetectContext,
  type Detector,
  type DetectorHit,
  defineDetector,
} from "@tasb/core";
import { z } from "zod";

const configSchema = z.strictObject({});

export interface BlocklistDetectorDeps {
  readonly store: BlocklistStore;
}

export function createBlocklistDetector(deps: BlocklistDetectorDeps): Detector {
  return defineDetector({
    id: "blocklist",
    version: "0.1.0",
    capabilities: ["blocklist"],
    configSchema,
    config: {},
    async detect(ctx) {
      let enabled = false;
      try {
        enabled = await deps.store.isEnabled(
          ctx.event.tenantId,
          ctx.event.chatId,
        );
      } catch {
        warn(ctx);
        return null;
      }
      if (!enabled) {
        return null;
      }
      try {
        const pending = candidates(
          ctx.event.actor.id,
          ctx.event.message?.textSha256,
        );
        for (const entry of pending) {
          if (await deps.store.has(ctx.event.tenantId, entry)) {
            return hit(entry);
          }
        }
      } catch {
        warn(ctx);
        return null;
      }
      return null;
    },
  });
}

function candidates(
  actorId: string,
  textSha256: string | undefined,
): BlocklistEntry[] {
  const found: BlocklistEntry[] = [];
  const actor = blocklistEntrySchema.safeParse({
    kind: "actor",
    value: actorId,
  });
  if (actor.success) {
    found.push(actor.data);
  }
  if (textSha256 !== undefined) {
    const hash = blocklistEntrySchema.safeParse({
      kind: "hash",
      value: textSha256,
    });
    if (hash.success) {
      found.push(hash.data);
    }
  }
  return found;
}

function hit(entry: BlocklistEntry): DetectorHit {
  return {
    detectorId: "blocklist",
    score: 1,
    reasons: [entry.kind === "actor" ? "shared_actor" : "shared_hash"],
    evidence: [{ kind: evidenceKind(entry), summary: summaryFor(entry) }],
  };
}

function evidenceKind(entry: BlocklistEntry): "feature" | "hash" {
  return entry.kind === "hash" ? "hash" : "feature";
}

function summaryFor(entry: BlocklistEntry): string {
  if (entry.kind === "hash") {
    return `hash:${entry.value.slice(0, 8)}`;
  }
  return `actor:${entry.value}`.slice(0, 120);
}

function warn(ctx: DetectContext): void {
  ctx.logger.warn("blocklist_failed", {
    eventId: ctx.event.id,
    chatId: ctx.event.chatId,
    detectorId: "blocklist",
  });
}
