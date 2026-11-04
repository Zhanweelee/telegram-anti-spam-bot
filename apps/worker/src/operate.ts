import {
  type ChatDirectory,
  cancelChallenge,
  createSystemClock,
  type Event,
  type Locale,
  type Logger,
  promoteChallenge,
  type ReplyPort,
  type ReviewQueue,
  resolveChallenge,
  runOperatorCommand,
  unrestrictChallenge,
} from "@tasb/core";
import { sendCaptchaButton } from "@tasb/platform-telegram";
import { workerBlocklist } from "./blocklist-runtime.js";
import { workerCaptcha } from "./captcha-runtime.js";
import { moderatorFor } from "./moderation.js";
import { workerRulePacks } from "./pack-runtime.js";
import { adminNotifier } from "./report.js";
import { workerReview } from "./review-runtime.js";
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
  readonly locale?: Locale;
  readonly review?: ReviewQueue;
  readonly chats?: ChatDirectory;
}

function commandModerator(
  moderator: ReturnType<typeof moderatorFor>,
  deps: OperateDeps,
): NonNullable<Parameters<typeof runOperatorCommand>[0]["moderator"]> {
  const token = deps.botToken?.trim() ?? "";
  if (deps.moderator !== undefined || token.length > 0) {
    return moderator;
  }
  return {
    unbanActor: (target) => moderator.unbanActor(target),
    unmuteActor: (target) => moderator.unmuteActor(target),
    async banActor() {
      throw new Error("ban_unavailable");
    },
    async banSenderChat() {
      throw new Error("sender_unavailable");
    },
    async unbanSenderChat() {
      throw new Error("unban_sender_unavailable");
    },
    async lockChat() {
      throw new Error("lock_unavailable");
    },
    async unlockChat() {
      throw new Error("unlock_unavailable");
    },
    async muteActor() {
      throw new Error("mute_unavailable");
    },
    async readMember() {
      throw new Error("member_unavailable");
    },
    async readPermissions() {
      throw new Error("perms_unavailable");
    },
    async readAdministrators() {
      throw new Error("admins_unavailable");
    },
    async readMemberCount() {
      throw new Error("count_unavailable");
    },
    async readBoostCount() {
      throw new Error("boosts_unavailable");
    },
    async clearReactions() {
      throw new Error("reactions_unavailable");
    },
    async revokeInvite() {
      throw new Error("revoke_unavailable");
    },
    async unpinChat() {
      throw new Error("unpin_unavailable");
    },
    async pinMessage() {
      throw new Error("pin_unavailable");
    },
    async unpinMessage() {
      throw new Error("unpinmsg_unavailable");
    },
    async removeReaction() {
      throw new Error("unreact_unavailable");
    },
    async deletePhoto() {
      throw new Error("delphoto_unavailable");
    },
    async leaveChat() {
      throw new Error("leave_unavailable");
    },
    async setMemberTag() {
      throw new Error("tag_unavailable");
    },
    async deleteStickerSet() {
      throw new Error("delstickers_unavailable");
    },
    async unpinTopic() {
      throw new Error("untopic_unavailable");
    },
    async closeTopic() {
      throw new Error("closetopic_unavailable");
    },
    async openTopic() {
      throw new Error("opentopic_unavailable");
    },
    async hideGeneral() {
      throw new Error("hidegeneral_unavailable");
    },
    async showGeneral() {
      throw new Error("showgeneral_unavailable");
    },
    async deleteTopic() {
      throw new Error("deltopic_unavailable");
    },
    async deleteMessage() {
      throw new Error("delete_unavailable");
    },
    async deleteMessages() {
      throw new Error("deletes_unavailable");
    },
    async declineJoin() {
      throw new Error("decline_unavailable");
    },
    async approveJoin() {
      throw new Error("approve_unavailable");
    },
  };
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
  const review = deps.review ?? workerReview;
  const rulePacks = deps.rulePacks ?? workerRulePacks;
  const quota = deps.quota;
  const chats = deps.chats;
  const reportActorId = (deps.adminActorIds ?? []).find((id) => id.length > 0);
  const notifier =
    deps.notifier ??
    (deps.reply && reportActorId
      ? adminNotifier(deps.reply, reportActorId)
      : undefined);
  if (event.kind === "bot_membership" || event.kind === "chat_member") {
    await syncChatDirectory(event, chats, logger);
  }
  if (event.kind === "bot_membership") {
    return;
  }
  if (event.kind === "chat_member" && event.membership === "leave") {
    try {
      await cancelChallenge({
        event,
        ports: {
          store: captchaStore,
          storage,
          restrict: (target) => moderator.restrictActor(target),
          release: (target) => moderator.releaseActor(target),
          clock: deps.clock ?? createSystemClock(),
          logger,
          removePrompt: (target) =>
            moderator.deleteMessage({
              tenantId: target.tenantId,
              chatId: target.chatId,
              messageId: target.messageId,
            }),
        },
      });
    } catch {
      logger.warn("captcha_leave_failed", {
        eventId: event.id,
        chatId: event.chatId,
      });
    }
  }
  if (event.kind === "chat_member" && event.membership === "promote") {
    try {
      await promoteChallenge({
        event,
        ports: {
          store: captchaStore,
          storage,
          restrict: (target) => moderator.restrictActor(target),
          release: (target) => moderator.releaseActor(target),
          clock: deps.clock ?? createSystemClock(),
          logger,
          removePrompt: (target) =>
            moderator.deleteMessage({
              tenantId: target.tenantId,
              chatId: target.chatId,
              messageId: target.messageId,
            }),
        },
      });
    } catch {
      logger.warn("captcha_promote_failed", {
        eventId: event.id,
        chatId: event.chatId,
      });
    }
  }
  if (event.kind === "chat_member" && event.membership === "unrestrict") {
    try {
      await unrestrictChallenge({
        event,
        ports: {
          store: captchaStore,
          storage,
          restrict: (target) => moderator.restrictActor(target),
          release: (target) => moderator.releaseActor(target),
          clock: deps.clock ?? createSystemClock(),
          logger,
          removePrompt: (target) =>
            moderator.deleteMessage({
              tenantId: target.tenantId,
              chatId: target.chatId,
              messageId: target.messageId,
            }),
        },
      });
    } catch {
      logger.warn("captcha_unrestrict_failed", {
        eventId: event.id,
        chatId: event.chatId,
      });
    }
  }
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
          removePrompt: (target) =>
            moderator.deleteMessage({
              tenantId: target.tenantId,
              chatId: target.chatId,
              messageId: target.messageId,
            }),
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
    review,
    rulePacks: rulePacks.store,
    rulePackSource: rulePacks.source,
    rulePackArchive: rulePacks.archive,
    ...(deps.locale ? { locale: deps.locale } : {}),
    ...(quota
      ? {
          quota: {
            async read(tenantId, chatId, atIso) {
              const snapshot = await quota.store.read({
                tenantId,
                chatId,
                atIso,
                policy: quota.policy,
              });
              if (!snapshot) {
                return snapshot;
              }
              return {
                ...snapshot,
                basicDetectorIds: [...quota.policy.basicDetectorIds],
              };
            },
          },
        }
      : {}),
    ...(chats ? { chats } : {}),
    moderator: commandModerator(moderator, deps),
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
    ...(deps.llm ? { llm: deps.llm } : {}),
    ...(deps.allowUnsigned ? { allowUnsigned: true } : {}),
    ...(deps.externalDetectors
      ? { externalDetectors: deps.externalDetectors }
      : {}),
    ...(deps.externalActions ? { externalActions: deps.externalActions } : {}),
    rulePacks,
    blocklist,
    ...(quota ? { quota } : {}),
    ...(notifier ? { notifier } : {}),
  });
  const ownsPrompt = result.actionResults.some(
    (item) => item.actionId === "captcha" && item.status === "executed",
  );
  const repeatsPrompt = result.actionResults.some(
    (item) =>
      item.actionId === "captcha" &&
      item.status === "skipped" &&
      item.detail === "duplicate",
  );
  if (!ownsPrompt && !repeatsPrompt) {
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
  let messageId: string | null;
  try {
    messageId = await sendCaptchaButton({
      token: deps.botToken,
      chatId: event.chatId,
      nonce: challenge.nonce,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    });
  } catch {
    if (ownsPrompt) {
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
    }
    logger.warn("captcha_prompt_failed", {
      eventId: event.id,
      chatId: event.chatId,
    });
    return;
  }
  if (messageId === null) {
    return;
  }
  let attached = false;
  try {
    attached = await captchaStore.attachPrompt(
      event.tenantId,
      event.chatId,
      event.actor.id,
      challenge.nonce,
      messageId,
    );
  } catch {
    logger.warn("captcha_prompt_failed", {
      eventId: event.id,
      chatId: event.chatId,
    });
  }
  let dropId: string | undefined;
  if (!attached) {
    dropId = messageId;
  } else if (
    challenge.messageId !== undefined &&
    challenge.messageId !== messageId
  ) {
    dropId = challenge.messageId;
  }
  if (dropId !== undefined) {
    try {
      await moderator.deleteMessage({
        tenantId: event.tenantId,
        chatId: event.chatId,
        messageId: dropId,
      });
    } catch {
      logger.warn("captcha_prompt_delete_failed", {
        eventId: event.id,
        chatId: event.chatId,
      });
    }
  }
}

async function syncChatDirectory(
  event: Event,
  directory: ChatDirectory | undefined,
  logger: Logger,
): Promise<void> {
  if (!directory) {
    return;
  }
  try {
    const result =
      event.kind === "bot_membership"
        ? event.bot
          ? await directory.noteBot({
              tenantId: event.tenantId,
              chatId: event.chatId,
              actorId: event.actor.id,
              state: event.bot,
            })
          : "ok"
        : await directory.noteMember({
            tenantId: event.tenantId,
            chatId: event.chatId,
            actorId: event.actor.id,
            admin: event.actor.isAdmin,
          });
    if (result === "full") {
      logger.warn("chat_directory_full", {
        eventId: event.id,
        chatId: event.chatId,
        tenantId: event.tenantId,
      });
    }
  } catch {
    logger.warn("chat_directory_failed", {
      eventId: event.id,
      chatId: event.chatId,
      tenantId: event.tenantId,
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
