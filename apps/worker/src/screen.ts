import {
  createBanAction,
  createCaptchaAction,
  createDeclineAction,
  createDeleteAction,
  createLogAction,
  createMuteAction,
  createReportAction,
  createWarnAction,
} from "@tasb/actions";
import {
  createMemoryCache,
  createMemoryPolicyStore,
  createMemoryRuntimeStore,
  createMemoryStorage,
} from "@tasb/adapter-memory";
import { degradeRules, type QuotaPolicy, type QuotaStore } from "@tasb/cloud";
import {
  type Action,
  type BlocklistStore,
  CAPTCHA_TTL_SECONDS,
  type Cache,
  type CaptchaStore,
  type Clock,
  copyMissingChatSettings,
  createSystemClock,
  type Detector,
  defaultPrefilterPolicy,
  type Event,
  FLOOD_THRESHOLD,
  FLOOD_WINDOW_SECONDS,
  type LlmClassifier,
  type Logger,
  loadPolicy,
  type ModerationPort,
  MUTE_DURATION_SECONDS,
  type Notifier,
  type PipelineResult,
  type PolicyStore,
  REPEAT_THRESHOLD,
  REPEAT_WINDOW_SECONDS,
  type RuleActionOverride,
  type RulePackArchive,
  type RulePackSource,
  type RuleSet,
  type RuleSource,
  type RuleSubscriptionStore,
  type RuleSwitch,
  type RuntimeStore,
  resolveRuleSet,
  runPipeline,
  type Storage,
  type WarnStore,
  wrapLogger,
} from "@tasb/core";
import { createAutoDeleteDetector } from "@tasb/detector-autodelete";
import { createBackgroundDetector } from "@tasb/detector-background";
import { createBlocklistDetector } from "@tasb/detector-blocklist";
import { createBoostDetector } from "@tasb/detector-boost";
import { createBotDetector } from "@tasb/detector-bot";
import { createCallDetector } from "@tasb/detector-call";
import { createCallInviteDetector } from "@tasb/detector-call-invite";
import { createChecklistDetector } from "@tasb/detector-checklist";
import { createCommunityDetector } from "@tasb/detector-community";
import { createContactDetector } from "@tasb/detector-contact";
import { createCreatedDetector } from "@tasb/detector-created";
import { createDeclineDetector } from "@tasb/detector-decline";
import { createFolderDetector } from "@tasb/detector-folder";
import { createForumDetector } from "@tasb/detector-forum";
import {
  createForwardDetector,
  defaultForwardKinds,
} from "@tasb/detector-forward";
import { createGiftDetector } from "@tasb/detector-gift";
import { createGiveawayDetector } from "@tasb/detector-giveaway";
import { createGiveawayNoticeDetector } from "@tasb/detector-giveaway-notice";
import { createJoinDetector } from "@tasb/detector-join";
import { createKeywordDetector } from "@tasb/detector-keyword";
import { createLinkDetector } from "@tasb/detector-link";
import { createLlmDetector } from "@tasb/detector-llm";
import {
  createLocationDetector,
  createMapDetector,
} from "@tasb/detector-location";
import { createMediaDetector } from "@tasb/detector-media";
import { createNoticeDetector } from "@tasb/detector-notice";
import { createOwnerDetector } from "@tasb/detector-owner";
import { createPendingDetector } from "@tasb/detector-pending";
import { createPhotoDetector } from "@tasb/detector-photo";
import { createPinDetector } from "@tasb/detector-pin";
import { createPollDetector } from "@tasb/detector-poll";
import { createPostDetector } from "@tasb/detector-post";
import { createPriceDetector } from "@tasb/detector-price";
import { createProximityDetector } from "@tasb/detector-proximity";
import {
  createFloodDetector,
  createRepeatDetector,
  type RateWindow,
} from "@tasb/detector-rate";
import {
  createRegexDetector,
  defaultRegexPatterns,
} from "@tasb/detector-regex";
import { createRichDetector } from "@tasb/detector-rich";
import { createScriptDetector } from "@tasb/detector-script";
import { createSenderDetector } from "@tasb/detector-sender";
import { createSharedChatDetector } from "@tasb/detector-shared-chat";
import { createSpoilerDetector } from "@tasb/detector-spoiler";
import { createStoryDetector } from "@tasb/detector-story";
import { createTaskDetector } from "@tasb/detector-task";
import { createTitleDetector } from "@tasb/detector-title";
import { createTopicDetector } from "@tasb/detector-topic";
import { createViaDetector } from "@tasb/detector-via";
import { type AlbumWatch, sweepAlbum, workerAlbumWatch } from "./album.js";
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
import { workerWarns } from "./warn-runtime.js";

/**
 * Isolate-local fallback when D1 and KV are not bound. A rule miss
 * still reads the bundled files. Memory audits are capped at 200 rows.
 * Captcha challenges stay in this isolate unless DB is bound. The shared
 * blocklist uses this isolate only when POLICY_KV is absent. A restart
 * drops that memory captcha and memory blocklist. Opt-in starts off.
 * delete / mute / ban and restrict / release call Telegram only when
 * TELEGRAM_BOT_TOKEN is set. Without it, delete / mute / ban stay in memory.
 */
export const workerCache = createMemoryCache();
export const workerPolicyStore = createMemoryPolicyStore();
export const workerRuntime = createMemoryRuntimeStore();
export const workerStorage = createMemoryStorage({ maxAudits: 200 });

const DEFAULT_KEYWORDS = ["免费领取", "加微信"] as const;
const detector = createKeywordDetector({
  keywords: [...DEFAULT_KEYWORDS],
});
const regexDetector = createRegexDetector({
  patterns: [...defaultRegexPatterns],
});
const forwardDetector = createForwardDetector({
  kinds: [...defaultForwardKinds],
});
const hiddenForwardDetector = createForwardDetector(
  { kinds: ["hidden"] },
  "forward_hidden",
);
const chatForwardDetector = createForwardDetector(
  { kinds: ["chat"] },
  "forward_chat",
);
const userForwardDetector = createForwardDetector(
  { kinds: ["user"] },
  "forward_user",
);
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
  readonly warnStore?: WarnStore;
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
  readonly notifier?: Notifier;
  readonly rulePacks?: {
    readonly store: RuleSubscriptionStore;
    readonly source: RulePackSource;
    readonly archive: RulePackArchive;
  };
  readonly quota?: {
    readonly policy: QuotaPolicy;
    readonly store: QuotaStore;
  };
  readonly albumWatch?: AlbumWatch;
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

async function applyQuota(
  event: Event,
  rules: RuleSet,
  quota: ScreenDeps["quota"],
  logger: Logger,
): Promise<RuleSet> {
  if (!quota?.policy.enabled || event.actor.isAdmin) {
    return rules;
  }
  try {
    const snapshot = await quota.store.consume({
      tenantId: event.tenantId,
      chatId: event.chatId,
      atIso: event.occurredAt,
      policy: quota.policy,
      eventId: event.id,
    });
    if (!snapshot) {
      logger.warn("quota_skipped", {
        eventId: event.id,
        tenantId: event.tenantId,
        chatId: event.chatId,
      });
      return rules;
    }
    if (!snapshot.degraded) {
      return rules;
    }
    logger.warn("quota_degraded", {
      eventId: event.id,
      tenantId: event.tenantId,
      chatId: event.chatId,
      used: snapshot.used,
      limit: snapshot.limit,
    });
    return degradeRules(rules, quota.policy.basicDetectorIds);
  } catch {
    logger.warn("quota_failed", {
      eventId: event.id,
      tenantId: event.tenantId,
      chatId: event.chatId,
    });
    return rules;
  }
}

export async function screenTelegramEvent(
  event: Event,
  deps: ScreenDeps = {},
): Promise<PipelineResult> {
  const logger = deps.logger ?? createWorkerLogger();
  const runtime = deps.runtime ?? workerRuntime;
  if (event.chatMove) {
    try {
      const copied = await copyMissingChatSettings({
        runtime,
        policy: deps.policyStore ?? workerPolicyStore,
        tenantId: event.tenantId,
        fromChatId: event.chatMove.from,
        toChatId: event.chatMove.to,
      });
      if (copied > 0) {
        logger.info("chat_moved", {
          eventId: event.id,
          chatId: event.chatId,
          copied,
        });
      }
    } catch {
      logger.warn("chat_move_failed", {
        eventId: event.id,
        chatId: event.chatId,
      });
    }
  }
  let switches: readonly RuleSwitch[] = [];
  try {
    switches = await runtime.listRuleSwitches(event.tenantId, event.chatId);
  } catch {
    logger.warn("runtime_failed", {
      eventId: event.id,
      chatId: event.chatId,
    });
  }
  let ruleActions: readonly RuleActionOverride[] = [];
  try {
    ruleActions = await runtime.listRuleActions(event.tenantId, event.chatId);
  } catch {
    logger.warn("runtime_failed", {
      eventId: event.id,
      chatId: event.chatId,
    });
  }
  let keywordDetector = detector;
  let activeLink = linkDetector;
  try {
    const extras = await runtime.listKeywords(event.tenantId, event.chatId);
    if (extras.length > 0) {
      const keywords: string[] = [...DEFAULT_KEYWORDS];
      for (const extra of extras) {
        if (!keywords.includes(extra)) {
          keywords.push(extra);
        }
      }
      keywordDetector = createKeywordDetector({ keywords });
    }
  } catch {
    logger.warn("runtime_failed", {
      eventId: event.id,
      chatId: event.chatId,
    });
  }
  try {
    const allowHosts = await runtime.listAllowHosts(
      event.tenantId,
      event.chatId,
    );
    if (allowHosts.length > 0) {
      activeLink = createLinkDetector({ allowHosts });
    }
  } catch {
    logger.warn("runtime_failed", {
      eventId: event.id,
      chatId: event.chatId,
    });
  }
  let floodThreshold = FLOOD_THRESHOLD;
  let floodWindowSeconds = FLOOD_WINDOW_SECONDS;
  try {
    const flood = await runtime.getFloodPolicy(event.tenantId, event.chatId);
    if (flood) {
      floodThreshold = flood.threshold;
      floodWindowSeconds = flood.windowSeconds;
    }
  } catch {
    logger.warn("runtime_failed", {
      eventId: event.id,
      chatId: event.chatId,
    });
  }
  let repeatThreshold = REPEAT_THRESHOLD;
  let repeatWindowSeconds = REPEAT_WINDOW_SECONDS;
  try {
    const repeat = await runtime.getRepeatPolicy(event.tenantId, event.chatId);
    if (repeat) {
      repeatThreshold = repeat.threshold;
      repeatWindowSeconds = repeat.windowSeconds;
    }
  } catch {
    logger.warn("runtime_failed", {
      eventId: event.id,
      chatId: event.chatId,
    });
  }
  let muteDurationSeconds = MUTE_DURATION_SECONDS;
  try {
    const muteDuration = await runtime.getMuteDuration(
      event.tenantId,
      event.chatId,
    );
    if (muteDuration !== null) {
      muteDurationSeconds = muteDuration;
    }
  } catch {
    logger.warn("runtime_failed", {
      eventId: event.id,
      chatId: event.chatId,
    });
  }
  let captchaTtlSeconds = CAPTCHA_TTL_SECONDS;
  try {
    const captchaTtl = await runtime.getCaptchaTtl(
      event.tenantId,
      event.chatId,
    );
    if (captchaTtl !== null) {
      captchaTtlSeconds = captchaTtl;
    }
  } catch {
    logger.warn("runtime_failed", {
      eventId: event.id,
      chatId: event.chatId,
    });
  }
  const packId = await subscribedPack(event, deps.rulePacks, logger);
  const loaded = await resolveRuleSet({
    tenantId: event.tenantId,
    chatId: event.chatId,
    cache: deps.cache ?? workerCache,
    source: deps.source ?? fileRuleSource,
    logger,
    switches,
    actions: ruleActions,
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
  const rules = await applyQuota(event, loaded, deps.quota, logger);
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
    dryRun = await runtime.getDryRun(event.tenantId, event.chatId);
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
        value: keywordDetector,
      },
      {
        source: "builtin",
        manifest: builtinManifests.regex,
        value: regexDetector,
      },
      {
        source: "builtin",
        manifest: builtinManifests.forward,
        value: forwardDetector,
      },
      {
        source: "builtin",
        manifest: builtinManifests.forwardHidden,
        value: hiddenForwardDetector,
      },
      {
        source: "builtin",
        manifest: builtinManifests.forwardChat,
        value: chatForwardDetector,
      },
      {
        source: "builtin",
        manifest: builtinManifests.forwardUser,
        value: userForwardDetector,
      },
      {
        source: "builtin",
        manifest: builtinManifests.join,
        value: createJoinDetector(),
      },
      {
        source: "builtin",
        manifest: builtinManifests.bot,
        value: createBotDetector(),
      },
      {
        source: "builtin",
        manifest: builtinManifests.contact,
        value: createContactDetector(),
      },
      {
        source: "builtin",
        manifest: builtinManifests.via,
        value: createViaDetector(),
      },
      {
        source: "builtin",
        manifest: builtinManifests.folder,
        value: createFolderDetector(),
      },
      {
        source: "builtin",
        manifest: builtinManifests.notice,
        value: createNoticeDetector(),
      },
      {
        source: "builtin",
        manifest: builtinManifests.mediaSticker,
        value: createMediaDetector("sticker"),
      },
      {
        source: "builtin",
        manifest: builtinManifests.mediaAnimation,
        value: createMediaDetector("animation"),
      },
      {
        source: "builtin",
        manifest: builtinManifests.mediaVoice,
        value: createMediaDetector("voice"),
      },
      {
        source: "builtin",
        manifest: builtinManifests.mediaVideoNote,
        value: createMediaDetector("video_note"),
      },
      {
        source: "builtin",
        manifest: builtinManifests.mediaDice,
        value: createMediaDetector("dice"),
      },
      {
        source: "builtin",
        manifest: builtinManifests.scriptArabic,
        value: createScriptDetector("arabic"),
      },
      {
        source: "builtin",
        manifest: builtinManifests.scriptCyrillic,
        value: createScriptDetector("cyrillic"),
      },
      {
        source: "builtin",
        manifest: builtinManifests.channelSender,
        value: createSenderDetector(),
      },
      {
        source: "builtin",
        manifest: builtinManifests.sharedStory,
        value: createStoryDetector(),
      },
      {
        source: "builtin",
        manifest: builtinManifests.bareLocation,
        value: createLocationDetector(),
      },
      {
        source: "builtin",
        manifest: builtinManifests.giveawayCard,
        value: createGiveawayDetector(),
      },
      {
        source: "builtin",
        manifest: builtinManifests.callNotice,
        value: createCallDetector(),
      },
      {
        source: "builtin",
        manifest: builtinManifests.chatTitle,
        value: createTitleDetector(),
      },
      {
        source: "builtin",
        manifest: builtinManifests.communityNotice,
        value: createCommunityDetector(),
      },
      {
        source: "builtin",
        manifest: builtinManifests.sharedChat,
        value: createSharedChatDetector(),
      },
      {
        source: "builtin",
        manifest: builtinManifests.chatPhoto,
        value: createPhotoDetector(),
      },
      {
        source: "builtin",
        manifest: builtinManifests.chatBackground,
        value: createBackgroundDetector(),
      },
      {
        source: "builtin",
        manifest: builtinManifests.giftCard,
        value: createGiftDetector(),
      },
      {
        source: "builtin",
        manifest: builtinManifests.pinNotice,
        value: createPinDetector(),
      },
      {
        source: "builtin",
        manifest: builtinManifests.giveawayNotice,
        value: createGiveawayNoticeDetector(),
      },
      {
        source: "builtin",
        manifest: builtinManifests.chatBoost,
        value: createBoostDetector(),
      },
      {
        source: "builtin",
        manifest: builtinManifests.forumNotice,
        value: createForumDetector(),
      },
      {
        source: "builtin",
        manifest: builtinManifests.autoDeleteNotice,
        value: createAutoDeleteDetector(),
      },
      {
        source: "builtin",
        manifest: builtinManifests.priceNotice,
        value: createPriceDetector(),
      },
      {
        source: "builtin",
        manifest: builtinManifests.postNotice,
        value: createPostDetector(),
      },
      {
        source: "builtin",
        manifest: builtinManifests.checklistNotice,
        value: createChecklistDetector(),
      },
      {
        source: "builtin",
        manifest: builtinManifests.callInvite,
        value: createCallInviteDetector(),
      },
      {
        source: "builtin",
        manifest: builtinManifests.ownerNotice,
        value: createOwnerDetector(),
      },
      {
        source: "builtin",
        manifest: builtinManifests.proximityNotice,
        value: createProximityDetector(),
      },
      {
        source: "builtin",
        manifest: builtinManifests.pollNotice,
        value: createPollDetector(),
      },
      {
        source: "builtin",
        manifest: builtinManifests.taskAdded,
        value: createTaskDetector(),
      },
      {
        source: "builtin",
        manifest: builtinManifests.topicNotice,
        value: createTopicDetector(),
      },
      {
        source: "builtin",
        manifest: builtinManifests.postDeclined,
        value: createDeclineDetector(),
      },
      {
        source: "builtin",
        manifest: builtinManifests.groupCreated,
        value: createCreatedDetector(),
      },
      {
        source: "builtin",
        manifest: builtinManifests.postPending,
        value: createPendingDetector(),
      },
      {
        source: "builtin",
        manifest: builtinManifests.mediaSpoiler,
        value: createSpoilerDetector(),
      },
      {
        source: "builtin",
        manifest: builtinManifests.richPhone,
        value: createRichDetector("phone"),
      },
      {
        source: "builtin",
        manifest: builtinManifests.richCard,
        value: createRichDetector("card"),
      },
      {
        source: "builtin",
        manifest: builtinManifests.richEmail,
        value: createRichDetector("email"),
      },
      {
        source: "builtin",
        manifest: builtinManifests.richMap,
        value: createMapDetector(),
      },
      {
        source: "builtin",
        manifest: builtinManifests.richMention,
        value: createRichDetector("mention"),
      },
      {
        source: "builtin",
        manifest: builtinManifests.richTextMention,
        value: createRichDetector("text_mention"),
      },
      {
        source: "builtin",
        manifest: builtinManifests.richCommand,
        value: createRichDetector("command"),
      },
      {
        source: "builtin",
        manifest: builtinManifests.richHashtag,
        value: createRichDetector("hashtag"),
      },
      {
        source: "builtin",
        manifest: builtinManifests.richCashtag,
        value: createRichDetector("cashtag"),
      },
      {
        source: "builtin",
        manifest: builtinManifests.richAnchor,
        value: createRichDetector("anchor"),
      },
      {
        source: "builtin",
        manifest: builtinManifests.richAnchorLink,
        value: createRichDetector("anchor_link"),
      },
      {
        source: "builtin",
        manifest: builtinManifests.flood,
        value: createFloodDetector({
          window: deps.rateWindow ?? workerRateWindow,
          windowSeconds: floodWindowSeconds,
          threshold: floodThreshold,
        }),
      },
      {
        source: "builtin",
        manifest: builtinManifests.repeat,
        value: createRepeatDetector({
          window: deps.rateWindow ?? workerRateWindow,
          windowSeconds: repeatWindowSeconds,
          threshold: repeatThreshold,
        }),
      },
      {
        source: "builtin",
        manifest: builtinManifests.link,
        value: activeLink,
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
        manifest: builtinManifests.warn,
        value: createWarnAction({
          store: deps.warnStore ?? workerWarns,
        }),
      },
      {
        source: "builtin",
        manifest: builtinManifests.mute,
        value: createMuteAction({ durationSeconds: muteDurationSeconds }),
      },
      {
        source: "builtin",
        manifest: builtinManifests.ban,
        value: createBanAction(),
      },
      {
        source: "builtin",
        manifest: builtinManifests.decline,
        value: createDeclineAction(),
      },
      {
        source: "builtin",
        manifest: builtinManifests.log,
        value: createLogAction(),
      },
      {
        source: "builtin",
        manifest: builtinManifests.report,
        value: createReportAction(
          deps.notifier ? { notifier: deps.notifier } : {},
        ),
      },
      {
        source: "builtin",
        manifest: builtinManifests.captcha,
        value: createCaptchaAction({
          ttlSeconds: captchaTtlSeconds,
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
  const moderator =
    deps.moderator ??
    moderatorFor({
      token: deps.botToken,
      fetchImpl: deps.fetchImpl,
    });
  const result = await runPipeline({
    event,
    rules,
    policy,
    dryRun,
    detectors,
    actions,
    storage: deps.storage ?? workerStorage,
    moderator,
    logger,
  });
  const joinQueryId = event.joinQueryId;
  if (
    !dryRun &&
    event.kind === "join_request" &&
    joinQueryId &&
    result.decision.action !== "decline"
  ) {
    try {
      await moderator.deferJoin({
        tenantId: event.tenantId,
        chatId: event.chatId,
        actorId: event.actor.id,
        queryId: joinQueryId,
      });
    } catch {
      logger.warn("join_query_defer_failed", {
        eventId: event.id,
        chatId: event.chatId,
      });
    }
  }
  await sweepAlbum({
    event,
    result,
    dryRun,
    moderator,
    logger,
    watch: deps.albumWatch ?? workerAlbumWatch,
  });
  logger.info("webhook_screened", {
    eventId: result.eventId,
    chatId: event.chatId,
    action: result.decision.action,
    outcome: result.outcome,
  });
  return result;
}
