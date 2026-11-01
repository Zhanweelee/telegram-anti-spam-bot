import {
  createBanAction,
  createDeleteAction,
  createMuteAction,
} from "@tasb/actions";
import {
  createMemoryCache,
  createMemoryModerator,
  createMemoryPolicyStore,
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
  runPipeline,
  type Storage,
  wrapLogger,
} from "@tasb/core";
import { createKeywordDetector } from "@tasb/detector-keyword";
import { fileRuleSource } from "./rules.js";

/**
 * Isolate-local cache. A miss reads the bundled rule files, not D1.
 * The moderator is still per request and does not call Telegram.
 */
const ruleCache = createMemoryCache();
const defaultPolicyStore = createMemoryPolicyStore();

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
}

export async function screenTelegramEvent(
  event: Event,
  deps: ScreenDeps = {},
): Promise<PipelineResult> {
  const logger = deps.logger ?? createWorkerLogger();
  const rules = await loadRuleSet({
    tenantId: event.tenantId,
    chatId: event.chatId,
    cache: deps.cache ?? ruleCache,
    source: deps.source ?? fileRuleSource,
    logger,
  });
  const policy = await loadPolicy({
    tenantId: event.tenantId,
    chatId: event.chatId,
    cache: deps.cache ?? ruleCache,
    store: deps.policyStore ?? defaultPolicyStore,
    logger,
    fallback: defaultPrefilterPolicy,
  });
  const result = await runPipeline({
    event,
    rules,
    policy,
    detectors: [detector],
    actions: [
      createDeleteAction(),
      createMuteAction({ durationSeconds: 60 * 60 }),
      createBanAction(),
    ],
    storage: deps.storage ?? createMemoryStorage(),
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
