import {
  createSystemClock,
  type Event,
  type Logger,
  type ReplyPort,
  resolveChallenge,
  runOperatorCommand,
} from "@tasb/core";
import { sendCaptchaButton } from "@tasb/platform-telegram";
import { workerBlocklist } from "./blocklist-runtime.js";
import { workerCaptcha } from "./captcha-runtime.js";
import { moderatorFor } from "./moderation.js";
import { fileRuleSource } from "./rules.js";
import {
  createWorkerLogger,
  type ScreenDeps,
  screenTelegramEvent,
  workerCache,
  workerPolicyStore,
  workerRuntime,
  workerStorage,
} from "./screen.js";

export interface OperateDeps extends ScreenDeps {
  readonly adminActorIds?: readonly string[];
  readonly reply?: ReplyPort;
}

export async function handleIncomingEvent(
  event: Event,
  deps: OperateDeps = {},
): Promise<void> {
  const logger = deps.logger ?? createWorkerLogger();
  const cache = deps.cache ?? workerCache;
  const source = deps.source ?? fileRuleSource;
  const storage = deps.storage ?? workerStorage;
  const policyStore = deps.policyStore ?? workerPolicyStore;
  const runtime = deps.runtime ?? workerRuntime;
  const moderator =
    deps.moderator ??
    moderatorFor({ token: deps.botToken, fetchImpl: deps.fetchImpl });
  const captchaStore = deps.captchaStore ?? workerCaptcha;
  const blocklist = deps.blocklist ?? workerBlocklist;
  if (event.kind === "challenge") {
    try {
      await resolveChallenge({
        event,
        ports: {
          store: captchaStore,
          storage,
          restrict: (target) => moderator.restrictActor(target),
          release: (target) => moderator.releaseActor(target),
          clock: deps.clock ?? createSystemClock(),
          logger,
        },
      });
    } catch {
      logger.warn("captcha_failed", {
        eventId: event.id,
        chatId: event.chatId,
      });
    }
    return;
  }
  const outcome = await runOperatorCommand({
    event,
    adminActorIds: deps.adminActorIds ?? [],
    cache,
    policyStore,
    runtime,
    source,
    storage,
    logger,
    blocklist,
  });
  if (outcome.status === "reply") {
    await sendReply(event, outcome.text, outcome.command, deps.reply, logger);
    return;
  }
  const result = await screenTelegramEvent(event, {
    logger,
    cache,
    source,
    storage,
    policyStore,
    runtime,
    moderator,
    captchaStore,
    ...(deps.clock ? { clock: deps.clock } : {}),
    ...(deps.createNonce ? { createNonce: deps.createNonce } : {}),
    ...(deps.botToken ? { botToken: deps.botToken } : {}),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.rateWindow ? { rateWindow: deps.rateWindow } : {}),
    blocklist,
  });
  const prompted = result.actionResults.some(
    (item) => item.actionId === "captcha" && item.status === "executed",
  );
  if (!prompted) {
    return;
  }
  const challenge = await captchaStore.get(
    event.tenantId,
    event.chatId,
    event.actor.id,
  );
  if (!challenge) {
    return;
  }
  try {
    await sendCaptchaButton({
      token: deps.botToken,
      chatId: event.chatId,
      nonce: challenge.nonce,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    });
  } catch {
    try {
      await moderator.releaseActor({
        tenantId: event.tenantId,
        chatId: event.chatId,
        actorId: event.actor.id,
      });
      await captchaStore.delete(event.tenantId, event.chatId, event.actor.id);
    } catch {
      logger.warn("captcha_prompt_failed", {
        eventId: event.id,
        chatId: event.chatId,
      });
      return;
    }
    logger.warn("captcha_prompt_failed", {
      eventId: event.id,
      chatId: event.chatId,
    });
  }
}

async function sendReply(
  event: Event,
  text: string,
  command: string,
  reply: ReplyPort | undefined,
  logger: Logger,
): Promise<void> {
  try {
    if (!reply) {
      throw new Error("reply_unavailable");
    }
    await reply.send({
      tenantId: event.tenantId,
      chatId: event.chatId,
      text,
    });
    logger.info("operator_replied", {
      eventId: event.id,
      chatId: event.chatId,
      command,
    });
  } catch {
    logger.warn("reply_failed", {
      eventId: event.id,
      chatId: event.chatId,
    });
  }
}
