import {
  createBanAction,
  createDeleteAction,
  createMuteAction,
} from "@tasb/actions";
import {
  createMemoryCache,
  createMemoryModerator,
  createMemoryPolicyStore,
  createMemoryRuntimeStore,
  createMemoryStorage,
} from "@tasb/adapter-memory";
import {
  type Cache,
  defaultPrefilterPolicy,
  type Event,
  type Logger,
  loadPolicy,
  loadRuleSet,
  type PipelineResult,
  type PolicyStore,
  type RuleSource,
  type RuntimeStore,
  runPipeline,
  type Storage,
  wrapLogger,
} from "@tasb/core";
import { createKeywordDetector } from "@tasb/detector-keyword";
import { fileRuleSource } from "./rules.js";

/**
 * Isolate-local cache, policy, dry-run, and audits. A rule miss reads
 * the bundled files, not D1. The moderator is still per request and
 * does not call Telegram. Audits are capped at 200 rows.
 */
export const workerCache = createMemoryCache();
export const workerPolicyStore = createMemoryPolicyStore();
export const workerRuntime = createMemoryRuntimeStore();
export const workerStorage = createMemoryStorage({ maxAudits: 200 });

const detector = createKeywordDetector({
  keywords: ["免费领取", "加微信"],
});

export function createWorkerLogger(): Logger {
  return wrapLogger({
    info(message, fields) {
      console.info(JSON.stringify({ level: "info", message, ...fields }));
    },
    warn(message, fields) {
      console.warn(JSON.stringify({ level: "warn", message, ...fields }));
    },
    error(message, fields) {
      console.error(JSON.stringify({ level: "error", message, ...fields }));
    },
  });
}

export interface ScreenDeps {
  readonly logger?: Logger;
  readonly cache?: Cache;
  readonly source?: RuleSource;
  readonly storage?: Storage;
  readonly policyStore?: PolicyStore;
  readonly runtime?: RuntimeStore;
}

export async function screenTelegramEvent(
  event: Event,
  deps: ScreenDeps = {},
): Promise<PipelineResult> {
  const logger = deps.logger ?? createWorkerLogger();
  const rules = await loadRuleSet({
    tenantId: event.tenantId,
    chatId: event.chatId,
    cache: deps.cache ?? workerCache,
    source: deps.source ?? fileRuleSource,
    logger,
  });
  const policy = await loadPolicy({
    tenantId: event.tenantId,
    chatId: event.chatId,
    cache: deps.cache ?? workerCache,
    store: deps.policyStore ?? workerPolicyStore,
    logger,
    fallback: defaultPrefilterPolicy,
  });
  let dryRun = false;
  try {
    dryRun = await (deps.runtime ?? workerRuntime).getDryRun(
      event.tenantId,
      event.chatId,
    );
  } catch {
    logger.warn("runtime_failed", {
      eventId: event.id,
      chatId: event.chatId,
    });
  }
  const result = await runPipeline({
    event,
    rules,
    policy,
    dryRun,
    detectors: [detector],
    actions: [
      createDeleteAction(),
      createMuteAction({ durationSeconds: 60 * 60 }),
      createBanAction(),
    ],
    storage: deps.storage ?? workerStorage,
    moderator: createMemoryModerator(),
    logger,
  });
  logger.info("webhook_screened", {
    eventId: result.eventId,
    chatId: event.chatId,
    action: result.decision.action,
    outcome: result.outcome,
  });
  return result;
}
