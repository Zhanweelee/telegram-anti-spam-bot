import {
  botSetupNotice,
  type CaptchaStore,
  type ChatDirectory,
  cancelChallenge,
  createSystemClock,
  type Event,
  type Locale,
  type Logger,
  type ModerationPort,
  type Notifier,
  promoteChallenge,
  type ReplyPort,
  type ReviewQueue,
  type RuntimeStore,
  resolveChallenge,
  runOperatorCommand,
  unrestrictChallenge,
  type WarnStore,
} from "@tasb/core";
import { sendCaptchaButton } from "@tasb/platform-telegram";
import { workerBlocklist } from "./blocklist-runtime.js";
import {
  captchaExpiryHooks,
  createCaptchaNonce,
  workerCaptcha,
} from "./captcha-runtime.js";
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
import { workerWarns } from "./warn-runtime.js";

export interface OperateDeps extends ScreenDeps {
  readonly adminActorIds?: readonly string[];
  readonly reply?: ReplyPort;
  readonly locale?: Locale;
  readonly review?: ReviewQueue;
  readonly chats?: ChatDirectory;
  readonly warns?: WarnStore;
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
    async banActorFor() {
      throw new Error("banfor_unavailable");
    },
    async kickActor() {
      throw new Error("kick_unavailable");
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
    async readMemberAllows() {
      throw new Error("allows_unavailable");
    },
    async readMemberAdmin() {
      throw new Error("canadmin_unavailable");
    },
    async readOwnAdmin() {
      throw new Error("cani_unavailable");
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
    async readDefaultRights() {
      throw new Error("botrights_unavailable");
    },
    async readCommandMenu() {
      throw new Error("commands_unavailable");
    },
    async readMenuButton() {
      throw new Error("button_unavailable");
    },
    async readBotName() {
      throw new Error("myname_unavailable");
    },
    async readBotDescription() {
      throw new Error("mydesc_unavailable");
    },
    async readBotShortDescription() {
      throw new Error("myshort_unavailable");
    },
    async readBotIdentity() {
      throw new Error("who_unavailable");
    },
    async readWebhook() {
      throw new Error("hook_unavailable");
    },
    async readChatGuard() {
      throw new Error("guard_unavailable");
    },
    async readJoinBot() {
      throw new Error("joinbot_unavailable");
    },
    async readReactions() {
      throw new Error("reactions_unavailable");
    },
    async readCommunity() {
      throw new Error("community_unavailable");
    },
    async readStickerSetRight() {
      throw new Error("canstickers_unavailable");
    },
    async readParentChat() {
      throw new Error("parent_unavailable");
    },
    async readPersonalChat() {
      throw new Error("personal_unavailable");
    },
    async readPrivatePrivacy() {
      throw new Error("privacy_unavailable");
    },
    async createTopic() {
      throw new Error("newtopic_unavailable");
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
    async setAdminTitle() {
      throw new Error("admintitle_unavailable");
    },
    async deleteStickerSet() {
      throw new Error("delstickers_unavailable");
    },
    async setStickerSet() {
      throw new Error("stickers_unavailable");
    },
    async setReaction() {
      throw new Error("react_unavailable");
    },
    async setTitle() {
      throw new Error("title_unavailable");
    },
    async setDescription() {
      throw new Error("desc_unavailable");
    },
    async renameTopic() {
      throw new Error("rentopic_unavailable");
    },
    async renameGeneral() {
      throw new Error("rengeneral_unavailable");
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
    async deleteCommandMenu() {
      throw new Error("delcommands_unavailable");
    },
    async declineJoin() {
      throw new Error("decline_unavailable");
    },
    async declinePost() {
      throw new Error("declinepost_unavailable");
    },
    async setDefaultRights() {
      throw new Error("myrights_unavailable");
    },
    async setCommandMenu() {
      throw new Error("setcommands_unavailable");
    },
    async setMenuButton() {
      throw new Error("menubutton_unavailable");
    },
    async setBotName() {
      throw new Error("botname_unavailable");
    },
    async setBotDescription() {
      throw new Error("botdesc_unavailable");
    },
    async setBotShortDescription() {
      throw new Error("botshort_unavailable");
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
  const warns = deps.warns ?? workerWarns;
  const blocklist = deps.blocklist ?? workerBlocklist;
  const review = deps.review ?? workerReview;
  const rulePacks = deps.rulePacks ?? workerRulePacks;
  const quota = deps.quota;
  const chats = deps.chats;
  if (event.kind === "bot_membership" || event.kind === "chat_member") {
    await syncChatDirectory(event, chats, logger);
  }
  if (event.kind === "bot_membership") {
    await sendBotSetupNotice(event, deps.reply, deps.locale, logger);
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
          ...captchaExpiryHooks(runtime, moderator),
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
    captcha: captchaStore,
    warns,
    clock: deps.clock ?? createSystemClock(),
    createNonce: deps.createNonce ?? createCaptchaNonce,
    moderator: commandModerator(moderator, deps),
  });
  if (outcome.status === "reply") {
    let text = outcome.text;
    const issued = outcome.issuedChallenge;
    if (issued) {
      const sent = await deliverCaptchaPrompt({
        tenantId: event.tenantId,
        chatId: issued.chatId,
        actorId: issued.actorId,
        eventId: event.id,
        ownsPrompt: true,
        token: deps.botToken,
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        store: captchaStore,
        moderator,
        logger,
      });
      if (!sent) {
        text = outcome.failureText ?? "参数无效";
      }
    }
    await sendReply(event, text, outcome.command, deps.reply, logger);
    return;
  }
  const notifier = await reportDestination({
    event,
    runtime,
    reply: deps.reply,
    notifier: deps.notifier,
    adminActorIds: deps.adminActorIds ?? [],
    logger,
  });
  const result = await screenTelegramEvent(event, {
    logger,
    cache,
    source,
    storage,
    policyStore,
    runtime,
    moderator,
    captchaStore,
    warnStore: warns,
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
  await deliverCaptchaPrompt({
    tenantId: event.tenantId,
    chatId: event.chatId,
    actorId: event.actor.id,
    eventId: event.id,
    ownsPrompt,
    token: deps.botToken,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    store: captchaStore,
    moderator,
    logger,
  });
}

async function deliverCaptchaPrompt(input: {
  readonly tenantId: string;
  readonly chatId: string;
  readonly actorId: string;
  readonly eventId: string;
  readonly ownsPrompt: boolean;
  readonly token: string | undefined;
  readonly fetchImpl?: typeof fetch;
  readonly store: CaptchaStore;
  readonly moderator: ModerationPort;
  readonly logger: Logger;
}): Promise<boolean> {
  const challenge = await input.store.get(
    input.tenantId,
    input.chatId,
    input.actorId,
  );
  if (!challenge) {
    return false;
  }
  let messageId: string | null;
  try {
    messageId = await sendCaptchaButton({
      token: input.token,
      chatId: input.chatId,
      nonce: challenge.nonce,
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    });
  } catch {
    if (input.ownsPrompt) {
      try {
        await input.moderator.releaseActor({
          tenantId: input.tenantId,
          chatId: input.chatId,
          actorId: input.actorId,
        });
        await input.store.delete(input.tenantId, input.chatId, input.actorId);
      } catch {
        input.logger.warn("captcha_prompt_failed", {
          eventId: input.eventId,
          chatId: input.chatId,
        });
        return false;
      }
    }
    input.logger.warn("captcha_prompt_failed", {
      eventId: input.eventId,
      chatId: input.chatId,
    });
    return false;
  }
  if (messageId === null) {
    return true;
  }
  let attached = false;
  try {
    attached = await input.store.attachPrompt(
      input.tenantId,
      input.chatId,
      input.actorId,
      challenge.nonce,
      messageId,
    );
  } catch {
    input.logger.warn("captcha_prompt_failed", {
      eventId: input.eventId,
      chatId: input.chatId,
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
      await input.moderator.deleteMessage({
        tenantId: input.tenantId,
        chatId: input.chatId,
        messageId: dropId,
      });
    } catch {
      input.logger.warn("captcha_prompt_delete_failed", {
        eventId: input.eventId,
        chatId: input.chatId,
      });
    }
  }
  return true;
}

async function sendBotSetupNotice(
  event: Event,
  reply: ReplyPort | undefined,
  locale: Locale | undefined,
  logger: Logger,
): Promise<void> {
  const notice = botSetupNotice(event, locale);
  if (!notice || !reply) {
    return;
  }
  try {
    await reply.send(notice);
  } catch {
    logger.warn("bot_setup_notice_failed", {
      eventId: event.id,
      chatId: event.chatId,
    });
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

async function reportDestination(input: {
  readonly event: Event;
  readonly runtime: RuntimeStore;
  readonly reply: ReplyPort | undefined;
  readonly notifier: Notifier | undefined;
  readonly adminActorIds: readonly string[];
  readonly logger: Logger;
}): Promise<Notifier | undefined> {
  if (input.notifier) {
    return input.notifier;
  }
  if (!input.reply) {
    return undefined;
  }
  const fallback = input.adminActorIds.find((id) => id.length > 0);
  let target: string | null = null;
  try {
    target = await input.runtime.getReportChat(
      input.event.tenantId,
      input.event.chatId,
    );
  } catch {
    input.logger.warn("runtime_failed", {
      eventId: input.event.id,
      chatId: input.event.chatId,
    });
  }
  if (target === input.event.chatId) {
    target = null;
  }
  const destination = target ?? fallback;
  if (!destination) {
    return undefined;
  }
  return adminNotifier(input.reply, destination);
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
