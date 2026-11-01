import {
  createBanAction,
  createCaptchaAction,
  createDeleteAction,
  createMuteAction,
} from "@tasb/actions";
import {
  createMemoryCache,
  createMemoryPolicyStore,
  createMemoryRuntimeStore,
  createMemoryStorage,
} from "@tasb/adapter-memory";
import {
  type Cache,
  type CaptchaStore,
  type Clock,
  createSystemClock,
  defaultPrefilterPolicy,
  type Event,
  type Logger,
  loadPolicy,
  loadRuleSet,
  type ModerationPort,
  type PipelineResult,
  type PolicyStore,
  type RuleSource,
  type RuntimeStore,
  runPipeline,
  type Storage,
  wrapLogger,
} from "@tasb/core";
import { createJoinDetector } from "@tasb/detector-join";
import { createKeywordDetector } from "@tasb/detector-keyword";
import { createLinkDetector } from "@tasb/detector-link";
import {
  createFloodDetector,
  createRepeatDetector,
  type RateWindow,
} from "@tasb/detector-rate";
import { createCaptchaNonce, workerCaptcha } from "./captcha-runtime.js";
import { moderatorFor } from "./moderation.js";
import { workerRateWindow } from "./rate-runtime.js";
import { fileRuleSource } from "./rules.js";

/**
 * Isolate-local fallback when D1 and KV are not bound. A rule miss
 * still reads the bundled files. Memory audits are capped at 200 rows.
 * Captcha challenges live in this isolate. A restart drops them.
 * delete / mute / ban still do not call Telegram. restrict / release
 * call Telegram only when TELEGRAM_BOT_TOKEN is set.
 */
export const workerCache = createMemoryCache();
export const workerPolicyStore = createMemoryPolicyStore();
export const workerRuntime = createMemoryRuntimeStore();
export const workerStorage = createMemoryStorage({ maxAudits: 200 });

const detector = createKeywordDetector({
  keywords: ["免费领取", "加微信"],
});
const linkDetector = createLinkDetector();

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
  readonly moderator?: ModerationPort;
  readonly captchaStore?: CaptchaStore;
  readonly clock?: Clock;
  readonly createNonce?: () => string;
  readonly botToken?: string;
  readonly fetchImpl?: typeof fetch;
  readonly rateWindow?: RateWindow;
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
    detectors: [
      detector,
      createJoinDetector(),
      createFloodDetector({
        window: deps.rateWindow ?? workerRateWindow,
        windowSeconds: 10,
        threshold: 5,
      }),
      createRepeatDetector({
        window: deps.rateWindow ?? workerRateWindow,
        windowSeconds: 60,
        threshold: 3,
      }),
      linkDetector,
    ],
    actions: [
      createDeleteAction(),
      createMuteAction({ durationSeconds: 60 * 60 }),
      createBanAction(),
      createCaptchaAction({
        ttlSeconds: 300,
        createNonce: deps.createNonce ?? createCaptchaNonce,
        store: deps.captchaStore ?? workerCaptcha,
        clock: deps.clock ?? createSystemClock(),
      }),
    ],
    storage: deps.storage ?? workerStorage,
    moderator:
      deps.moderator ??
      moderatorFor({
        token: deps.botToken,
        fetchImpl: deps.fetchImpl,
      }),
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
