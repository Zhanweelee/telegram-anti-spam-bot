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
  type Action,
  type BlocklistStore,
  type Cache,
  type CaptchaStore,
  type Clock,
  createSystemClock,
  type Detector,
  defaultPrefilterPolicy,
  type Event,
  type LlmClassifier,
  type Logger,
  loadPolicy,
  type ModerationPort,
  type PipelineResult,
  type PolicyStore,
  type RulePackArchive,
  type RulePackSource,
  type RuleSource,
  type RuleSubscriptionStore,
  type RuntimeStore,
  resolveRuleSet,
  runPipeline,
  type Storage,
  wrapLogger,
} from "@tasb/core";
import { createBlocklistDetector } from "@tasb/detector-blocklist";
import { createJoinDetector } from "@tasb/detector-join";
import { createKeywordDetector } from "@tasb/detector-keyword";
import { createLinkDetector } from "@tasb/detector-link";
import { createLlmDetector } from "@tasb/detector-llm";
import {
  createFloodDetector,
  createRepeatDetector,
  type RateWindow,
} from "@tasb/detector-rate";
import { workerBlocklist } from "./blocklist-runtime.js";
import { createCaptchaNonce, workerCaptcha } from "./captcha-runtime.js";
import { moderatorFor } from "./moderation.js";
import {
  builtinManifests,
  type PluginSlot,
  selectAdmitted,
} from "./plugins.js";
import { workerRateWindow } from "./rate-runtime.js";
import { fileRuleSource } from "./rules.js";

/**
 * Isolate-local fallback when D1 and KV are not bound. A rule miss
 * still reads the bundled files. Memory audits are capped at 200 rows.
 * Captcha challenges and the shared blocklist live in this isolate.
 * A restart drops both. Blocklist opt-in starts off.
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
  readonly blocklist?: BlocklistStore;
  readonly llm?: LlmClassifier;
  readonly allowUnsigned?: boolean;
  readonly externalDetectors?: readonly PluginSlot<Detector>[];
  readonly externalActions?: readonly PluginSlot<Action>[];
  readonly rulePacks?: {
    readonly store: RuleSubscriptionStore;
    readonly source: RulePackSource;
    readonly archive: RulePackArchive;
  };
}

async function subscribedPack(
  event: Event,
  packs: ScreenDeps["rulePacks"],
  logger: Logger,
): Promise<string | null> {
  if (!packs) {
    return null;
  }
  try {
    return await packs.store.get(event.tenantId, event.chatId);
  } catch {
    logger.warn("pack_store_failed", {
      eventId: event.id,
      tenantId: event.tenantId,
      chatId: event.chatId,
    });
    return null;
  }
}

export async function screenTelegramEvent(
  event: Event,
  deps: ScreenDeps = {},
): Promise<PipelineResult> {
  const logger = deps.logger ?? createWorkerLogger();
  const packId = await subscribedPack(event, deps.rulePacks, logger);
  const rules = await resolveRuleSet({
    tenantId: event.tenantId,
    chatId: event.chatId,
    cache: deps.cache ?? workerCache,
    source: deps.source ?? fileRuleSource,
    logger,
    ...(packId && deps.rulePacks
      ? {
          pack: {
            id: packId,
            source: deps.rulePacks.source,
            archive: deps.rulePacks.archive,
          },
        }
      : {}),
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
  const allowUnsigned = deps.allowUnsigned === true;
  const detectors = await selectAdmitted({
    logger,
    allowUnsigned,
    slots: [
      {
        source: "builtin",
        manifest: builtinManifests.keyword,
        value: detector,
      },
      {
        source: "builtin",
        manifest: builtinManifests.join,
        value: createJoinDetector(),
      },
      {
        source: "builtin",
        manifest: builtinManifests.flood,
        value: createFloodDetector({
          window: deps.rateWindow ?? workerRateWindow,
          windowSeconds: 10,
          threshold: 5,
        }),
      },
      {
        source: "builtin",
        manifest: builtinManifests.repeat,
        value: createRepeatDetector({
          window: deps.rateWindow ?? workerRateWindow,
          windowSeconds: 60,
          threshold: 3,
        }),
      },
      {
        source: "builtin",
        manifest: builtinManifests.link,
        value: linkDetector,
      },
      {
        source: "builtin",
        manifest: builtinManifests.blocklist,
        value: createBlocklistDetector({
          store: deps.blocklist ?? workerBlocklist,
        }),
      },
      {
        source: "builtin",
        manifest: builtinManifests.llm,
        value: createLlmDetector(deps.llm ? { classifier: deps.llm } : {}),
      },
      ...(deps.externalDetectors ?? []).map((slot) => ({
        ...slot,
        source: "external" as const,
      })),
    ],
  });
  const actions = await selectAdmitted({
    logger,
    allowUnsigned,
    slots: [
      {
        source: "builtin",
        manifest: builtinManifests.delete,
        value: createDeleteAction(),
      },
      {
        source: "builtin",
        manifest: builtinManifests.mute,
        value: createMuteAction({ durationSeconds: 60 * 60 }),
      },
      {
        source: "builtin",
        manifest: builtinManifests.ban,
        value: createBanAction(),
      },
      {
        source: "builtin",
        manifest: builtinManifests.captcha,
        value: createCaptchaAction({
          ttlSeconds: 300,
          createNonce: deps.createNonce ?? createCaptchaNonce,
          store: deps.captchaStore ?? workerCaptcha,
          clock: deps.clock ?? createSystemClock(),
        }),
      },
      ...(deps.externalActions ?? []).map((slot) => ({
        ...slot,
        source: "external" as const,
      })),
    ],
  });
  const result = await runPipeline({
    event,
    rules,
    policy,
    dryRun,
    detectors,
    actions,
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
